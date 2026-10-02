/**
 * The library of worlds (worldgen W9f).
 *
 *   - A world is made outside any game from a kit and a seed (the kit's summary its premise), or
 *     imported from a world file, and listed, renamed and removed. Writing to it is privileged.
 *   - It has the editor's routes a game's world has, the same shapes: the world as an editor draws it,
 *     hand edits checked against it (and its story), a place's people, its story with what a story can
 *     name, and its world file.
 *   - A game started from it takes a copy: editing the library world later never changes the game.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_STARTER_KITS,
  parseWorldKit,
  readWorldFile,
  worldFile,
  type GameWorldInput,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-library-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";

const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "high_fantasy")!);
assert.ok(parsed.ok);
const kit = parsed.kit;

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { gameWorldsRoutes } = await import("../../packages/server/src/routes/game-worlds.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");

try {
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameRoutes, { prefix: "/api/game" });
  await app.register(gameWorldsRoutes, { prefix: "/api/game-worlds" });
  try {
    const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
      app.inject({ method, url: `/api/game-worlds${url}`, ...(payload === undefined ? {} : { payload }) });

    // ── Made from a kit and a seed ──
    assert.equal(
      (await call("POST", "/", { name: "Riverlands", kit: { id: "x" } })).statusCode,
      400,
      "a kit that reads",
    );
    assert.equal((await call("POST", "/", { name: "", kit })).statusCode, 400, "a name");
    const made = await call("POST", "/", { name: "Riverlands", kit, seed: 4242 });
    assert.equal(made.statusCode, 200, made.body);
    const id = made.json().world.id as string;
    assert.match(id, /^w_[0-9a-f]{12}$/);
    assert.deepEqual(
      (await call("GET", "/"))
        .json()
        .worlds.map((world: Record<string, unknown>) => [
          world.name,
          world.kit,
          world.seed,
          world.edited,
          world.story,
          world.reads,
        ]),
      [["Riverlands", kit.label, 4242, false, false, true]],
    );
    // Writing is privileged: an untrusted host is refused.
    const untrusted = await app.inject({
      method: "POST",
      url: "/api/game-worlds",
      headers: { host: "evil.example" },
      payload: { name: "X", kit },
    });
    assert.equal(untrusted.statusCode, 421);

    // ── The editor's routes, as a game's world has them ──
    const edit = (await call("GET", `/${id}/world/edit`)).json();
    assert.ok(edit.world.places.length > 3 && edit.edits === null);
    const town = edit.world.places.find((place: { rank?: number }) => place.rank !== undefined);
    const people = (await call("GET", `/${id}/world/people?place=${town.id}`)).json().people;
    assert.ok(people.length > 0);
    const renamed = await call("PUT", `/${id}/world/edits`, {
      edits: {
        editsVersion: 1,
        places: [{ id: town.id, name: "Newhaven" }],
        addedPeople: [{ id: `${town.id}-e1`, placeId: town.id, name: "Odda Reed" }],
      },
    });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal(
      (await call("PUT", `/${id}/world/edits`, { edits: { editsVersion: 1, places: [{ id: "nowhere", name: "X" }] } }))
        .statusCode,
      400,
    );
    // A story meeting the person added by hand: edits that take her away are refused.
    const story = {
      storyVersion: 1,
      events: [{ id: "odda", when: { on: "meet", person: `${town.id}-e1` }, do: [{ tell: "Odda knows." }] }],
    };
    const told = await call("PUT", `/${id}/story`, { story });
    assert.equal(told.statusCode, 200, told.body);
    const storyRead = (await call("GET", `/${id}/story`)).json();
    assert.equal(storyRead.story.events[0].id, "odda");
    assert.equal(storyRead.state, null, "not played");
    assert.ok(
      storyRead.names.places.some((place: { name: string }) => place.name === "Newhaven"),
      "names as edited",
    );
    const away = await call("PUT", `/${id}/world/edits`, {
      edits: { editsVersion: 1, places: [{ id: town.id, name: "Newhaven" }] },
    });
    assert.equal(away.statusCode, 400);
    assert.match(away.json().error, /story names what these edits take away/);
    assert.equal(
      (
        await call("PUT", `/${id}/story`, {
          story: {
            storyVersion: 1,
            events: [{ id: "x", when: { on: "arrive", place: "p99999" }, do: [{ tell: "x" }] }],
          },
        })
      ).statusCode,
      400,
    );

    // ── Its world file: the kit, the world with its edits, and its story ──
    const fileText = JSON.stringify((await call("GET", `/${id}/world/file`)).json());
    const read = readWorldFile(fileText);
    assert.ok(read.ok && read.world.edits && read.story, JSON.stringify(read));
    assert.equal(read.world.seed, 4242);
    assert.deepEqual(
      (await call("GET", "/")).json().worlds.map((world: Record<string, unknown>) => [world.edited, world.story]),
      [[true, true]],
    );

    // ── A game made from it is a copy ──
    const created = await app.inject({
      method: "POST",
      url: "/api/game/create",
      payload: {
        name: "From the library",
        setupConfig: {
          genre: "Fantasy",
          setting: "A river kingdom",
          tone: "Grim",
          difficulty: "normal",
          rating: "sfw",
          playerGoals: "",
          gmMode: "standalone",
          partyCharacterIds: [],
          worldKit: read.kit,
          world: read.world as GameWorldInput,
          story: read.story,
        },
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    const chatId = created.json().sessionChat.id as string;
    const gameMeta = async () => JSON.parse((await createChatsStorage(db).getById(chatId))!.metadata as string);
    assert.deepEqual((await gameMeta()).gameWorld.edits, read.world.edits);
    assert.equal((await call("DELETE", `/${id}/story`)).statusCode, 200);
    assert.equal((await gameMeta()).gameStory.events[0].id, "odda", "the game keeps its own copy");

    // ── Renamed, imported, removed ──
    const renamedWorld = await call("PUT", `/${id}`, { name: "The Riverlands" });
    assert.equal(renamedWorld.json().world.name, "The Riverlands");
    assert.equal(
      readWorldFile(JSON.stringify((await call("GET", `/${id}/world/file`)).json())).ok &&
        JSON.parse(JSON.stringify((await call("GET", `/${id}/world/file`)).json())).name,
      "The Riverlands",
    );
    const imported = await call("POST", "/import", {
      text: JSON.stringify(worldFile("Imported", kit, read.world, read.story)),
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().world.story, true);
    assert.equal((await call("POST", "/import", { text: "{nope" })).statusCode, 400);
    assert.deepEqual(
      (await call("GET", "/")).json().worlds.map((world: { name: string }) => world.name),
      ["Imported", "The Riverlands"],
    );
    assert.equal((await call("DELETE", `/${id}`)).statusCode, 200);
    assert.equal((await call("GET", `/${id}/world/edit`)).statusCode, 404);
    assert.equal((await call("DELETE", `/${id}`)).statusCode, 404);
    assert.ok((await gameMeta()).gameWorld, "and the game plays on without it");
  } finally {
    await app.close();
    await closeDB();
  }
  console.log("World library: worlds made outside a game, edited and given a story, copied into new games.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
