// #7767: chat gallery rows keep the request an image was rendered from, so it can be
// regenerated with the same negative prompt, NovelAI character prompts, connection and
// reference sources. Older rows (no record) and malformed records read as null.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureDir = mkdtempSync(join(tmpdir(), "marinara-chat-image-generation-"));
process.env.DATA_DIR = fixtureDir;
process.env.FILE_STORAGE_DIR = join(fixtureDir, "storage");
process.env.MARINARA_ENV_FILE = join(fixtureDir, ".env");
writeFileSync(process.env.MARINARA_ENV_FILE, "");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const { buildChatImageGenerationRecord, parseChatImageGenerationRecord } =
  await import("../../packages/shared/src/utils/chat-image-generation.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createGalleryStorage } = await import("../../packages/server/src/services/storage/gallery.storage.js");

try {
  // Builder trims, drops unusable character prompts and duplicate ids.
  const record = buildChatImageGenerationRecord({
    connectionId: "  conn-1 ",
    negativePrompt: " lowres, bad hands ",
    characterPrompts: [
      { name: "Arceana", prompt: "tall elf queen", negativePrompt: "", position: { x: 0.7, y: 0.5 } },
      { name: "  ", prompt: "nameless" },
      { name: "Rolim", prompt: "   " },
    ],
    referenceCharacterIds: ["char-a", "char-a", " ", "char-b"],
    referencePersonaId: "",
    locationImageId: "global-gallery:loc-1",
  });
  assert.deepEqual(record, {
    version: 1,
    connectionId: "conn-1",
    negativePrompt: "lowres, bad hands",
    characterPrompts: [{ name: "Arceana", prompt: "tall elf queen", position: { x: 0.7, y: 0.5 } }],
    references: { characterIds: ["char-a", "char-b"], personaId: null, locationImageId: "global-gallery:loc-1" },
  });

  // Unknown, empty and malformed values read as "no record".
  assert.equal(parseChatImageGenerationRecord(null), null);
  assert.equal(parseChatImageGenerationRecord(""), null);
  assert.equal(parseChatImageGenerationRecord("{not json"), null);
  assert.equal(parseChatImageGenerationRecord(JSON.stringify({ ...record, version: 2 })), null);

  // Round trip through the real file-backed gallery table.
  const db = await getDB();
  const chat = await createChatsStorage(db).create({ name: "Regenerate", mode: "roleplay" });
  assert.ok(chat?.id);
  const gallery = createGalleryStorage(db);

  const withRecord = await gallery.create({
    chatId: chat.id,
    filePath: `${chat.id}/new.png`,
    prompt: "throne room",
    generation: record,
  });
  const legacy = await gallery.create({ chatId: chat.id, filePath: `${chat.id}/old.png`, prompt: "old image" });

  const storedRecord = await gallery.getById(withRecord!.id, chat.id);
  assert.equal(typeof storedRecord?.generation, "string");
  assert.deepEqual(parseChatImageGenerationRecord(storedRecord?.generation), record);

  const storedLegacy = await gallery.getById(legacy!.id, chat.id);
  assert.equal(storedLegacy?.generation ?? null, null);
  assert.equal(parseChatImageGenerationRecord(storedLegacy?.generation), null);

  console.log("chat-image-generation-record: ok");
} finally {
  await closeDB?.().catch(() => {});
  rmSync(fixtureDir, { recursive: true, force: true });
}
