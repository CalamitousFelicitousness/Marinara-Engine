// Multiswipe finalize route against a real Fastify app and real storage.
// Pins the per-swipe lifecycle: committing one swipe clears only that swipe's
// marker, unchosen candidates stay pending so their agents can still run later,
// and repeat calls on an already-committed swipe are a safe no-op.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify from "../../packages/server/node_modules/fastify/fastify.js";

import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { multiSwipeFinalizeRoutes } from "../../packages/server/src/routes/generate/multi-swipe-finalize-route.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import { readMultiSwipePendingMarker } from "../../packages/shared/src/utils/multi-swipe.js";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-multi-swipe-finalize-"));
process.env.FILE_STORAGE_DIR = storageDir;
const db = await createFileNativeDB();
const chats = createChatsStorage(db);

const app = Fastify();
app.decorate("db", db);
await app.register(multiSwipeFinalizeRoutes, { prefix: "/api/generate/multi-swipe" });

const marker = { pendingAgents: ["world-state", "expression-engine"], candidateCount: 3, createdAt: 1_770_000_000 };

const finalize = (chatId: string, messageId: string) =>
  app.inject({ method: "POST", url: "/api/generate/multi-swipe/finalize", payload: { chatId, messageId } });

const pendingIndexes = async (messageId: string) =>
  (await chats.getSwipes(messageId))
    .filter((swipe: { extra: unknown }) => readMultiSwipePendingMarker(swipe.extra) !== null)
    .map((swipe: { index: number }) => swipe.index);

try {
  const chat = await chats.create({
    name: "Multiswipe finalize",
    mode: "roleplay",
    characterIds: [],
    groupId: null,
    personaId: null,
    promptPresetId: null,
    connectionId: null,
  });
  assert.ok(chat);

  const message = await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    characterId: null,
    content: "Original response.",
  });
  assert.ok(message);

  // A finished multiswipe run: candidate 1 active, two silent candidates behind it.
  await chats.addSwipe(message.id, "Candidate one.");
  await chats.addSwipe(message.id, "Candidate two.", true);
  await chats.addSwipe(message.id, "Candidate three.", true);
  for (const swipeIndex of [1, 2, 3]) {
    await chats.updateSwipeExtra(message.id, swipeIndex, { multiSwipe: marker });
  }
  await chats.updateMessageExtra(message.id, { multiSwipe: marker });

  // ── Committing one candidate leaves the others pending ──
  // The user browses to candidate 3 before committing.
  await chats.setActiveSwipe(message.id, 3);

  const response = await finalize(chat.id, message.id);
  assert.equal(response.statusCode, 200);
  const body = response.json() as { pendingAgents: string[]; activeSwipeIndex: number; cleared: boolean };
  assert.deepEqual(body.pendingAgents, marker.pendingAgents, "finalize must report the agents deferred at defer time");
  assert.equal(body.activeSwipeIndex, 3, "agents anchor to the swipe the user actually chose");
  assert.equal(body.cleared, true);

  assert.deepEqual(
    await pendingIndexes(message.id),
    [1, 2],
    "candidates the user did not commit to keep their marker, so their agents can still run later",
  );
  const messageAfter = await chats.getMessage(message.id);
  assert.equal(readMultiSwipePendingMarker(messageAfter?.extra), null, "the committed swipe's mirror must clear");
  assert.equal(messageAfter?.content, "Candidate three.", "finalize must not disturb the chosen swipe's content");

  // ── Repeat finalize is a no-op, and pending siblings must not leak into it ──
  const second = await finalize(chat.id, message.id);
  assert.equal(second.statusCode, 200);
  const secondBody = second.json() as { pendingAgents: string[]; cleared: boolean };
  assert.deepEqual(secondBody.pendingAgents, [], "a committed swipe has no agents left to replay");
  assert.equal(secondBody.cleared, false, "a marked sibling must not make the committed swipe look pending");
  assert.deepEqual(await pendingIndexes(message.id), [1, 2], "a no-op finalize must not touch sibling markers");

  // ── Browsing back to an unchosen candidate re-exposes its own pending state ──
  // setActiveSwipe mirrors the target swipe's extra onto the message, which is
  // what makes per-swipe markers visible to the client without extra plumbing.
  await chats.setActiveSwipe(message.id, 1);
  const browsed = await chats.getMessage(message.id);
  assert.deepEqual(
    readMultiSwipePendingMarker(browsed?.extra)?.pendingAgents,
    marker.pendingAgents,
    "browsing to an un-agented candidate must surface its marker on the message",
  );

  const third = await finalize(chat.id, message.id);
  const thirdBody = third.json() as { pendingAgents: string[]; activeSwipeIndex: number; cleared: boolean };
  assert.deepEqual(thirdBody.pendingAgents, marker.pendingAgents, "the revisited candidate replays its own agents");
  assert.equal(thirdBody.activeSwipeIndex, 1);
  assert.equal(thirdBody.cleared, true);
  assert.deepEqual(await pendingIndexes(message.id), [2], "only the newly committed swipe clears");

  // Swipe 3 stayed committed across the browse, so leaving a swipe cannot revive it.
  assert.equal(
    readMultiSwipePendingMarker((await chats.getSwipes(message.id)).find((s: { index: number }) => s.index === 3)?.extra),
    null,
    "switching away from a committed swipe must not re-mark it",
  );

  // ── A message that never ran multiswipe finalizes to nothing ──
  const plain = await chats.createMessage({
    chatId: chat.id,
    role: "assistant",
    characterId: null,
    content: "Ordinary response.",
  });
  assert.ok(plain);
  const plainBody = (await finalize(chat.id, plain.id)).json() as { pendingAgents: string[]; cleared: boolean };
  assert.deepEqual(plainBody, { pendingAgents: [], activeSwipeIndex: 0, cleared: false } as unknown as typeof plainBody);

  // ── Cross-chat and unknown ids are rejected ──
  const otherChat = await chats.create({
    name: "Other chat",
    mode: "roleplay",
    characterIds: [],
    groupId: null,
    personaId: null,
    promptPresetId: null,
    connectionId: null,
  });
  assert.ok(otherChat);
  assert.equal(
    (await finalize(otherChat.id, message.id)).statusCode,
    404,
    "a message must belong to the chat it is finalized under",
  );
  assert.equal((await finalize(chat.id, "missing-message")).statusCode, 404);
} finally {
  await app.close();
  await db._fileStore.close();
  rmSync(storageDir, { recursive: true, force: true });
}

console.info("Multiswipe finalize regression passed.");
