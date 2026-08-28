// #5592 Phase 2: chat-scoped tables (messages, swipes, memory chunks, game
// tables, ...) no longer load at boot — each chat's shards enter memory as one
// unit on first touch and stay resident. These regressions drive the REAL
// store through the behaviors that must hold under partial residency:
//   - boot only DISCOVERS lazy shards; an untouched chat's file is never
//     parsed for healing, while first touch runs the full recovery pipeline,
//   - a chatId-scoped query loads exactly that unit (messages AND swipes
//     together), and an unbounded query leases the whole table,
//   - inserting into an unloaded chat loads the unit first, so the flush
//     rewrites the shard with the pre-existing rows intact (the data-loss
//     failure mode the unit design exists to prevent),
//   - deleting a chat cascades into units that were never read and removes
//     their shard files,
//   - a transaction that loads a unit mid-flight keeps those rows across
//     rollback while the rolled-back write reverts,
//   - the manifest reports the harvested messages total, not the resident
//     fraction, and omits the other lazy tables' counts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "../../packages/server/src/db/file-query.js";
import { createFileNativeDB, encodeShardKey } from "../../packages/server/src/db/file-backed-store.js";
import { chats, memoryChunks, messages, messageSwipes } from "../../packages/server/src/db/schema/index.js";

if (process.env.MARINARA_EAGER_STORAGE === "1" || process.env.MARINARA_EAGER_STORAGE === "true") {
  // The kill switch restores eager boot loading; these regressions assert
  // lazy-only semantics (no boot healing, per-unit residency). The sharding
  // suite covers the eager path — run it with the same variable set.
  console.log("Lazy chat-unit regressions skipped: MARINARA_EAGER_STORAGE is set.");
  process.exit(0);
}

function tempStorageDir() {
  const dir = mkdtempSync(join(tmpdir(), "marinara-lazy-units-"));
  process.env.FILE_STORAGE_DIR = dir;
  return dir;
}

let seq = 0;
const messageRow = (id: string, chatId: string, content: string) => ({
  id,
  chatId,
  role: "user",
  content,
  createdAt: `2026-08-28T10:00:${String(seq++).padStart(2, "0")}.000Z`,
});
const swipeRow = (id: string, messageId: string, content: string) => ({ id, messageId, index: 0, content });
const chunkRow = (id: string, chatId: string, content: string) => ({
  id,
  chatId,
  content,
  messageCount: 1,
  createdAt: `2026-08-28T10:00:00.000Z`,
});
const chatRow = (id: string) => ({ id, name: id, mode: "conversation" });

const writeShard = (dir: string, table: string, key: string, rows: unknown[]) => {
  mkdirSync(join(dir, "tables", table), { recursive: true });
  writeFileSync(join(dir, "tables", table, `${encodeShardKey(key)}.json`), JSON.stringify(rows));
};
const readShard = (dir: string, table: string, key: string) =>
  JSON.parse(readFileSync(join(dir, "tables", table, `${encodeShardKey(key)}.json`), "utf8")) as Array<
    Record<string, unknown>
  >;
const shardExists = (dir: string, table: string, key: string) =>
  existsSync(join(dir, "tables", table, `${encodeShardKey(key)}.json`));

// ── Scoped queries load one unit; untouched units stay unparsed on disk ──

