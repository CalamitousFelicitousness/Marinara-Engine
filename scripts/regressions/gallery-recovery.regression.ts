// #5612: the boot-time gallery recovery scan must not defeat lazy chat-unit
// residency. Its per-chat chat_images queries were individually scoped, but a
// scoped query still loads that chat's ENTIRE storage unit — so on installs
// where most chats have images, boot walked nearly every unit into memory and
// silently reproduced the eager boot #5592 removed. The fixed scan peeks the
// chat_images shard file straight off disk for non-resident units (a
// non-resident unit can hold no unflushed writes, so the file is the current
// state) and only loads a unit when it actually has to: an orphaned file to
// re-register, or a shard the peek cannot trust.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "../../packages/server/src/db/file-query.js";
import { createFileNativeDB, encodeShardKey } from "../../packages/server/src/db/file-backed-store.js";
import { chatImages } from "../../packages/server/src/db/schema/index.js";
import { recoverGalleryImages } from "../../packages/server/src/services/storage/gallery-recovery.js";

if (process.env.MARINARA_EAGER_STORAGE === "1" || process.env.MARINARA_EAGER_STORAGE === "true") {
  // Under the kill switch chat_images is fully resident from boot and the scan
  // keeps its original whole-table behavior; these regressions assert the
  // lazy-mode peek semantics.
  console.log("Gallery-recovery regressions skipped: MARINARA_EAGER_STORAGE is set.");
  process.exit(0);
}

// One environment for every block: a data dir (holding gallery/) and a storage
// dir, torn down together. Each block uses distinct chat ids.
const dataDir = mkdtempSync(join(tmpdir(), "marinara-gallery-recovery-"));
const storeDir = join(dataDir, "storage");
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = storeDir;

const chatRow = (id: string) => ({ id, name: id, mode: "conversation" });
const imageRow = (id: string, chatId: string, filePath: string) => ({
  id,
  chatId,
  filePath,
  prompt: "",
  provider: "",
  model: "",
  width: null,
  height: null,
  createdAt: "2026-08-28T10:00:00.000Z",
});
const messageRow = (id: string, chatId: string) => ({
  id,
  chatId,
  role: "user",
  content: "ballast so a unit load is observable",
  createdAt: "2026-08-28T10:00:00.000Z",
});

const shardPath = (table: string, key: string) => join(storeDir, "tables", table, `${encodeShardKey(key)}.json`);
const writeShard = (table: string, key: string, rows: unknown[]) => {
  mkdirSync(join(storeDir, "tables", table), { recursive: true });
  writeFileSync(shardPath(table, key), JSON.stringify(rows));
};
const writeGalleryFile = (chatId: string, filename: string) => {
  mkdirSync(join(dataDir, "gallery", chatId), { recursive: true });
  writeFileSync(join(dataDir, "gallery", chatId, filename), "not-a-real-png");
};

// Seed BEFORE the store boots, like a real install.
// chat-a / chat-b: healthy chats whose images are all recorded — the common
// case, which must not load anything.
for (const chatId of ["chat-a", "chat-b"]) {
  writeShard("chats", chatId, [chatRow(chatId)]);
  writeShard("messages", chatId, [messageRow(`m-${chatId}`, chatId)]);
  writeShard("chat_images", chatId, [imageRow(`img-${chatId}`, chatId, `${chatId}/pic.png`)]);
  writeGalleryFile(chatId, "pic.png");
}
// chat-c: one recorded image, one orphaned file — the only unit that may load.
writeShard("chats", "chat-c", [chatRow("chat-c")]);
writeShard("chat_images", "chat-c", [imageRow("img-c1", "chat-c", "chat-c/known.png")]);
writeGalleryFile("chat-c", "known.png");
writeGalleryFile("chat-c", "orphan.png");
// chat-d: unreadable chat_images shard with a valid .bak recording its file —
// the peek must hand off to the real loader (which recovers from the .bak), and
// the recovered row must prevent a duplicate insert.
writeShard("chats", "chat-d", [chatRow("chat-d")]);
writeShard("chat_images", "chat-d", [imageRow("img-d1", "chat-d", "chat-d/saved.png")]);
writeFileSync(`${shardPath("chat_images", "chat-d")}.bak`, readFileSync(shardPath("chat_images", "chat-d")));
writeFileSync(shardPath("chat_images", "chat-d"), "{corrupt json!");
writeGalleryFile("chat-d", "saved.png");
// chat-e: exists but its gallery directory holds nothing recoverable.
writeShard("chats", "chat-e", [chatRow("chat-e")]);
writeShard("messages", "chat-e", [messageRow("m-e", "chat-e")]);
mkdirSync(join(dataDir, "gallery", "chat-e"), { recursive: true });
// chat-f: a file on disk with NO chat_images shard at all — a genuine orphan
// whose insert must create the shard.
writeShard("chats", "chat-f", [chatRow("chat-f")]);
writeGalleryFile("chat-f", "fresh.png");
// chat-x: gallery directory for a chat that no longer exists — skipped.
writeGalleryFile("chat-x", "ghost.png");

