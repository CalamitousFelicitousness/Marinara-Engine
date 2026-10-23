import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bind all module-level paths to disposable storage before importing production code.
const root = mkdtempSync(join(tmpdir(), "marinara-frozen-avatar-cleanup-"));
process.env.DATA_DIR = root;
process.env.FILE_STORAGE_DIR = join(root, "storage");
process.env.MARINARA_ENV_FILE = join(root, ".env");
delete process.env.MARINARA_EAGER_STORAGE;
writeFileSync(process.env.MARINARA_ENV_FILE, "");
const { createFileNativeDB, encodeShardKey } = await import("../../packages/server/src/db/file-backed-store.js");
const { eq } = await import("../../packages/server/src/db/file-query.js");
const { chats, messages, messageSwipes, messageTrash, personas } =
  await import("../../packages/server/src/db/schema/index.js");
const { deleteAbandonedAvatarFiles, scanAbandonedAvatarFiles, unlinkAvatarFilesIfUnreferenced } =
  await import("../../packages/server/src/services/image/avatar-file-lifecycle.js");

const avatarRoot = join(root, "avatars");
mkdirSync(avatarRoot);
const at = new Date().toISOString();
const pathFor = (name: string) => join(avatarRoot, name);
const urlFor = (name: string) => `/api/avatars/file/${encodeURIComponent(name)}?v=frozen`;
const extraFor = (name: string) =>
  JSON.stringify({ personaSnapshot: { name: "Past persona", avatarUrl: urlFor(name) } });
const message = (id: string, chatId: string, extra = "{}") => ({
  id,
  chatId,
  role: "user",
  content: "Frozen identity",
  extra,
  createdAt: at,
});
const shardPath = (table: string, id: string) => join(root, "storage", "tables", table, `${encodeShardKey(id)}.json`);
const writeAvatar = (name: string) => writeFileSync(pathFor(name), name);
for (const name of ["message.png", "swipe.png", "trash-message.png", "trash-swipe.png", "backup.png", "orphan.png"])
  writeAvatar(name);
