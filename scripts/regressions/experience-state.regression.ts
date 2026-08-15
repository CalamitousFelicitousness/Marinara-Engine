// #5102 regression: host-owned experience-state routes over game_engine_state.
//
// A game-surface Experience (capability package owning a Game mode world) cannot reach
// game_engine_state through the turn-game runner, and its sanctioned route registrar is
// privileged-only — so its world state used to live in chat metadata, which no engine
// seam rewinds. These routes give the chat's stamped Experience scoped access to the
// real table so swipes, branches, and checkpoint restores rewind the world like they
// rewind a turn-game.
//
// Pinned behaviors:
//   1. PUT/GET round-trip anchored to the latest visible assistant message.
//   2. Chats without a stamped gameExperienceId are refused (409) on both verbs.
//   3. Namespace isolation: reads are scoped to "experience:<id>" — turn-game rows in
//      the same chat are invisible, and the un-scoped turn-game read path is unchanged.
//   4. Anchor rewind: after a newer save on a newer message, a reader whose visible
//      anchor is the older message sees the older save.
//   5. The "" live anchor is used before any assistant message exists.
//   6. Oversized state is rejected (422) without writing a row.
//   7. Same-anchor saves replace (one row per anchor); cross-anchor saves accumulate,
//      so getLatestAtOrBefore (checkpoint-time re-lookup) recovers older saves.
import assert from "node:assert/strict";
import Fastify from "../../packages/server/node_modules/fastify/fastify.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import { gameEngineState } from "../../packages/server/src/db/schema/index.js";
import { gameRoutes } from "../../packages/server/src/routes/game.routes.js";
import { createChatsStorage } from "../../packages/server/src/services/storage/chats.storage.js";
import { createGameEngineStateStorage } from "../../packages/server/src/services/storage/game-engine-state.storage.js";

const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const db = await getDB();
const chats = createChatsStorage(db);
const engineStore = createGameEngineStateStorage(db);
const createdChatIds: string[] = [];

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const app = Fastify();
app.decorate("db", db);
await app.register(gameRoutes, { prefix: "/api/game" });

const EXPERIENCE_ID = "experience-state-test";
const GAME_TYPE = `experience:${EXPERIENCE_ID}`;

async function createExperienceChat(name: string) {
  const chat = await chats.create({ name, mode: "game", characterIds: [] });
  assert.ok(chat);
  createdChatIds.push(chat.id);
  await chats.patchMetadata(chat.id, () => ({ gameExperienceId: EXPERIENCE_ID }));
  return chat;
}

const putState = (chatId: string, payload: unknown) =>
  app.inject({ method: "PUT", url: `/api/game/${chatId}/experience-state`, payload: payload as object });
const getState = (chatId: string) => app.inject({ method: "GET", url: `/api/game/${chatId}/experience-state` });

const addAssistantMessage = async (chatId: string, content: string) => {
  const message = await chats.createMessage({
    chatId,
    role: "assistant",
    characterId: null,
    content,
  } as Parameters<typeof chats.createMessage>[0]);
  assert.ok(message);
  return message;
};

