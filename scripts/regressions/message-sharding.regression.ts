// #4708: messages and message_swipes persist as one file per chat instead of
// a monolith that re-serialized every chat's history on every saved message.
// These regressions drive the REAL store through the lifecycle:
//   - fresh installs write shards, never a monolith,
//   - a flush after one chat's message touches ONLY that chat's files,
//   - the one-way migration (monolith -> shards) preserves every row, sends
//     orphan swipes to the reserved unassigned shard, renames the monolith
//     AND its .bak to .pre-shard (the automatic backup), and removes its
//     sentinel,
//   - a crashed migration retries from the untouched monolith,
//   - a downgrade-recreated monolith is quarantined, never merged,
//   - data written by a newer storage format refuses to load,
//   - transaction rollback restores shard dirtiness and the write-generation
//     contract stays keyed on the bare table name,
//   - deleting a chat removes its shard files instead of leaving litter,
//   - shard filenames are a security boundary against crafted chat ids.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "../../packages/server/src/db/file-query.js";
import {
  createFileNativeDB,
  encodeShardKey,
  StorageFormatTooNewError,
} from "../../packages/server/src/db/file-backed-store.js";
import { chats, messages, messageSwipes } from "../../packages/server/src/db/schema/index.js";

function tempStorageDir() {
  const dir = mkdtempSync(join(tmpdir(), "marinara-shards-"));
  process.env.FILE_STORAGE_DIR = dir;
  return dir;
}

let messageRowSeq = 0;
const messageRow = (id: string, chatId: string, content: string) => ({
  id,
  chatId,
  role: "user",
  content,
  // Monotonic, valid ISO timestamps: the shard loader sorts on createdAt,
  // so the fixture must produce a real chronological order.
  createdAt: `2026-08-08T10:00:${String(messageRowSeq++).padStart(2, "0")}.000Z`,
});

// ── Shard filename encoding is a security boundary ──

assert.equal(encodeShardKey("abc-def-123"), "abc-def-123", "lowercase ids stay readable");
assert.equal(encodeShardKey("abc_DEF"), "abc%5F%44%45%46", "underscores AND uppercase are encoded");
assert.notEqual(
  encodeShardKey("Chat-A"),
  encodeShardKey("chat-a"),
  "case-variant ids never share a filename — NTFS/APFS are case-insensitive and a collision silently clobbers a chat",
);
assert.ok(!encodeShardKey("../../../etc/passwd").includes("/"), "path separators never survive encoding");
assert.ok(!encodeShardKey("..\\..\\evil").includes("\\"), "backslashes never survive encoding");
assert.equal(encodeShardKey("orphaned-rows"), "orphaned-rows", "the orphan shard key encodes to itself (readable file)");
assert.match(encodeShardKey("x".repeat(500)), /^%h[0-9a-f]{32}$/, "overlong keys fall back to a hash form");
assert.match(encodeShardKey("con"), /^%h[0-9a-f]{32}$/, "Windows reserved basenames fall back to a hash form");
assert.equal(
  encodeShardKey("nanoid-Like_id"),
  "nanoid-%4Cike%5Fid",
  "nanoid-style ids encode to a stable, pinned filename",
);

// ── Fresh install: shards, never a monolith ──

