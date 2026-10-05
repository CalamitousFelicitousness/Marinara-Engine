/**
 * Maps for places (map editor Phase 3, the Game Mode side, generated): a place in town that reads as a
 * cave, a mine, a crypt or a sewer (by its name and tags) is one the party can go down into from where
 * it stands. Its map is laid out from the game and the place's name, kept with the place's id, the same
 * one while the party is on it, and leaving it puts the party back in town where it went down. A place
 * that is not one to go down into (an inn) has no map.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DUNGEON_EXIT_PROP,
  WORLD_GENERATOR_VERSION,
  WORLD_STARTER_KITS,
  checkWorldBrief,
  compileGameWorld,
  createConnectionSchema,
  dungeonSetForPlace,
  parseWorldKit,
  type GameWorld,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-map-places-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");

const gameOf = (id: string, seed: number): GameWorld => {
  const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === id)!);
  assert.ok(parsed.ok);
  const kit = parsed.kit;
  const checked = checkWorldBrief(kit, {
    briefVersion: 1,
    premise: "x",
    peopleNames: kit.cultures.map((culture) => ({
      culture: culture.id,
      given: ["Ama", "Tobin", "Hesk", "Mira", "Oswin", "Bryn", "Calla", "Doran"],
      family: ["Holt", "Drey", "Marrow", "Vane"],
      order: "given-family" as const,
    })),
  });
  assert.ok(checked.ok);
  const inputs = { kit, seed, grounding: "expand" as const, brief: checked.brief };
  return { ...inputs, world: compileGameWorld(inputs) };
};

try {
  // ── Which places are ones to go down into, and their look ──
  const look = (name: string, family = "fantasy", tags: string[] = []) =>
    dungeonSetForPlace({ name, tags }, family)?.id ?? null;
  assert.equal(look("The Old Mine"), "cave_rock");
  assert.equal(look("Wolf Hollow"), "cave_rock");
  assert.equal(look("Frozen Grotto"), "cave_ice");
  assert.equal(look("The Ember Caves of Magma Deep"), "cave_lava", "lava before cave");
  assert.equal(look("Crystal Cavern"), "cave_crystal");
  assert.equal(look("The King's Crypt"), "dungeon_crypt");
  assert.equal(look("City Sewers", "modern"), "dungeon_sewer");
  assert.equal(look("Ruined Chapel"), "dungeon_temple");
  assert.equal(look("Old Watchtower", "fantasy", ["ruin"]), "dungeon_temple", "a ruin by its tags");
  assert.equal(look("The Gilded Gull"), null, "an inn is not one to go down into");
  assert.equal(look("Temple of the Dawn"), null, "nor a temple still standing");
  assert.equal(look("Police Station", "modern"), null, "a station is a station only in science fiction");
  assert.equal(look("Orbital Station Kepler", "scifi"), "station_corridor");
  assert.equal(look("Research Lab", "scifi"), "station_lab");
  assert.equal(look("Reactor Core", "scifi"), "station_engine");
  assert.equal(look("Hydroponics Bay", "scifi"), "station_hydro");
  assert.equal(look("Cold War Bunker", "modern"), "station_corridor", "a bunker anywhere");

  // ── Through the routes ──
  const game = gameOf("high_fantasy", 21);
  const settlements = game.world.places.filter((place) => place.rank !== undefined);
  const city = settlements.reduce((best, place) => (place.rank! > best.rank! ? place : best));
  const standIn = createServer(async (req, res) => {
    for await (const _chunk of req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Dark." } }],
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
    const chat = await chats.create({ name: "Mine", mode: "game", characterIds: [], connectionId: connection!.id });
    const chatId = chat.id;
    await chats.patchMetadata(chatId, {
      gameId: `mine-${chatId}`,
      gameSessionStatus: "active",
      gameIntroPresented: true,
      gameWorldKit: game.kit,
      gameWorld: { seed: game.seed, generatorVersion: WORLD_GENERATOR_VERSION, grounding: "expand", brief: game.brief },
      gameTime: { day: 1, hour: 10, minute: 0 },
    });
    await chats.createMessage({
      chatId,
      role: "assistant",
      content:
        `The gates. [place: name="${city.name}" result="ok"] ` +
        `[world: fact="place" name="The Old Mine" in="${city.name}" result="ok"] ` +
        `[world: fact="place" name="The Gilded Gull" in="${city.name}" result="ok"]`,
    });
    const meta = async () => JSON.parse((await chats.getById(chatId))!.metadata as string) as Record<string, any>;
    const read = async () => (await app.inject({ method: "GET", url: `/api/game/${chatId}/town` })).json().town;
    const visit = (to: string) =>
      app.inject({ method: "POST", url: `/api/game/${chatId}/town/visit`, payload: { to } });
    const enter = (at: string) => app.inject({ method: "POST", url: `/api/game/${chatId}/map/enter`, payload: { at } });
    const buildings = (await read()).buildings as Array<{ id: string; name?: string; placeId?: string }>;
    const mine = buildings.find((building) => building.name === "The Old Mine")!;
    const inn = buildings.find((building) => building.name === "The Gilded Gull")!;
    assert.ok(mine && inn, "both places are buildings in town");

    assert.equal((await enter(mine.id)).statusCode, 400, "only where the party stands");
    assert.equal((await visit(mine.id)).statusCode, 200);
    const entered = await enter(mine.id);
    assert.equal(entered.statusCode, 200, entered.body);
    const map = entered.json().map;
    assert.equal(map.name, "The Old Mine");
    assert.equal(map.set, "cave_rock");
    assert.equal(map.place, mine.placeId, "kept with the place");
    assert.deepEqual(map.at, map.entrance, "in at the way in");
    assert.equal((await meta()).gameDungeonMap.id, map.id);
    assert.equal((await meta()).gameDungeonView, "map");
    assert.equal((await enter(mine.id)).json().map.id, map.id, "the same map while the party is on it");

    // The next turn tells the Game Master the map.
    const turn = await app.inject({
      method: "POST",
      url: "/api/generate/",
      payload: { chatId, userMessage: "We light a lamp.", streaming: false },
    });
    assert.equal(turn.statusCode, 200, turn.body);
    assert.equal((await meta()).gameDungeonMap.id, map.id, "a turn keeps it");

    // Out by the way in: back in town, at the mine.
    assert.equal(map.props[map.at.y * map.width + map.at.x], String(DUNGEON_EXIT_PROP));
    const left = await app.inject({ method: "POST", url: `/api/game/${chatId}/map/leave`, payload: { map: map.id } });
    assert.equal(left.statusCode, 200, left.body);
    assert.equal((await meta()).gameDungeonMap, null);
    assert.equal((await read()).at, mine.id, "the party stands where it went down");
    const again = (await enter(mine.id)).json().map;
    assert.notEqual(again.id, map.id, "a new visit");
    assert.equal(again.ground, map.ground, "the same place, the same map");

    // An inn is not one to go down into.
    await app.inject({ method: "POST", url: `/api/game/${chatId}/map/leave`, payload: { map: again.id } });
    assert.equal((await visit(inn.id)).statusCode, 200);
    assert.equal((await enter(inn.id)).statusCode, 400, "no going down in an inn");
    assert.equal((await meta()).gameDungeonMap, null);
  } finally {
    await app.close();
    await closeDB();
    await new Promise<void>((resolve) => standIn.close(() => resolve()));
  }

  console.log("Map places: caves, mines and crypts in town are gone down into, and left back into town.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