const aShardBytes = readFileSync(shardPath("chat_images", "chat-a"), "utf8");
const bShardBytes = readFileSync(shardPath("chat_images", "chat-b"), "utf8");

const db = await createFileNativeDB();
try {
  await recoverGalleryImages(db);
  const resident = db._fileStore.getResidentChatUnits();

  // The headline assertion: recovery visited every chat but loaded only the
  // units it had a concrete reason to touch. Before the fix, chat-a and
  // chat-b (fully recorded) loaded too — every chat with images did.
  assert.equal(resident.has("chat-a"), false, "a fully-recorded chat's unit is not loaded by the boot scan");
  assert.equal(resident.has("chat-b"), false, "no fully-recorded chat's unit is loaded by the boot scan");
  assert.equal(resident.has("chat-e"), false, "a chat with an empty gallery directory is not loaded");
  assert.equal(resident.has("chat-x"), false, "a deleted chat's leftover directory is not loaded");
  assert.equal(resident.has("chat-c"), true, "the chat with an orphaned file loads (the insert needs its unit)");
  assert.equal(resident.has("chat-d"), true, "the chat with an unreadable shard loads (recovery ladder handoff)");

  const cRows = await db.select().from(chatImages).where(eq(chatImages.chatId, "chat-c"));
  assert.deepEqual(
    cRows.map((row) => row.filePath).sort(),
    ["chat-c/known.png", "chat-c/orphan.png"],
    "the orphaned file is re-registered and the recorded row is preserved",
  );
  const dRows = await db.select().from(chatImages).where(eq(chatImages.chatId, "chat-d"));
  assert.deepEqual(
    dRows.map((row) => row.filePath),
    ["chat-d/saved.png"],
    "the .bak-recovered row is honored — no duplicate insert for the corrupt-shard chat",
  );
  const fRows = await db.select().from(chatImages).where(eq(chatImages.chatId, "chat-f"));
  assert.deepEqual(
    fRows.map((row) => row.filePath),
    ["chat-f/fresh.png"],
    "a file with no shard at all is recovered",
  );
  const xRows = await db.select().from(chatImages).where(eq(chatImages.chatId, "chat-x"));
  assert.equal(xRows.length, 0, "no rows are created for a chat that no longer exists");

  await db._fileStore.flush();
  assert.equal(
    readFileSync(shardPath("chat_images", "chat-a"), "utf8"),
    aShardBytes,
    "an untouched chat's shard file is byte-identical after recovery and flush",
  );
  assert.equal(
    readFileSync(shardPath("chat_images", "chat-b"), "utf8"),
    bShardBytes,
    "no untouched chat's shard file is rewritten",
  );
  assert.equal(existsSync(shardPath("chat_images", "chat-f")), true, "the recovered orphan's shard exists after flush");

  // Second run right after the first: everything is recorded now, so nothing
  // new may load and nothing may be inserted twice (peek sees the flushed
  // shards; chat-c/d stay resident from the first pass).
  const residentBefore = new Set(db._fileStore.getResidentChatUnits());
  await recoverGalleryImages(db);
  assert.deepEqual(
    [...db._fileStore.getResidentChatUnits()].sort(),
    [...residentBefore].sort(),
    "a re-run with everything recorded loads no additional units",
  );
  const fRowsAfter = await db.select().from(chatImages).where(eq(chatImages.chatId, "chat-f"));
  assert.equal(fRowsAfter.length, 1, "a re-run does not duplicate the recovered row");
} finally {
  await db._fileStore.close();
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("Gallery-recovery regressions passed.");
