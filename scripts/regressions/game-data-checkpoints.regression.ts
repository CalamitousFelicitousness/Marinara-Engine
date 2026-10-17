// #7743 slice 6 regression: the State Editor's checkpoint.
//
// A game with no snapshot has nothing to checkpoint: the route says so (and the editor carries on
// with the save). Once the game has a snapshot, a State Editor checkpoint is taken as an automatic
// one: it is pruned to the newest 5 for its trigger, and the other triggers' checkpoints and manual
// ones are left alone.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-game-data-checkpoint-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createGameStateStorage } = await import("../../packages/server/src/services/storage/game-state.storage.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await app.register(gameRoutes, { prefix: "/api/game" });
const chats = createChatsStorage(db);
const states = createGameStateStorage(db);
const chat = await chats.create({ name: "Checkpoints", mode: "game", characterIds: [] });

try {
  const message = await chats.createMessage({ chatId: chat.id, role: "assistant", content: "Rain on the windows." });
  const empty = await app.inject({ method: "GET", url: `/api/game/${chat.id}/checkpoints` });
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), [], "a new game has no checkpoints");

  const checkpoint = (triggerType: string, label = "Before State Editor save") =>
    app.inject({ method: "POST", url: "/api/game/checkpoint", payload: { chatId: chat.id, label, triggerType } });

  // No snapshot yet: the route refuses, and the editor treats that as nothing to checkpoint.
  const none = await checkpoint("state_editor_save");
  assert.equal(none.statusCode, 500, "a game with no snapshot has nothing to checkpoint");
  assert.match(none.body, /No game state snapshot/);

  await states.create({
    chatId: chat.id,
    messageId: message.id,
    swipeIndex: 0,
    date: null,
    time: null,
    location: null,
    weather: null,
    temperature: null,
    presentCharacters: [],
    recentEvents: [],
    playerStats: { stats: [], attributes: null, skills: {}, inventory: [], activeQuests: [], status: "" } as never,
    personaStats: null,
  });

  // The new trigger type is taken as an automatic one, and the game's list reads it back.
  const first = await checkpoint("state_editor_save");
  assert.equal(first.statusCode, 200, first.body);
  const listed = (await app.inject({ method: "GET", url: `/api/game/${chat.id}/checkpoints` })).json() as Array<{
    id: string;
    label: string;
    triggerType: string;
  }>;
  assert.deepEqual(
    listed.map((row) => [row.label, row.triggerType]),
    [["Before State Editor save", "state_editor_save"]],
    "the editor's checkpoint is listed with its own trigger",
  );

  // Six of them: the oldest of the State Editor's is pruned, the other triggers are left alone.
  const manual = await checkpoint("manual", "Mine");
  assert.equal(manual.statusCode, 200);
  for (let i = 0; i < 5; i += 1) assert.equal((await checkpoint("state_editor_save")).statusCode, 200);
  const after = (await app.inject({ method: "GET", url: `/api/game/${chat.id}/checkpoints` })).json() as Array<{
    id: string;
    triggerType: string;
  }>;
  assert.equal(after.filter((row) => row.triggerType === "state_editor_save").length, 5, "kept to the newest 5");
  assert.equal(after.filter((row) => row.triggerType === "manual").length, 1, "a manual checkpoint is never pruned");
  assert.equal(
    after.some((row) => row.id === listed[0]!.id),
    false,
    "the oldest State Editor checkpoint went",
  );

  // Deleting one takes it away and leaves the rest.
  const toDelete = after.find((row) => row.triggerType === "state_editor_save")!;
  const deleted = await app.inject({ method: "DELETE", url: `/api/game/checkpoint/${toDelete.id}?chatId=${chat.id}` });
  assert.equal(deleted.statusCode, 200, deleted.body);
  const left = (await app.inject({ method: "GET", url: `/api/game/${chat.id}/checkpoints` })).json() as Array<{
    id: string;
  }>;
  assert.equal(left.length, after.length - 1);
  assert.ok(!left.some((row) => row.id === toDelete.id));
} finally {
  await chats.remove(chat.id).catch(() => {});
  await app.close();
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
console.log("game-data-checkpoints regression passed");