try {
  // ── 1. Round-trip on the visible anchor ──
  {
    const chat = await createExperienceChat("experience round trip");
    const m1 = await addAssistantMessage(chat.id, "turn 1");

    const put = await putState(chat.id, { state: { zone: "village", x: 5 } });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().anchor.messageId, m1.id, "save anchors to the visible assistant message");

    const get = await getState(chat.id);
    assert.equal(get.statusCode, 200, get.body);
    const body = get.json();
    assert.deepEqual(body.state, { zone: "village", x: 5 }, "GET returns the stored state parsed");
    assert.equal(body.anchor.messageId, m1.id);
    assert.equal(body.committed, true, "experience saves default to committed");

    const empty = await getState((await createExperienceChat("experience empty")).id);
    assert.equal(empty.statusCode, 200);
    assert.equal(empty.json().state, null, "a chat with no save yet reads as state:null, not an error");
  }

  // ── 2. Chats without a stamped Experience are refused ──
  {
    const chat = await chats.create({ name: "no experience", mode: "game", characterIds: [] });
    assert.ok(chat);
    createdChatIds.push(chat.id);
    const get = await getState(chat.id);
    assert.equal(get.statusCode, 409, "GET refuses a chat without gameExperienceId");
    const put = await putState(chat.id, { state: { nope: true } });
    assert.equal(put.statusCode, 409, "PUT refuses a chat without gameExperienceId");
    assert.equal(await engineStore.getLatest(chat.id), null, "the refused PUT wrote nothing");
  }

  // ── 3. Namespace isolation from turn-game rows ──
  {
    const chat = await createExperienceChat("experience isolation");
    const m1 = await addAssistantMessage(chat.id, "turn 1");
    await engineStore.create({
      chatId: chat.id,
      messageId: m1.id,
      swipeIndex: 0,
      gameType: "uno",
      schemaVersion: 1,
      state: JSON.stringify({ turnGame: true }),
      committed: true,
    });

    const get = await getState(chat.id);
    assert.equal(get.json().state, null, "experience reads never surface turn-game rows");

    await putState(chat.id, { state: { world: 1 } });
    const unscoped = await engineStore.getForGeneration(chat.id, {
      visibleAnchor: { messageId: m1.id, swipeIndex: 0 },
    });
    assert.ok(unscoped, "un-scoped (turn-game) reads still see a row");
    // Same anchor holds one row per gameType writer; the un-scoped anchor read returns
    // one of them (creation order), and the scoped reads below stay disjoint either way.
    const scopedTurnGame = await engineStore.getForGeneration(chat.id, {
      visibleAnchor: { messageId: m1.id, swipeIndex: 0 },
      gameType: "uno",
    });
    assert.equal(JSON.parse(scopedTurnGame!.state).turnGame, true, "turn-game rows survive experience saves");
    const scopedExperience = await engineStore.getForGeneration(chat.id, {
      visibleAnchor: { messageId: m1.id, swipeIndex: 0 },
      gameType: GAME_TYPE,
    });
    assert.deepEqual(JSON.parse(scopedExperience!.state), { world: 1 });
  }

  // ── 4. Anchor rewind ──
  {
    const chat = await createExperienceChat("experience rewind");
    const m1 = await addAssistantMessage(chat.id, "turn 1");
    await putState(chat.id, { state: { turn: 1 } });
    await tick(8);
    await addAssistantMessage(chat.id, "turn 2");
    await putState(chat.id, { state: { turn: 2 } });

    const latest = await getState(chat.id);
    assert.deepEqual(latest.json().state, { turn: 2 }, "the newest anchor reads the newest save");

    const rewound = await engineStore.getForGeneration(chat.id, {
      visibleAnchor: { messageId: m1.id, swipeIndex: 0 },
      gameType: GAME_TYPE,
    });
    assert.deepEqual(JSON.parse(rewound!.state), { turn: 1 }, "an older visible anchor reads its own save");
  }

  // ── 5. Live anchor before the first assistant message ──
  {
    const chat = await createExperienceChat("experience live anchor");
    const put = await putState(chat.id, { state: { fresh: true } });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal(put.json().anchor.messageId, "", 'pre-narration saves use the "" live anchor');
    const get = await getState(chat.id);
    assert.deepEqual(get.json().state, { fresh: true });
  }

  // ── 6. Oversized state is rejected without a write ──
  {
    const chat = await createExperienceChat("experience bound");
    const put = await putState(chat.id, { state: { blob: "x".repeat(263_000) } });
    assert.equal(put.statusCode, 422, "oversized state is rejected");
    assert.equal(await engineStore.getLatest(chat.id, GAME_TYPE), null, "the rejected PUT wrote nothing");
  }

  // ── 7. One row per anchor; cross-anchor history feeds checkpoint re-lookup ──
  {
    const chat = await createExperienceChat("experience anchors");
    await addAssistantMessage(chat.id, "turn 1");
    await putState(chat.id, { state: { save: "a" } });
    await tick(8);
    await putState(chat.id, { state: { save: "b" } });
    const afterRewrites = await db.select().from(gameEngineState).where(eq(gameEngineState.chatId, chat.id));
    assert.equal(afterRewrites.length, 1, "same-anchor saves replace instead of accumulating");

    const checkpointTs = afterRewrites[0]!.createdAt;
    await tick(8);
    await addAssistantMessage(chat.id, "turn 2");
    await putState(chat.id, { state: { save: "c" } });

    const atCheckpoint = await engineStore.getLatestAtOrBefore(chat.id, checkpointTs);
    assert.deepEqual(
      JSON.parse(atCheckpoint!.state),
      { save: "b" },
      "checkpoint-time re-lookup recovers the pre-checkpoint save across anchors",
    );
  }

  console.log("experience-state regression passed");
} finally {
  for (const chatId of createdChatIds) {
    await engineStore.deleteForChat(chatId).catch(() => undefined);
    await chats.remove(chatId).catch(() => undefined);
  }
  await app.close();
  await closeDB();
}
