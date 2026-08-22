// #5405 regression: `imported:` experience-state anchors are dangling BY DESIGN.
//
// The experience-state import rewrites an anchor that is not a message of the destination
// chat to "imported:<originalId>", because the store's messages -> game_engine_state cascade
// matches messageId ALONE and is never scoped by chatId — a verbatim foreign id would let the
// source chat's message deletions destroy the imported campaign. The cost of that fix is a
// reference that intentionally points at no message, which the integrity walk would otherwise
// report as an error on every imported row.
//
// Pinned behaviors:
//   1. `mari db validate` does not report an "imported:" experience-state anchor as a dangling
//      reference (the CASCADE_DANGLING_EXEMPT_PREFIXES exemption).
//   2. The exemption is narrow: a genuinely dangling, unprefixed anchor is STILL an error, and
//      the sibling chatId cascade on the same table is untouched.
// The pre-commit walk (validateTouchedRows) reads the same exemption table through the same
// `<child>.<childKey>` lookup and is not separately covered here.
//
// Runs on its own temp file store — never the shared dev DB — because validate() walks whole
// tables and would otherwise report unrelated pre-existing state.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-imported-anchor-db-"));
const previousStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageDir;

const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");
const { MariDbService } = await import("../../packages/server/src/services/mari-db/mari-db.service.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createGameEngineStateStorage } =
  await import("../../packages/server/src/services/storage/game-engine-state.storage.js");

const db = await createFileNativeDB();
const GAME_TYPE = "experience:imported-anchor-test";
const danglingRefs = (issues: { table: string; message: string }[]) =>
  issues.filter((issue) => issue.table === "game_engine_state" && issue.message.startsWith("Dangling reference"));

try {
  const chats = createChatsStorage(db);
  const engineStore = createGameEngineStateStorage(db);
  const mari = new MariDbService(db);

  const chat = await chats.create({ name: "imported anchor chat", mode: "game", characterIds: [] });
  assert.ok(chat);
  await chats.patchMetadata(chat.id, () => ({ gameExperienceId: "imported-anchor-test" }));

  // ── 1. An imported anchor is not an integrity error ──
  await engineStore.create({
    chatId: chat.id,
    messageId: "imported:a-message-of-some-other-chat",
    swipeIndex: 0,
    gameType: GAME_TYPE,
    schemaVersion: 1,
    state: JSON.stringify({ campaign: "portable" }),
    committed: true,
  });
  const clean = await mari.validate("game_engine_state");
  assert.deepEqual(
    danglingRefs(clean.errors),
    [],
    "an imported: anchor is dangling by design and must not be reported as an integrity error",
  );

  // ── 2. The exemption is narrow ──
  // An unprefixed anchor naming no message is a real bug and still has to be reported.
  const orphanId = await engineStore.create({
    chatId: chat.id,
    messageId: "a-message-that-does-not-exist",
    swipeIndex: 0,
    gameType: GAME_TYPE,
    schemaVersion: 1,
    state: JSON.stringify({ orphan: true }),
    committed: true,
  });
  const withOrphan = await mari.validate("game_engine_state");
  const reported = danglingRefs(withOrphan.errors);
  assert.equal(reported.length, 1, "a genuinely dangling anchor is still an error");
  assert.equal(reported[0]!.id, orphanId, "and it names the offending row, not the imported one");
  assert.match(reported[0]!.message, /messageId=a-message-that-does-not-exist/);

  // The sibling chatId cascade on the same table keeps its full strength — the exemption is
  // keyed on the column, not the table.
  await engineStore.create({
    chatId: "a-chat-that-does-not-exist",
    messageId: "imported:another-chat-message",
    swipeIndex: 0,
    gameType: GAME_TYPE,
    schemaVersion: 1,
    state: JSON.stringify({ homeless: true }),
    committed: true,
  });
  const withHomeless = await mari.validate("game_engine_state");
  assert.ok(
    withHomeless.errors.some(
      (issue) => issue.table === "game_engine_state" && issue.message.includes("chatId=a-chat-that-does-not-exist"),
    ),
    "a dangling chatId is still an error even on a row whose messageId is exempt",
  );

  console.log("experience-state imported-anchor validate regression passed");
} finally {
  await db._fileStore.close();
  if (previousStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageDir;
  rmSync(storageDir, { recursive: true, force: true });
}
