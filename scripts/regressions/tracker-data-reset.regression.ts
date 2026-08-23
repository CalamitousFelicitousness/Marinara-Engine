// Retiring a tracker schema needs the snapshots gone, not just the live state.
//
// Every tracker run merges its output over `characterTrackerHistory`, built from
// the chat's recent snapshots, so a field the prompt stops emitting is restored
// rather than dropped. Clearing the current snapshot is not enough -- the field
// comes straight back on the next turn. This lane pins the two purges that make
// a clear actually stick, and pins that the narrow one stays narrow.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { createGameStateStorage } from "../../packages/server/src/services/storage/game-state.storage.js";
import { gameStateSnapshots } from "../../packages/server/src/db/schema/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "tracker-reset-"));
// createFileNativeDB reads FILE_STORAGE_DIR, it does not take a path. Passing
// one silently opens the real install instead -- here the writer lease refused,
// but a stopped server would have let this delete live tracker data.
process.env.FILE_STORAGE_DIR = dataDir;
try {
  const db = await createFileNativeDB();
  const store = createGameStateStorage(db);

  const seed = async (chatId: string, messageId: string, name: string) =>
    store.create({
      chatId,
      messageId,
      swipeIndex: 0,
      presentCharacters: [{ characterId: "nova", name, customFields: { Outfit: "coat" }, stats: [] }],
    } as never);

  await seed("chat-a", "m1", "Nova");
  await seed("chat-a", "m2", "Nova");
  await seed("chat-b", "m3", "Vela");

  // Count rows directly: getRecent filters on committed=1, but the purges are
  // about every snapshot, committed or not.
  const count = async (chatId?: string) => {
    const rows = (await db.select().from(gameStateSnapshots)) as Array<{ chatId?: unknown }>;
    return chatId ? rows.filter((row) => row.chatId === chatId).length : rows.length;
  };

  assert.equal(await count("chat-a"), 2, "fixture seeded chat-a");
  assert.equal(await count("chat-b"), 1, "fixture seeded chat-b");

  // ── Per-chat purge leaves other chats alone ──
  // This is what the tracker menu's clear now calls; without it the next run
  // rebuilds every retired field out of this chat's own history.
  await store.deleteForChat("chat-a");
  assert.equal(await count("chat-a"), 0, "the chat's history is gone");
  assert.equal(await count("chat-b"), 1, "a different chat is untouched");

  // ── Global purge clears the rest ──
  await seed("chat-a", "m4", "Nova");
  const result = await store.deleteAll();
  assert.ok(result.removed >= 2, `expected the removed count to be reported, got ${result.removed}`);
  assert.equal(await count(), 0, "nothing survives the global purge");

  // Purging an already-empty store is a no-op rather than an error, so the
  // settings button is safe to press twice.
  assert.deepEqual(await store.deleteAll(), { removed: 0 });
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("tracker-data-reset regression passed.");