let db = await createFileNativeDB();
try {
  for (const id of ["message", "swipe", "trash", "backup", "race"]) {
    await db.insert(chats).values({ id, name: id, mode: "conversation", createdAt: at, updatedAt: at });
  }
  await db.insert(messages).values(message("m-message", "message", extraFor("message.png")));
  await db.insert(messages).values(message("m-swipe", "swipe"));
  await db.insert(messageSwipes).values({
    id: "s-history",
    messageId: "m-swipe",
    index: 1,
    content: "Past swipe",
    extra: extraFor("swipe.png"),
    createdAt: at,
  });
  await db.insert(messageTrash).values({
    id: "trash",
    chatId: "trash",
    messageId: "deleted",
    role: "user",
    content: "Deleted",
    messageCreatedAt: at,
    deletedAt: at,
    snapshot: JSON.stringify({
      message: message("deleted", "trash", extraFor("trash-message.png")),
      swipes: [{ id: "deleted-swipe", messageId: "deleted", index: 1, extra: extraFor("trash-swipe.png") }],
    }),
  });
  await db.insert(messages).values(message("m-backup", "backup", extraFor("backup.png")));
  await db._fileStore.close();
  db = await createFileNativeDB();
  const initialResident = [...db._fileStore.getResidentChatUnits()].sort();
  const initialLeased = [...db._fileStore.getFullyResidentLazyTables()].sort();
  const input = { db, avatarRoot, nowMs: Date.now() + 11 * 60_000 };
  assert.deepEqual(
    await scanAbandonedAvatarFiles(input),
    { files: 1, bytes: Buffer.byteLength("orphan.png") },
    "scan must not count frozen current messages, inactive swipes or restorable trash as abandoned",
  );
  assert.deepEqual(await deleteAbandonedAvatarFiles(input), { files: 1, bytes: Buffer.byteLength("orphan.png") });
  assert.equal(existsSync(pathFor("orphan.png")), false, "truly abandoned avatars must still be collected");
  for (const name of ["message.png", "swipe.png", "trash-message.png", "trash-swipe.png", "backup.png"])
    assert.equal(existsSync(pathFor(name)), true, `${name} must survive optimizer cleanup`);
  assert.equal(
    await unlinkAvatarFilesIfUnreferenced({
      db,
      avatarRoot,
      avatarPaths: [urlFor("message.png"), urlFor("swipe.png"), urlFor("trash-swipe.png")],
    }),
    0,
    "direct final-card cleanup must honor the same frozen references",
  );
  assert.deepEqual(
    [...db._fileStore.getResidentChatUnits()].sort(),
    initialResident,
    "cleanup must not load cold chats",
  );
  assert.deepEqual(
    [...db._fileStore.getFullyResidentLazyTables()].sort(),
    initialLeased,
    "cleanup must never lease history tables",
  );

  // A crash can leave only a backup; cleanup must inspect it without repairing storage.
  const backupPath = shardPath("messages", "backup");
  renameSync(backupPath, `${backupPath}.bak`);
  assert.equal(await unlinkAvatarFilesIfUnreferenced({ db, avatarRoot, avatarPaths: [urlFor("backup.png")] }), 0);
  assert.equal(existsSync(backupPath), false, "cleanup must not repair or rewrite a cold shard");
  renameSync(`${backupPath}.bak`, backupPath);

  // Resident memory wins over stale disk in both directions.
  await db.delete(messages).where(eq(messages.id, "m-message"));
  assert.equal(
    await unlinkAvatarFilesIfUnreferenced({ db, avatarRoot, avatarPaths: [urlFor("message.png")] }),
    1,
    "a committed unflushed deletion must not resurrect the old on-disk reference",
  );
  writeAvatar("new.png");
  await db.insert(messages).values(message("m-new", "race", extraFor("new.png")));
  assert.equal(
    await unlinkAvatarFilesIfUnreferenced({ db, avatarRoot, avatarPaths: [urlFor("new.png")] }),
    0,
    "an unflushed identity insertion must preserve its avatar",
  );

  // A temporary deletion in another transaction is not a committed release.
  let transactionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    transactionStarted = resolve;
  });
  let rollback!: () => void;
  const release = new Promise<void>((resolve) => {
    rollback = resolve;
  });
  const transaction = db.transaction(async (tx) => {
    await tx.delete(messages).where(eq(messages.id, "m-new"));
    transactionStarted();
    await release;
    throw new Error("rollback identity deletion");
  });
  const rejectedTransaction = assert.rejects(transaction, /rollback identity deletion/u);
  await started;
  let cleanupSettled = false;
  const cleanup = unlinkAvatarFilesIfUnreferenced({ db, avatarRoot, avatarPaths: [urlFor("new.png")] }).then(
    (count) => {
      cleanupSettled = true;
      return count;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleanupSettled, false, "cleanup waits for committed storage rather than deleting during a transaction");
  rollback();
  await rejectedTransaction;
  assert.equal(await cleanup, 0);
  assert.equal(existsSync(pathFor("new.png")), true, "rollback must retain the committed avatar");

  // Cleanup-only failure must not quarantine a shard or delete even a possible orphan.
  writeAvatar("unknown.png");
  const coldPath = shardPath("message_swipes", "swipe");
  const goodShard = readFileSync(coldPath);
  writeFileSync(coldPath, "{unreadable shard");
  assert.deepEqual(await deleteAbandonedAvatarFiles(input), { files: 0, bytes: 0 });
  assert.equal(await unlinkAvatarFilesIfUnreferenced({ db, avatarRoot, avatarPaths: [urlFor("unknown.png")] }), 0);
  assert.equal(existsSync(pathFor("unknown.png")), true);
  assert.equal(readFileSync(coldPath, "utf8"), "{unreadable shard", "inspection must leave damaged storage untouched");
  writeFileSync(coldPath, goodShard);

  const residentRows = db._fileStore.getResidentLazyRows;
  let historyReads = 0;
  db._fileStore.getResidentLazyRows = () => {
    historyReads++;
    throw new Error("injected cleanup read failure");
  };
  await db.insert(personas).values({
    id: "card-owned",
    name: "Current owner",
    avatarPath: urlFor("unknown.png"),
    createdAt: at,
    updatedAt: at,
  });
  assert.equal(await unlinkAvatarFilesIfUnreferenced({ db, avatarRoot, avatarPaths: [urlFor("unknown.png")] }), 0);
  assert.equal(historyReads, 0, "card-owned files require no expensive history scan");
  await db.delete(personas).where(eq(personas.id, "card-owned"));
  assert.equal(await unlinkAvatarFilesIfUnreferenced({ db, avatarRoot, avatarPaths: [urlFor("unknown.png")] }), 0);
  db._fileStore.getResidentLazyRows = residentRows;
  assert.equal(existsSync(pathFor("unknown.png")), true);

  // Last reference released: preserve retention until trash is actually purged, then collect.
  await db.delete(messageTrash).where(eq(messageTrash.id, "trash"));
  assert.equal(
    await unlinkAvatarFilesIfUnreferenced({
      db,
      avatarRoot,
      avatarPaths: [urlFor("trash-message.png"), urlFor("trash-swipe.png")],
    }),
    2,
  );
  console.info(
    "Frozen identity avatar cleanup regressions passed (cold/resident messages, swipes, trash, backup, rollback, and read failures).",
  );
} finally {
  await db._fileStore.close();
  rmSync(root, { recursive: true, force: true });
}