{
  const dir = tempStorageDir();
  writeShard(dir, "chats", "chat-a", [chatRow("chat-a")]);
  writeShard(dir, "chats", "chat-b", [chatRow("chat-b")]);
  writeShard(dir, "messages", "chat-a", [messageRow("m-a1", "chat-a", "a one"), messageRow("m-a2", "chat-a", "a two")]);
  // chat-b's file carries a malformed row: eager loading would preserve and
  // heal it at boot; lazy loading must leave the file byte-identical until
  // chat-b is actually touched.
  const bRows = [messageRow("m-b1", "chat-b", "b one"), "malformed-not-a-row"];
  writeShard(dir, "messages", "chat-b", bRows);
  writeShard(dir, "message_swipes", "chat-a", [swipeRow("s-a1", "m-a1", "swipe a")]);
  writeShard(dir, "memory_chunks", "chat-b", [chunkRow("c-b1", "chat-b", "chunk b")]);
  const db = await createFileNativeDB();
  try {
    const aMessages = await db.select().from(messages).where(eq(messages.chatId, "chat-a"));
    assert.deepEqual(
      aMessages.map((row) => row.id),
      ["m-a1", "m-a2"],
      "a chatId-scoped query returns the unit's rows",
    );
    // Swipes load WITH the unit: a parent-mapped query needs no prior read.
    const aSwipes = await db
      .select()
      .from(messageSwipes)
      .where(inArray(messageSwipes.messageId, ["m-a1"]));
    assert.deepEqual(
      aSwipes.map((row) => row.id),
      ["s-a1"],
      "the unit's swipes are resident after the messages query",
    );
    assert.equal(db.count(messages, eq(messages.chatId, "chat-a")), 2, "count() sees the loaded unit");
    await db._fileStore.flush();
    assert.deepEqual(
      readShard(dir, "messages", "chat-b"),
      bRows,
      "an untouched unit's file is byte-identical after another unit's load and flush — no boot healing",
    );
    // First touch of chat-b runs the recovery pipeline: the malformed row is
    // skipped, the source preserved, and the shard heals on the next flush.
    const bMessages = await db.select().from(messages).where(eq(messages.chatId, "chat-b"));
    assert.deepEqual(
      bMessages.map((row) => row.id),
      ["m-b1"],
      "first touch loads the unit and skips the malformed row",
    );
    await db._fileStore.flush();
    assert.deepEqual(
      readShard(dir, "messages", "chat-b").map((row) => row.id),
      ["m-b1"],
      "the malformed row is healed away on the first flush after the unit loads",
    );
    const chunks = await db.select().from(memoryChunks).where(eq(memoryChunks.chatId, "chat-b"));
    assert.deepEqual(
      chunks.map((row) => row.id),
      ["c-b1"],
      "every lazy table's shard for the unit is reachable",
    );
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Writing into an unloaded unit loads it first — no sibling data loss ──

{
  const dir = tempStorageDir();
  writeShard(dir, "chats", "chat-c", [chatRow("chat-c")]);
  writeShard(dir, "messages", "chat-c", [
    messageRow("m-c1", "chat-c", "old one"),
    messageRow("m-c2", "chat-c", "old two"),
  ]);
  const db = await createFileNativeDB();
  try {
    // No read first: the insert itself must make the unit resident, or the
    // flush below would rewrite chat-c.json with ONLY the new row.
    await db.insert(messages).values(messageRow("m-c3", "chat-c", "new"));
    await db._fileStore.flush();
    assert.deepEqual(
      readShard(dir, "messages", "chat-c").map((row) => row.id),
      ["m-c1", "m-c2", "m-c3"],
      "the shard keeps its pre-existing rows after a cold insert",
    );
    // Same for update-by-scope on a cold unit.
    await db.update(messages).set({ content: "edited" }).where(eq(messages.id, "m-c1"));
    const edited = await db.select().from(messages).where(eq(messages.id, "m-c1"));
    assert.equal(edited[0]!.content, "edited", "a PK-addressed update reaches a row loaded via the messages index");
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Unbounded queries lease the whole table ──

{
  const dir = tempStorageDir();
  writeShard(dir, "chats", "chat-a", [chatRow("chat-a")]);
  writeShard(dir, "chats", "chat-b", [chatRow("chat-b")]);
  writeShard(dir, "messages", "chat-a", [messageRow("m-a1", "chat-a", "a")]);
  writeShard(dir, "messages", "chat-b", [messageRow("m-b1", "chat-b", "b")]);
  const db = await createFileNativeDB();
  try {
    const all = await db.select().from(messages);
    assert.deepEqual(
      all.map((row) => row.id).sort(),
      ["m-a1", "m-b1"],
      "a select with no WHERE returns every unit's rows",
    );
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Deleting a chat cascades into units that were never read ──

{
  const dir = tempStorageDir();
  writeShard(dir, "chats", "chat-d", [chatRow("chat-d")]);
  writeShard(dir, "messages", "chat-d", [messageRow("m-d1", "chat-d", "doomed")]);
  writeShard(dir, "message_swipes", "chat-d", [swipeRow("s-d1", "m-d1", "doomed swipe")]);
  writeShard(dir, "memory_chunks", "chat-d", [chunkRow("c-d1", "chat-d", "doomed chunk")]);
  const db = await createFileNativeDB();
  try {
    await db.delete(chats).where(eq(chats.id, "chat-d"));
    await db._fileStore.flush();
    for (const table of ["messages", "message_swipes", "memory_chunks"]) {
      assert.equal(shardExists(dir, table, "chat-d"), false, `${table} shard files of a deleted chat are removed`);
    }
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── A unit loaded mid-transaction survives rollback; the write does not ──

{
  const dir = tempStorageDir();
  writeShard(dir, "chats", "chat-e", [chatRow("chat-e")]);
  writeShard(dir, "messages", "chat-e", [messageRow("m-e1", "chat-e", "original")]);
  const db = await createFileNativeDB();
  try {
    await assert.rejects(
      db.transaction(async (tx) => {
        // The update's scope hook loads chat-e INSIDE the transaction.
        await tx.update(messages).set({ content: "rolled back" }).where(eq(messages.chatId, "chat-e"));
        throw new Error("force rollback");
      }),
      /force rollback/,
    );
    const rows = await db.select().from(messages).where(eq(messages.chatId, "chat-e"));
    assert.equal(rows.length, 1, "the mid-transaction unit load survives the rollback");
    assert.equal(rows[0]!.content, "original", "the rolled-back write reverts");
    await db._fileStore.flush();
    assert.deepEqual(
      readShard(dir, "messages", "chat-e").map((row) => row.content),
      ["original"],
      "disk keeps the original row after rollback",
    );
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── A unit loaded DURING a flush keeps its shard file until the next flush ──
// The stale-file cleanup pass unlinks shard files whose rows were re-homed.
// Its marks must be captured atomically with the dirty keys at flush start:
// reading the live map let a lazy unit load — running inside the flush's own
// awaited writes — add a mark whose paired dirty keys the flush never saw,
// and the cleanup then deleted the freshly loaded shard (and .bak) while its
// rows existed only in memory. Setup: two chats whose swipe files each hold
// one ORPHAN swipe (parent message gone), i.e. files the store re-homes into
// the unassigned shard — the exact state that creates stale marks.

{
  const dir = tempStorageDir();
  writeShard(dir, "chats", "chat-x", [chatRow("chat-x")]);
  writeShard(dir, "chats", "chat-a", [chatRow("chat-a")]);
  writeShard(dir, "message_swipes", "chat-x", [swipeRow("s-x", "m-ghost-x", "orphan x")]);
  writeShard(dir, "message_swipes", "chat-a", [swipeRow("s-a", "m-ghost-a", "orphan a")]);
  let loadDuringFlush: (() => Promise<void>) | null = null;
  const db = await createFileNativeDB({
    beforeTableWrite: async (name: string) => {
      if (name.startsWith("message_swipes/") && loadDuringFlush) {
        const load = loadDuringFlush;
        loadDuringFlush = null;
        await load();
      }
    },
  });
  try {
    // First touch of chat-x re-homes its orphan swipe: stale mark + dirty
    // keys for the unassigned shard now exist BEFORE the flush.
    await db.select().from(messages).where(eq(messages.chatId, "chat-x"));
    // During that flush's swipe-shard write, chat-a loads mid-flight.
    loadDuringFlush = async () => {
      await db.select().from(messages).where(eq(messages.chatId, "chat-a"));
    };
    await db._fileStore.flush(true, true);
    assert.equal(
      shardExists(dir, "message_swipes", "chat-a"),
      true,
      "a shard loaded mid-flush is NOT unlinked by that flush — its rows exist only in memory until the next one",
    );
    // The deferred mark processes correctly on the next flush: the orphan
    // lands in the unassigned shard and the old file is then removed.
    await db._fileStore.flush(true, true);
    assert.equal(
      shardExists(dir, "message_swipes", "chat-a"),
      false,
      "the deferred stale file heals on the next flush",
    );
    assert.deepEqual(
      readShard(dir, "message_swipes", "orphaned-rows")
        .map((row) => row.id)
        .sort(),
      ["s-a", "s-x"],
      "both orphan swipes are on disk in the unassigned shard",
    );
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Manifest: messages reports the harvested total; other lazy counts are omitted ──

{
  const dir = tempStorageDir();
  writeShard(dir, "chats", "chat-a", [chatRow("chat-a")]);
  writeShard(dir, "chats", "chat-b", [chatRow("chat-b")]);
  writeShard(dir, "messages", "chat-a", [messageRow("m-a1", "chat-a", "a")]);
  writeShard(dir, "messages", "chat-b", [messageRow("m-b1", "chat-b", "b"), messageRow("m-b2", "chat-b", "bb")]);
  writeShard(dir, "memory_chunks", "chat-a", [chunkRow("c-a1", "chat-a", "chunk")]);
  const db = await createFileNativeDB();
  try {
    // Load only chat-a, then flush: the manifest must not report the resident
    // fraction as the table total.
    await db.select().from(messages).where(eq(messages.chatId, "chat-a"));
    await db._fileStore.flush(true);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
      tables: Record<string, number | undefined>;
    };
    assert.equal(manifest.tables.messages, 3, "messages reports the complete harvested count");
    assert.equal(
      Object.prototype.hasOwnProperty.call(manifest.tables, "memory_chunks"),
      false,
      "a partially resident lazy table has no manifest count",
    );
  } finally {
    await db._fileStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("Lazy chat-unit regressions passed.");
