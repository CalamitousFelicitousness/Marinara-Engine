/**
 * Dungeon, cave and station maps in Game Mode: generated from a seed for every set, every floor cell
 * reachable from the way in; kept on the chat as made; opened and left by the Game Master's `[map:]`
 * tags; walked by the shortest way with its minutes on the clock and told on the next turn (again on a
 * regeneration); left only from the way out. A game without a map is untouched.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DUNGEON_EXIT_PROP,
  DUNGEON_SETS,
  createConnectionSchema,
  dungeonAreaAt,
  dungeonFromGameDungeonMap,
  dungeonPath,
  dungeonSetFor,
  dungeonWalkable,
  gameDungeonMapFromDungeon,
  gameDungeonMapFromMetadata,
  gameDungeonMapPromptText,
  gameDungeonSeed,
  generateDungeonMap,
  readGameDungeonTags,
  stripGmTags,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-dungeon-maps-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");

try {
  // ── The generator ──
  assert.equal(DUNGEON_SETS.length, 11);
  for (const set of DUNGEON_SETS) {
    assert.ok(/stair|ladder|hatch/u.test(set.props[DUNGEON_EXIT_PROP]), `${set.id}'s slot 5 is the way out`);
    for (let seed = 1; seed <= 25; seed++) {
      for (const size of ["small", "medium", "large"] as const) {
        const map = generateDungeonMap(set.id, seed, size);
        assert.ok(map.rooms.length > 0, `${set.id} ${seed} ${size} has rooms`);
        assert.equal(
          map.props[map.entrance.y * map.width + map.entrance.x],
          DUNGEON_EXIT_PROP,
          "the way in is the way out",
        );
        for (let i = 0; i < map.ground.length; i++) {
          const [x, y] = [i % map.width, Math.floor(i / map.width)];
          if (!dungeonWalkable(map, x, y) || (x === map.entrance.x && y === map.entrance.y)) continue;
          assert.ok(dungeonPath(map, map.entrance, { x, y }), `${set.id} ${seed} ${size}: (${x}, ${y}) is reachable`);
        }
        // Walls only where they border an open cell; the edge of the map is never open.
        for (let x = 0; x < map.width; x++) assert.notEqual(map.ground[x], "floor");
      }
    }
  }
  assert.deepEqual(
    generateDungeonMap("dungeon_crypt", 7),
    generateDungeonMap("dungeon_crypt", 7),
    "the same seed, the same map",
  );
  assert.notDeepEqual(generateDungeonMap("dungeon_crypt", 7).ground, generateDungeonMap("dungeon_crypt", 8).ground);

  // A path is the shortest one, four ways, and never through a wall, liquid or a prop.
  const crypt = generateDungeonMap("dungeon_crypt", 3);
  const far = crypt.rooms.at(-1)!;
  const target = (() => {
    for (let y = far.y; y < far.y + far.h; y++)
      for (let x = far.x; x < far.x + far.w; x++) if (dungeonWalkable(crypt, x, y)) return { x, y };
    return null;
  })()!;
  const path = dungeonPath(crypt, crypt.entrance, target)!;
  let at = crypt.entrance;
  for (const step of path) {
    assert.equal(Math.abs(step.x - at.x) + Math.abs(step.y - at.y), 1, "one cell a step");
    assert.ok(dungeonWalkable(crypt, step.x, step.y));
    at = step;
  }
  assert.equal(dungeonPath(crypt, crypt.entrance, { x: 0, y: 0 }), null, "no way into the rock");

  // Kept on the chat and read back the same.
  const kept = gameDungeonMapFromDungeon(crypt, "The Old Crypt", "m1");
  assert.deepEqual(dungeonFromGameDungeonMap(kept), crypt);
  assert.deepEqual(gameDungeonMapFromMetadata({ gameDungeonMap: kept }), kept);
  assert.equal(
    gameDungeonMapFromMetadata({ gameDungeonMap: { ...kept, ground: kept.ground.slice(1) } }),
    null,
    "a torn map is no map",
  );
  assert.equal(gameDungeonMapFromMetadata({}), null);

  // The set by kind and setting.
  assert.equal(dungeonSetFor("cave", "fantasy").kind, "cave");
  assert.equal(dungeonSetFor(undefined, "scifi").kind, "station");
  assert.equal(dungeonSetFor(undefined, undefined).kind, "dungeon");
  assert.equal(dungeonSetFor("dungeon", undefined, "sewer").id, "dungeon_sewer", "a named set wins");

  // The tags, and what the player never reads.
  assert.deepEqual(
    readGameDungeonTags('We go down. [map: kind="cave" name="Wolf Hollow"] [map_update: new_location="X"]'),
    [{ name: "Wolf Hollow", kind: "cave", set: undefined }],
  );
  assert.deepEqual(readGameDungeonTags("Daylight. [map: leave]"), [{ leave: true }]);
  assert.deepEqual(readGameDungeonTags('[map: kind="cave"]'), [], "a map is named");
  assert.equal(stripGmTags('Down we go. [map: kind="cave" name="Wolf Hollow"]').trim(), "Down we go.");
  assert.equal(
    gameDungeonSeed("c1", "Wolf Hollow"),
    gameDungeonSeed("c1", "wolf hollow"),
    "the same place makes the same map",
  );

  // The Game Master's words: the set, each area's props, the way out, where the party stands.
  const words = gameDungeonMapPromptText(kept);
  assert.match(words, /^MAP: The Old Crypt\. Crypt \(worn flagstones, stone brick walls\); area 1: stairs down/u);
  assert.match(words, /The way out is stairs down in area 1\. The party is in area 1\.$/u);
  assert.equal(dungeonAreaAt(kept, -5, -5), 0);

  // ── Through the routes, with a stand-in model ──
  const replies: string[] = [];
  const prompts: string[] = [];
  const standIn = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    prompts.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: replies.shift() ?? "" } }],
      }),
    );
  });
  await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));
  const address = standIn.address();
  assert.ok(address && typeof address !== "string");
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameRoutes, { prefix: "/api/game" });
  await app.register(generateRoutes, { prefix: "/api/generate" });
  try {
    const connection = await createConnectionsStorage(db).create(
      createConnectionSchema.parse({
        name: "Stand-in",
        provider: "custom",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "stand-in",
        apiKey: "sk-stand-in",
      }),
    );
    const chats = createChatsStorage(db);
    const chat = await chats.create({ name: "Maps", mode: "game", characterIds: [], connectionId: connection!.id });
    const chatId = chat.id;
    await chats.patchMetadata(chatId, {
      gameId: `maps-${chatId}`,
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gameTime: { day: 1, hour: 10, minute: 0 },
    });
    await chats.createMessage({ chatId, role: "assistant", content: "A hillside, and a dark mouth in it." });
    const meta = async () => JSON.parse((await chats.getById(chatId))!.metadata as string) as Record<string, any>;
    const turn = async (reply: string, extra: Record<string, unknown> = {}) => {
      replies.push(reply);
      prompts.length = 0;
      const response = await app.inject({
        method: "POST",
        url: "/api/generate/",
        payload: { chatId, userMessage: "We go on.", streaming: false, ...extra },
      });
      assert.equal(response.statusCode, 200, response.body);
    };
    const minutesOf = (time: { day: number; hour: number; minute: number }) =>
      (time.day * 24 + time.hour) * 60 + time.minute;

    // No map: nothing about one in the prompt but how to open one, and the routes say so.
    await turn("The wind picks up.");
    assert.match(prompts.join("\n"), /\[map: kind=\\"cave\|dungeon\|station\\" name=\\"Name\\"\]/u);
    assert.doesNotMatch(prompts.join("\n"), /MAP: /u);
    assert.equal((await app.inject({ method: "GET", url: `/api/game/${chatId}/map` })).json().map, null);

    // The Game Master opens a cave: the map is made, kept and shown.
    await turn('You step inside. [map: kind="cave" name="Wolf Hollow"]');
    const opened = (await meta()).gameDungeonMap;
    assert.ok(opened, "the map is kept");
    assert.equal(opened.name, "Wolf Hollow");
    assert.equal(DUNGEON_SETS.find((set) => set.id === opened.set)?.kind, "cave");
    assert.deepEqual(opened.at, opened.entrance, "the party starts at the way in");
    assert.equal((await meta()).gameDungeonView, "map");
    const saved = (await chats.listMessages(chatId)).filter((m: any) => m.role === "assistant").at(-1)!;
    assert.match(saved.content as string, /\[map: kind="cave" name="Wolf Hollow"\]/u);

    // The next turn's prompt holds the map.
    await turn("Water drips.");
    assert.match(prompts.join("\n"), /MAP: Wolf Hollow\. /u);
    assert.match(prompts.join("\n"), /The party is in area 1\./u);

    // A walk: the shortest way, its minutes on the clock, told next turn, kept with the reply.
    const cells = dungeonFromGameDungeonMap(opened);
    const goal = (() => {
      for (const room of [...opened.rooms].reverse())
        for (let y = room.y; y < room.y + room.h; y++)
          for (let x = room.x; x < room.x + room.w; x++)
            if (dungeonWalkable(cells, x, y) && (x !== opened.at.x || y !== opened.at.y)) return { x, y };
      return null;
    })()!;
    const before = minutesOf((await meta()).gameTime);
    const walk = (body: Record<string, unknown>) =>
      app.inject({ method: "POST", url: `/api/game/${chatId}/map/walk`, payload: body });
    assert.equal((await walk({ map: "nope", ...goal })).statusCode, 409, "not this map");
    assert.equal((await walk({ map: opened.id, x: 0, y: 0 })).statusCode, 400, "no way into the rock");
    const walked = await walk({ map: opened.id, ...goal });
    assert.equal(walked.statusCode, 200, walked.body);
    const answer = walked.json();
    assert.deepEqual(answer.path.at(-1), goal);
    assert.equal(minutesOf((await meta()).gameTime) - before, answer.minutes, "the minutes on the clock");
    assert.deepEqual((await meta()).gameDungeonMap.at, goal);
    const pending = (await meta()).gameDungeonWalk;
    assert.equal(pending.minutes, answer.minutes);
    await turn("Bones crunch underfoot.");
    assert.match(prompts.join("\n"), /The party walked from area 1 to (area \d+|a passage) of Wolf Hollow/u);
    assert.equal((await meta()).gameDungeonWalk, null, "told, no longer pending");
    const toldIn = (await chats.listMessages(chatId)).filter((m: any) => m.role === "assistant").at(-1)!;
    assert.equal(JSON.parse(toldIn.extra as string).dungeonWalk.id, pending.id, "kept with the reply");
    await turn("Bones crack.", { regenerateMessageId: toldIn.id, userMessage: undefined });
    assert.match(prompts.join("\n"), /The party walked from area 1/u, "told again on a regeneration");

    // Leaving only from the way out.
    const leave = () =>
      app.inject({ method: "POST", url: `/api/game/${chatId}/map/leave`, payload: { map: opened.id } });
    assert.equal((await leave()).statusCode, 400, "not from here");
    const back = await walk({ map: opened.id, ...opened.entrance });
    assert.equal(back.statusCode, 200, back.body);
    const left = await leave();
    assert.equal(left.statusCode, 200, left.body);
    assert.equal((await meta()).gameDungeonMap, null);
    await turn("Daylight.");
    assert.match(prompts.join("\n"), /The party has left Wolf Hollow by its way out\./u);
    assert.equal((await meta()).gameDungeonLeft, null, "told once");

    // The Game Master can lead the party out too; going back in makes the same cave.
    await turn('Back in. [map: kind="cave" name="Wolf Hollow"]');
    const again = (await meta()).gameDungeonMap;
    assert.equal(again.ground, opened.ground, "the same place, the same map");
    assert.notEqual(again.id, opened.id, "but a new visit");
    await turn("You climb out. [map: leave]");
    assert.equal((await meta()).gameDungeonMap, null);
  } finally {
    await app.close();
    await closeDB();
    await new Promise<void>((resolve) => standIn.close(() => resolve()));
  }

  console.log("Dungeon maps: generated for every set, opened and left by the Game Master, walked and told.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