{
  const dir = tempStorageDir();
  const writes: string[] = [];
  const db = await createFileNativeDB({ beforeTableWrite: (table) => void writes.push(table) });
  try {
    await db.insert(chats).values({ id: "chat-a", name: "A", mode: "conversation" });
    await db.insert(chats).values({ id: "chat-b", name: "B", mode: "conversation" });
    await db.insert(messages).values(messageRow("m-a1", "chat-a", "hello a"));
    await db.insert(messages).values(messageRow("m-b1", "chat-b", "hello b"));
    await db.insert(messageSwipes).values({ id: "s-a1", messageId: "m-a1", index: 0, content: "swipe" });
    await db._fileStore.flush();

    assert.equal(existsSync(join(dir, "tables", "messages.json")), false, "no messages monolith is ever created");
    const aShard = join(dir, "tables", "messages", `${encodeShardKey("chat-a")}.json`);
    const bShard = join(dir, "tables", "messages", `${encodeShardKey("chat-b")}.json`);
    assert.ok(existsSync(aShard) && existsSync(bShard), "each chat owns a message shard file");
    assert.equal(JSON.parse(readFileSync(aShard, "utf8"))[0].content, "hello a");
    const swipeShard = join(dir, "tables", "message_swipes", `${encodeShardKey("chat-a")}.json`);
    assert.ok(existsSync(swipeShard), "swipes shard beside their parent chat");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.version, 3, "the manifest records storage format 3");
    assert.equal(manifest.tables.messages, 2, "logical row counts still cover sharded tables");
    assert.equal(manifest.shards.messages, 2, "shard diagnostics record the file count");

    // ── Flush granularity: one chat's message touches only its own files ──
    writes.length = 0;
    await db.insert(messages).values(messageRow("m-a2", "chat-a", "again a"));
    await db._fileStore.flush();
    const shardWrites = writes.filter((t) => t.startsWith("messages/"));
    assert.deepEqual(
      shardWrites,
      [`messages/${encodeShardKey("chat-a")}`],
      "a saved message rewrites ONLY that chat's shard — the #4708 core claim",
    );
    assert.ok(
      !writes.some((t) => t.includes(encodeShardKey("chat-b"))),
      "the other chat's files are untouched",
    );

    // ── Write-generation contract stays keyed on the bare table name ──
    const genBefore = db._fileStore.getTableWriteGeneration("messages");
    await db.insert(messages).values(messageRow("m-a3", "chat-a", "gen"));
    assert.ok(
      db._fileStore.getTableWriteGeneration("messages") > genBefore,
      "shard writes bump the logical table generation (#4705 contract)",
    );

    // ── Rollback restores shard dirtiness and the shard index ──
    await db._fileStore.flush();
    writes.length = 0;
    await db
      .transaction(async (tx) => {
        await tx.insert(messages).values(messageRow("m-a4", "chat-a", "doomed"));
        throw new Error("force rollback");
      })
      .catch(() => {});
    await db._fileStore.flush();
    assert.equal(
      writes.filter((t) => t.startsWith("messages/")).length,
      0,
      "a rolled-back message leaves no shard dirty",
    );
    const rows = await db.select().from(messages).where(eq(messages.chatId, "chat-a"));
    assert.equal(rows.length, 3, "rolled-back row is gone from memory too");

    // ── Chat delete removes the shard files entirely ──
    await db.delete(chats).where(eq(chats.id, "chat-b"));
    await db._fileStore.flush();
    assert.equal(existsSync(bShard), false, "a deleted chat's message shard is removed, not emptied");
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Migration: monolith -> shards, rename set, orphan swipes ──

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables"), { recursive: true });
  const monolith = [messageRow("m-1", "chat-x", "one"), messageRow("m-2", "chat-y", "two")];
  writeFileSync(join(dir, "tables", "messages.json"), JSON.stringify(monolith));
  writeFileSync(join(dir, "tables", "messages.json.bak"), JSON.stringify(monolith));
  writeFileSync(
    join(dir, "tables", "message_swipes.json"),
    JSON.stringify([
      { id: "s-1", messageId: "m-1", index: 0, content: "swipe one" },
      { id: "s-orphan", messageId: "m-gone", index: 0, content: "orphan" },
    ]),
  );
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ version: 2, savedAt: "2026-08-08T00:00:00.000Z", backend: "file-native", tables: {} }),
  );

  const db = await createFileNativeDB();
  try {
    const migrated = await db.select().from(messages);
    assert.equal(migrated.length, 2, "every monolith row survives the migration");
    assert.ok(
      existsSync(join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json`)),
      "per-chat shards exist after migration",
    );
    assert.ok(existsSync(join(dir, "tables", "messages.json.pre-shard")), "the monolith is renamed, not deleted");
    assert.ok(
      existsSync(join(dir, "tables", "messages.json.bak.pre-shard")),
      "the .bak is renamed too — a leftover .bak would let a downgraded build resurrect stale history",
    );
    assert.equal(existsSync(join(dir, "tables", "messages.json")), false, "no monolith remains under its old name");
    assert.equal(
      existsSync(join(dir, "tables", "messages", ".migrating")),
      false,
      "the migration sentinel is removed on success",
    );
    const orphanShard = join(dir, "tables", "message_swipes", "orphaned-rows.json");
    assert.ok(existsSync(orphanShard), "orphan swipes land in the reserved shard instead of vanishing");
    assert.equal(JSON.parse(readFileSync(orphanShard, "utf8"))[0].id, "s-orphan");
    const swipes = await db.select().from(messageSwipes);
    assert.equal(swipes.length, 2, "orphan swipes still load");
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Crashed migration: sentinel present -> retry from the monolith ──

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  writeFileSync(join(dir, "tables", "messages.json"), JSON.stringify([messageRow("m-1", "chat-x", "authoritative")]));
  // A partial, WRONG shard from the crashed attempt plus the sentinel.
  writeFileSync(join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json`), JSON.stringify([]));
  writeFileSync(join(dir, "tables", "messages", ".migrating"), "2026-08-08T00:00:00.000Z");

  const db = await createFileNativeDB();
  try {
    const rows = await db.select().from(messages);
    assert.equal(rows.length, 1, "the retry migrates from the untouched monolith");
    assert.equal(rows[0]!.content, "authoritative", "the partial crashed shards were discarded");
    assert.ok(existsSync(join(dir, "tables", "messages.json.pre-shard")), "the retried migration completes");
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Downgrade artifact: monolith beside shards, no sentinel -> quarantine ──

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  writeFileSync(
    join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json`),
    JSON.stringify([messageRow("m-1", "chat-x", "sharded truth")]),
  );
  // A monolith recreated by a pre-shard build during a downgrade session.
  writeFileSync(join(dir, "tables", "messages.json"), JSON.stringify([messageRow("m-9", "chat-x", "forked")]));

  const db = await createFileNativeDB();
  try {
    const rows = await db.select().from(messages);
    assert.equal(rows.length, 1, "the forked monolith is never merged");
    assert.equal(rows[0]!.content, "sharded truth", "the shards are authoritative");
    const artifacts = readdirSync(join(dir, "tables")).filter((name) => name.includes(".post-downgrade-"));
    assert.ok(artifacts.length > 0, "the conflicting monolith is quarantined under a timestamped name");
    const quarantined = db._fileStore.getQuarantinedTables();
    assert.ok(
      quarantined.some((entry) => entry.table === "messages"),
      "the quarantine surface reports the conflict",
    );
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Newer storage format refuses to load ──

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables"), { recursive: true });
  writeFileSync(join(dir, "tables", "messages.json"), JSON.stringify([messageRow("m-1", "chat-x", "untouchable")]));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ version: 99, savedAt: "2026-08-08T00:00:00.000Z", backend: "file-native", tables: {} }),
  );
  await assert.rejects(
    createFileNativeDB(),
    (error: unknown) => error instanceof StorageFormatTooNewError,
    "data from a newer format must refuse to load instead of being misread",
  );
  try {
    // The refusal must precede EVERY migration side effect: a directory this
    // build cannot read must not be mutated by it either.
    assert.ok(existsSync(join(dir, "tables", "messages.json")), "the refused startup leaves the monolith untouched");
    assert.equal(existsSync(join(dir, "tables", "messages.json.pre-shard")), false, "no pre-shard rename happened");
    assert.equal(existsSync(join(dir, "tables", "messages")), false, "no shard directory was created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Crash between mkdir and the sentinel write: monolith must NOT be quarantined ──

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true }); // empty shard dir, no sentinel
  writeFileSync(join(dir, "tables", "messages.json"), JSON.stringify([messageRow("m-1", "chat-x", "survivor")]));
  const db = await createFileNativeDB();
  try {
    const rows = await db.select().from(messages);
    assert.equal(rows.length, 1, "an EMPTY shard dir beside a monolith is a crashed migration, not a downgrade");
    assert.equal(rows[0]!.content, "survivor", "the monolith is migrated, never quarantined in favor of nothing");
    assert.ok(existsSync(join(dir, "tables", "messages.json.pre-shard")), "migration completed on the retry");
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Crash between the two renames: retry must use the FRESH primary ──

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  // .bak renamed first (new order), crash before the primary rename: fresh
  // primary + complete shards + sentinel still present.
  writeFileSync(join(dir, "tables", "messages.json"), JSON.stringify([messageRow("m-1", "chat-x", "fresh")]));
  writeFileSync(join(dir, "tables", "messages.json.bak.pre-shard"), JSON.stringify([messageRow("m-0", "chat-x", "stale")]));
  writeFileSync(
    join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json`),
    JSON.stringify([messageRow("m-1", "chat-x", "fresh")]),
  );
  writeFileSync(join(dir, "tables", "messages", ".migrating"), "ts");
  const db = await createFileNativeDB();
  try {
    const rows = await db.select().from(messages);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.content, "fresh", "the retry migrates from the fresh primary, never the stale .bak");
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Duplicate rows across shards are dropped on load and healed on flush ──

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  const dupRow = messageRow("m-dup", "chat-x", "original");
  writeFileSync(join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json`), JSON.stringify([dupRow]));
  writeFileSync(
    join(dir, "tables", "messages", `${encodeShardKey("chat-y")}.json`),
    JSON.stringify([{ ...dupRow, chatId: "chat-y", content: "stale copy" }]),
  );
  const db = await createFileNativeDB();
  try {
    const rows = await db.select().from(messages);
    assert.equal(rows.length, 1, "duplicate primary keys across shards never survive into memory");
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── A shard with ONLY malformed rows is quarantined, not kept as a zombie ──

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  const shardPath = join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json`);
  writeFileSync(shardPath, JSON.stringify(["not-a-row", 42]));
  const db = await createFileNativeDB();
  try {
    const rows = await db.select().from(messages);
    assert.equal(rows.length, 0, "malformed rows never load");
    assert.equal(existsSync(shardPath), false, "the all-malformed shard file is removed from the shard dir");
    const quarantined = readdirSync(join(dir, "tables", "messages")).filter((name) => name.includes(".corrupt-"));
    assert.equal(quarantined.length, 1, "the file is preserved under a .corrupt- name for manual recovery");
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Self-heal dirties EVERY shard key found in a recovered file ──

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  // chat-x's shard carries one malformed row plus a row that belongs to
  // chat-y; chat-y's own file exists and is clean, so it is already "known"
  // and only a dirty key can force its rewrite.
  writeFileSync(
    join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json`),
    JSON.stringify(["malformed", messageRow("m-x1", "chat-x", "x"), messageRow("m-y2", "chat-y", "displaced")]),
  );
  const yPath = join(dir, "tables", "messages", `${encodeShardKey("chat-y")}.json`);
  writeFileSync(yPath, JSON.stringify([messageRow("m-y1", "chat-y", "resident")]));
  const db = await createFileNativeDB();
  try {
    await db._fileStore.flush();
    const yRows = JSON.parse(readFileSync(yPath, "utf8")) as Array<{ id: string }>;
    assert.deepEqual(
      yRows.map((row) => row.id).sort(),
      ["m-y1", "m-y2"],
      "healing a mixed recovered file rewrites EVERY shard its rows map to, not just the first row's",
    );
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── A misplaced physical shard file is rewritten canonically, not kept forever ──
// Logical-key dirtying alone never touches a file whose rows belong to OTHER
// shards (hand-edits, stray re-home copies): the flush writes the rows' real
// shards and skips the physical file, reintroducing its stray rows on every
// startup.

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  // chat-x.json holds ONLY a chat-y row: the file must be deleted and the row
  // must land in chat-y.json.
  writeFileSync(
    join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json`),
    JSON.stringify([messageRow("m-y1", "chat-y", "misplaced")]),
  );
  const db = await createFileNativeDB();
  try {
    const yRows = JSON.parse(
      readFileSync(join(dir, "tables", "messages", `${encodeShardKey("chat-y")}.json`), "utf8"),
    ) as Array<{ id: string }>;
    assert.deepEqual(yRows.map((row) => row.id), ["m-y1"], "the misplaced row lands in its real shard");
    assert.equal(
      existsSync(join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json`)),
      false,
      "the physical file that held only foreign rows is deleted, not reloaded forever",
    );
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  // chat-x.json holds a real chat-x row PLUS a stray copy of chat-y's row:
  // the file must be rewritten without the stray, while chat-y.json keeps its
  // own copy — the stray must not reappear on the next load.
  const yRow = messageRow("m-y1", "chat-y", "resident");
  writeFileSync(
    join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json`),
    JSON.stringify([messageRow("m-x1", "chat-x", "real"), { ...yRow, content: "stray copy" }]),
  );
  writeFileSync(join(dir, "tables", "messages", `${encodeShardKey("chat-y")}.json`), JSON.stringify([yRow]));
  const db = await createFileNativeDB();
  try {
    const rows = await db.select().from(messages);
    assert.equal(rows.length, 2, "the stray duplicate never reaches memory");
    const xRows = JSON.parse(
      readFileSync(join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json`), "utf8"),
    ) as Array<{ id: string }>;
    assert.deepEqual(xRows.map((row) => row.id), ["m-x1"], "the mixed file is rewritten canonically without the stray copy");
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Inserting a parent message adopts its orphan swipes' shard files ──
// Orphan swipes live in the unassigned shard. When their message is later
// INSERTED, they silently regroup into the chat's shard at flush time — both
// swipe files must be rewritten, or the unassigned file keeps a stale copy
// that duplicates on the next load.

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  mkdirSync(join(dir, "tables", "message_swipes"), { recursive: true });
  writeFileSync(
    join(dir, "tables", "message_swipes", "orphaned-rows.json"),
    JSON.stringify([{ id: "s-1", messageId: "m-1", index: 0, content: "orphan swipe" }]),
  );
  const db = await createFileNativeDB();
  try {
    await db.insert(chats).values({ id: "chat-a", name: "A", mode: "conversation" });
    await db.insert(messages).values(messageRow("m-1", "chat-a", "parent arrives"));
    await db._fileStore.flush();
    const swipes = JSON.parse(
      readFileSync(join(dir, "tables", "message_swipes", `${encodeShardKey("chat-a")}.json`), "utf8"),
    ) as Array<{ id: string }>;
    assert.deepEqual(swipes.map((row) => row.id), ["s-1"], "the orphan swipe lands in the adopting chat's shard");
    assert.equal(
      existsSync(join(dir, "tables", "message_swipes", "orphaned-rows.json")),
      false,
      "the unassigned shard file is rewritten away, not left holding a stale copy",
    );
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Rollback restores the orphan-swipe markers ──
// A rolled-back parent insert consumes the orphan marker inside the
// transaction; without rebuilding it on rollback, the REAL insert afterwards
// would no longer dirty the unassigned swipe shard.

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  mkdirSync(join(dir, "tables", "message_swipes"), { recursive: true });
  writeFileSync(
    join(dir, "tables", "message_swipes", "orphaned-rows.json"),
    JSON.stringify([{ id: "s-1", messageId: "m-1", index: 0, content: "orphan swipe" }]),
  );
  const db = await createFileNativeDB();
  try {
    await db.insert(chats).values({ id: "chat-a", name: "A", mode: "conversation" });
    // assert.rejects on the DELIBERATE error: a transaction that failed
    // before inserting m-1 would leave the marker untouched and pass this
    // test without exercising the restoration at all.
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.insert(messages).values(messageRow("m-1", "chat-a", "rolled back"));
        throw new Error("force rollback");
      }),
      /force rollback/,
    );
    await db.insert(messages).values(messageRow("m-1", "chat-a", "real parent"));
    await db._fileStore.flush();
    const swipes = JSON.parse(
      readFileSync(join(dir, "tables", "message_swipes", `${encodeShardKey("chat-a")}.json`), "utf8"),
    ) as Array<{ id: string }>;
    assert.deepEqual(swipes.map((row) => row.id), ["s-1"], "adoption still works after a rolled-back attempt");
    assert.equal(
      existsSync(join(dir, "tables", "message_swipes", "orphaned-rows.json")),
      false,
      "the unassigned shard file is still rewritten away after the rollback consumed and restored the marker",
    );
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── A stale manifest version is rewritten on the next boot ──
// Crash window: migration completed but the first flush never ran, leaving
// sharded data under a version-2 manifest. The downgrade guard (#4708 PR 2)
// trusts manifest.version, so the store must heal it on the next startup —
// not wait for the next data write.

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  writeFileSync(
    join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json`),
    JSON.stringify([messageRow("m-1", "chat-x", "sharded")]),
  );
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ version: 2, savedAt: "2026-08-08T00:00:00.000Z", backend: "file-native", tables: {} }),
  );
  const db = await createFileNativeDB();
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version: number };
    assert.equal(manifest.version, 3, "a lagging manifest version is healed by the startup flush");
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── A MISSING manifest is recreated on the next boot ──
// The downgrade guard reads manifest.version; sharded data with no manifest
// at all would give it nothing to check.

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  writeFileSync(
    join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json`),
    JSON.stringify([messageRow("m-1", "chat-x", "sharded")]),
  );
  const db = await createFileNativeDB();
  try {
    assert.ok(existsSync(join(dir, "manifest.json")), "a boot over manifest-less table data recreates the manifest");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { version: number };
    assert.equal(manifest.version, 3, "the recreated manifest carries the current storage version");
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── A crashed-migration retry never deletes quarantine artifacts ──
// The retry clears incomplete shard files, but .corrupt-* files are
// user-recovery data the store must never delete on its own.

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  writeFileSync(join(dir, "tables", "messages.json"), JSON.stringify([messageRow("m-1", "chat-x", "monolith")]));
  writeFileSync(join(dir, "tables", "messages", ".migrating"), "2026-08-08T00:00:00.000Z");
  writeFileSync(join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json`), JSON.stringify([]));
  const quarantinedPath = join(dir, "tables", "messages", "chat-old.json.corrupt-2026-08-01T00-00-00-000Z");
  writeFileSync(quarantinedPath, "preserved recovery bytes");
  const db = await createFileNativeDB();
  try {
    const rows = await db.select().from(messages);
    assert.equal(rows.length, 1, "the retry migrates from the monolith");
    assert.ok(existsSync(quarantinedPath), "quarantined .corrupt files survive the migration retry");
    assert.equal(
      existsSync(join(dir, "tables", "messages", ".migrating")),
      false,
      "the sentinel is gone after the completed retry",
    );
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Duplicate ids: the canonical shard's copy beats a stale foreign copy ──
// With identical sort keys, keep-first would let discovery order decide — a
// stale foreign copy could win and self-healing would then overwrite the
// canonical row with it.

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  const canonical = messageRow("m-dup", "chat-b", "canonical content");
  // The foreign copy shares id AND createdAt, and lives in chat-a.json —
  // which sorts and loads FIRST, so keep-first would pick it.
  writeFileSync(
    join(dir, "tables", "messages", `${encodeShardKey("chat-a")}.json`),
    JSON.stringify([{ ...canonical, content: "stale foreign copy" }]),
  );
  writeFileSync(join(dir, "tables", "messages", `${encodeShardKey("chat-b")}.json`), JSON.stringify([canonical]));
  const db = await createFileNativeDB();
  try {
    const rows = await db.select().from(messages);
    assert.equal(rows.length, 1, "one copy survives");
    assert.equal(rows[0]!.content, "canonical content", "the canonical shard's copy wins, not discovery order");
    const bRows = JSON.parse(
      readFileSync(join(dir, "tables", "messages", `${encodeShardKey("chat-b")}.json`), "utf8"),
    ) as Array<{ content: string }>;
    assert.equal(bRows[0]!.content, "canonical content", "self-healing never replaces the canonical row with the stale copy");
    assert.equal(
      existsSync(join(dir, "tables", "messages", `${encodeShardKey("chat-a")}.json`)),
      false,
      "the foreign file holding the stale copy is cleaned up",
    );
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── A quarantined bak-only shard leaves no phantom manifest entry ──

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  writeFileSync(join(dir, "tables", "messages", `${encodeShardKey("chat-x")}.json.bak`), "{corrupt");
  const db = await createFileNativeDB();
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      shards: Record<string, number>;
    };
    assert.equal(manifest.shards.messages, 0, "an unreadable bak-only shard is quarantined, never counted as known");
    const quarantined = readdirSync(join(dir, "tables", "messages")).filter((name) => name.includes(".corrupt-"));
    assert.equal(quarantined.length, 1, "the unreadable backup is preserved for manual recovery");
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Bak-only shard: primary vanished in a crash, .bak survives ──

{
  const dir = tempStorageDir();
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  const encoded = encodeShardKey("chat-x");
  writeFileSync(
    join(dir, "tables", "messages", `${encoded}.json.bak`),
    JSON.stringify([messageRow("m-1", "chat-x", "from bak")]),
  );
  const db = await createFileNativeDB();
  try {
    const rows = await db.select().from(messages);
    assert.equal(rows.length, 1, "a bak-only shard is discovered and recovered (readdir lists no primary)");
    assert.equal(rows[0]!.content, "from bak");
    await db._fileStore.flush();
    assert.ok(
      existsSync(join(dir, "tables", "messages", `${encoded}.json`)),
      "self-heal rewrites the missing primary on the next flush",
    );
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.info("Message sharding regressions passed.");
