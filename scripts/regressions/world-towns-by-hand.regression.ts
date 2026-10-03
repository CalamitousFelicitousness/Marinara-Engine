/**
 * Towns laid out by hand (worldgen W9h).
 *
 *   - A town's hand layout lives in the world's hand edits: buildings moved between the town's lots (to a
 *     free one, or swapped with the building on it), and its ground painted (street, square, open ground,
 *     a tree, a well), never over a building or the street before its door.
 *   - A moved building keeps its id, its people and who lives and works there; its door is its new lot's,
 *     so a walk across town is timed from there. Buildings never overlap, and every door is on a street.
 *   - A layout is checked when it is saved (each refusal says why), applied as far as it fits when it is
 *     read, and left out on its own when a world file brings one that does not fit. The story's places
 *     still find their lots.
 *   - Editors read a town without its own layout, with its lots, for a game's world and a library one.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WORLD_GENERATOR_VERSION,
  WORLD_STARTER_KITS,
  checkWorldBrief,
  compileGameWorld,
  parseWorldKit,
  readWorldFile,
  readWorldLedger,
  worldEditsEmpty,
  worldEditsSchema,
  worldFile,
  worldPresent,
  worldTown,
  worldTownEditIssues,
  worldTownMinutes,
  type GameWorld,
  type WorldEdits,
  type WorldTown,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-world-towns-by-hand-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";

const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "high_fantasy")!);
assert.ok(parsed.ok);
const kit = parsed.kit;
const settlementLayer = kit.layers.find((layer) => layer.settlements)!;
const checked = checkWorldBrief(kit, {
  briefVersion: 1,
  premise: "A river kingdom",
  places: [{ name: "Ashford", layer: settlementLayer.id, size: kit.sizes.at(-1)!.id, tags: [], start: true }],
  peopleNames: kit.cultures.map((culture) => ({
    culture: culture.id,
    given: ["Ama", "Tobin", "Hesk", "Mira", "Oswin", "Bryn", "Calla", "Doran"],
    family: ["Holt", "Drey", "Marrow", "Vane"],
  })),
});
assert.ok(checked.ok, JSON.stringify(checked));
const stored = {
  seed: 31,
  generatorVersion: WORLD_GENERATOR_VERSION,
  grounding: "expand" as const,
  brief: checked.brief,
};
const inputs = { kit, ...stored };
const game: GameWorld = { ...inputs, world: compileGameWorld(inputs) };
const ashford = game.world.places.find((place) => place.name === "Ashford")!;
const province = game.world.places.find((place) => place.id === ashford.parentId)!;
const withEdits = (edits: WorldEdits): GameWorld => ({
  ...inputs,
  edits,
  world: compileGameWorld({ ...inputs, edits }),
});
const layer = (town: Record<string, unknown>): WorldEdits =>
  worldEditsSchema.parse({ editsVersion: 1, towns: [{ settlement: ashford.id, ...town }] });

const asMade = worldTown(game, ashford.id)!;
assert.ok(asMade.buildings.length > 6 && asMade.lots.length > asMade.buildings.length, "a town with room");
const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const sameRect = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
/** Buildings never overlap, each stands on one of the town's lots, every door is on a street or the square. */
const wellLaidOut = (town: WorldTown) => {
  town.buildings.forEach((building, index) => {
    assert.ok(
      town.lots.some((lot) => sameRect(lot, building)),
      `${building.id} stands on a lot`,
    );
    for (const other of town.buildings.slice(index + 1)) assert.ok(!overlaps(building, other), building.id);
    assert.match(town.ground[building.door.y * town.width + building.door.x]!, /[sq]/, `${building.id}'s door`);
  });
};
wellLaidOut(asMade);
const free = asMade.lots.filter((lot) => asMade.buildings.every((building) => !overlaps(building, lot)));
assert.ok(free.length > 0, "free lots");
const [first, second] = asMade.buildings.filter((building) => building.kind === "home");
assert.ok(first && second);

// ── Moved to a free lot: the same building, its door the lot's, its walks timed from there ──
const target = free[free.length - 1]!;
const moved = worldTown(withEdits(layer({ moves: [{ building: first.id, x: target.x, y: target.y }] })), ashford.id)!;
const movedHome = moved.buildings.find((building) => building.id === first.id)!;
assert.deepEqual(
  { x: movedHome.x, y: movedHome.y, w: movedHome.w, h: movedHome.h, door: movedHome.door },
  { x: target.x, y: target.y, w: target.w, h: target.h, door: target.door },
);
assert.deepEqual(movedHome.people, first.people, "its people with it");
assert.deepEqual(moved.homeOf, asMade.homeOf);
const square = {
  x: asMade.square.x + Math.floor(asMade.square.w / 2),
  y: asMade.square.y + Math.floor(asMade.square.h / 2),
};
assert.equal(
  worldTownMinutes(moved, "square", first.id),
  Math.max(1, Math.round((Math.abs(target.door.x - square.x) + Math.abs(target.door.y - square.y)) / 4)),
);
wellLaidOut(moved);
assert.deepEqual(worldTown(withEdits(layer({ moves: [] })), ashford.id, undefined, { byHand: false }), asMade);

// ── Moved onto another building's lot: the two swap ──
const swapped = worldTown(withEdits(layer({ moves: [{ building: first.id, x: second.x, y: second.y }] })), ashford.id)!;
const [a, b] = [first.id, second.id].map((id) => swapped.buildings.find((building) => building.id === id)!);
assert.ok(sameRect(a!, second) && sameRect(b!, first));
assert.deepEqual([a!.door, b!.door], [second.door, first.door]);
wellLaidOut(swapped);

// ── The ground painted, never over a building or a door ──
const openCells = [...asMade.ground]
  .map((cell, index) => ({ cell, index }))
  .filter(
    ({ cell, index }) =>
      cell === "." &&
      asMade.buildings.every((building) => {
        const x = index % asMade.width;
        const y = Math.floor(index / asMade.width);
        return !overlaps(building, { x, y, w: 1, h: 1 });
      }),
  )
  .map(({ index }) => index);
const paint = (marks: Record<number, string>) =>
  Array.from({ length: asMade.ground.length }, (_, index) => marks[index] ?? ".").join("");
const [treeAt, wellAt, streetAt] = openCells;
const painted = worldTown(
  withEdits(layer({ ground: paint({ [treeAt!]: "t", [wellAt!]: "w", [streetAt!]: "s" }) })),
  ashford.id,
)!;
assert.deepEqual([painted.ground[treeAt!], painted.ground[wellAt!], painted.ground[streetAt!]], ["t", "w", "s"]);
assert.ok(
  [...painted.ground].every(
    (cell, index) => [treeAt, wellAt, streetAt].includes(index) || cell === asMade.ground[index],
  ),
  "and nothing else",
);
wellLaidOut(painted);

// ── Each refusal says why ──
const issues = (town: Record<string, unknown>) => worldTownEditIssues(game, layer(town));
const roof = first.y * asMade.width + first.x;
const door = first.door.y * asMade.width + first.door.x;
assert.deepEqual(issues({ moves: [{ building: first.id, x: target.x, y: target.y }] }), []);
assert.deepEqual(issues({ moves: [{ building: "h999", x: target.x, y: target.y }] }), [
  'Ashford: no building "h999" in town.',
]);
assert.deepEqual(
  issues({
    moves: [
      { building: first.id, x: target.x, y: target.y },
      { building: first.id, x: second.x, y: second.y },
    ],
  }),
  [`Ashford: "${first.id}" is moved twice.`],
);
assert.deepEqual(issues({ moves: [{ building: first.id, x: 0, y: 0 }] }), ["Ashford: no lot at 0, 0."]);
const partly = asMade.lots.find((lot) =>
  asMade.buildings.some((building) => overlaps(building, lot) && !sameRect(building, lot)),
);
assert.ok(partly, "a lot partly under a building");
assert.match(issues({ moves: [{ building: first.id, x: partly.x, y: partly.y }] })[0]!, /is partly under/);
assert.deepEqual(issues({ ground: "t" }), [
  `Ashford: the painted ground has 1 cells; the town has ${asMade.ground.length}.`,
]);
assert.match(
  issues({ ground: paint({ [roof]: "t" }) })[0]!,
  /a building or the street before its door is painted over/,
);
assert.match(issues({ ground: paint({ [door]: "o" }) })[0]!, /painted over at column \d+, row \d+/);
assert.deepEqual(
  worldTownEditIssues(game, worldEditsSchema.parse({ editsVersion: 1, towns: [{ settlement: province.id }] })),
  [`No settlement "${province.id}" to lay out.`],
);
assert.match(
  worldTownEditIssues(
    game,
    worldEditsSchema.parse({ editsVersion: 1, towns: [{ settlement: ashford.id }, { settlement: ashford.id }] }),
  ).join(" "),
  /laid out twice/,
);
assert.ok(!worldEditsSchema.safeParse({ editsVersion: 1, towns: [{ settlement: ashford.id, ground: "x" }] }).success);
assert.equal(worldEditsEmpty(layer({ ground: "" })), false, "a layer of a town alone is kept");
// A layout that no longer fits is applied as far as it does: the move, but not the paint on a roof.
const secondRoof = second.y * asMade.width + second.x;
const partlyFits = worldTown(
  withEdits(
    layer({
      moves: [{ building: first.id, x: target.x, y: target.y }],
      ground: paint({ [secondRoof]: "t", [treeAt!]: "t" }),
    }),
  ),
  ashford.id,
)!;
assert.ok(
  sameRect(
    partlyFits.buildings.find((building) => building.id === first.id)!,
    target,
  ),
);
assert.equal(partlyFits.ground[treeAt!], "t");
assert.equal(partlyFits.ground[secondRoof], asMade.ground[secondRoof], "never under a roof");

// ── The story's places still find their lots, the hand layout holding ──
const present = worldPresent(game, readWorldLedger([`[world: fact="place" name="The Gull" in="Ashford" result="ok"]`]));
const storied = worldTown(
  withEdits(layer({ moves: [{ building: first.id, x: target.x, y: target.y }] })),
  ashford.id,
  present,
)!;
assert.ok(
  storied.buildings.some((building) => building.name === "The Gull"),
  "the story's place is in town",
);
assert.ok(
  sameRect(
    storied.buildings.find((building) => building.id === first.id)!,
    target,
  ),
  "the move holds",
);
wellLaidOut(storied);

// ── A world file brings a layout that does not fit: it is left out, alone ──
const renamed = { id: ashford.id, name: "Ashford Keep" };
const unfitLayer = worldEditsSchema.parse({
  editsVersion: 1,
  places: [renamed],
  towns: [{ settlement: ashford.id, moves: [{ building: "h999", x: 1, y: 1 }] }],
});
const unfitFile = readWorldFile(JSON.stringify(worldFile("Unfit", kit, { ...stored, edits: unfitLayer })));
assert.ok(unfitFile.ok);
assert.deepEqual(unfitFile.world.edits, { editsVersion: 1, places: [renamed] });
assert.match(
  unfitFile.notes[0]!,
  /towns laid out by hand do not fit them, so they were left out: Ashford Keep: no building "h999"/,
);

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { gameWorldsRoutes } = await import("../../packages/server/src/routes/game-worlds.routes.js");

try {
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameRoutes, { prefix: "/api/game" });
  await app.register(gameWorldsRoutes, { prefix: "/api/game-worlds" });
  try {
    const chats = createChatsStorage(db);
    const chat = await chats.create({ name: "Towns", mode: "game", characterIds: [] });
    await chats.patchMetadata(chat.id, { gameWorldKit: kit, gameWorld: stored });
    const save = (towns: unknown[]) =>
      app.inject({
        method: "PUT",
        url: `/api/game/${chat.id}/world/edits`,
        payload: { edits: { editsVersion: 1, towns } },
      });
    const layout = {
      settlement: ashford.id,
      moves: [{ building: first.id, x: target.x, y: target.y }],
      ground: paint({ [treeAt!]: "t" }),
    };

    // Refused with the reason; saved; the play view lays the town out by hand.
    const refusedSave = await save([{ settlement: ashford.id, moves: [{ building: "h999", x: 1, y: 1 }] }]);
    assert.equal(refusedSave.statusCode, 400);
    assert.match(refusedSave.json().error, /Ashford: no building "h999" in town/);
    assert.equal((await save([layout])).statusCode, 200);
    const played = (await app.inject({ method: "GET", url: `/api/game/${chat.id}/town` })).json().town as WorldTown;
    assert.ok(
      sameRect(
        played.buildings.find((building) => building.id === first.id)!,
        target,
      ),
    );
    assert.equal(played.ground[treeAt!], "t");

    // The editor's town: as laid out without its own layout, with its lots, and that layout.
    const forEditor = (
      await app.inject({ method: "GET", url: `/api/game/${chat.id}/world/town?settlement=${ashford.id}` })
    ).json();
    assert.deepEqual(forEditor.layout, layout);
    assert.deepEqual(forEditor.town.buildings, asMade.buildings);
    assert.deepEqual(forEditor.town.lots, asMade.lots);
    assert.equal(forEditor.town.people, undefined, "no townsfolk sent to the editor");
    assert.equal(
      (await app.inject({ method: "GET", url: `/api/game/${chat.id}/world/town?settlement=${province.id}` }))
        .statusCode,
      404,
    );

    // It travels with the world: its file, and a library world made from it.
    const fileText = JSON.stringify(
      (await app.inject({ method: "GET", url: `/api/game/${chat.id}/world/file` })).json(),
    );
    const file = readWorldFile(fileText);
    assert.ok(file.ok && file.notes.length === 0, JSON.stringify(file));
    assert.deepEqual(file.world.edits?.towns, [layout]);
    const kept = await app.inject({ method: "POST", url: "/api/game-worlds/import", payload: { text: fileText } });
    assert.equal(kept.statusCode, 200, kept.body);
    const libraryTown = (
      await app.inject({
        method: "GET",
        url: `/api/game-worlds/${kept.json().world.id}/world/town?settlement=${ashford.id}`,
      })
    ).json();
    assert.deepEqual(libraryTown.layout, layout);
    const libraryRefused = await app.inject({
      method: "PUT",
      url: `/api/game-worlds/${kept.json().world.id}/world/edits`,
      payload: { edits: { editsVersion: 1, towns: [{ settlement: ashford.id, ground: "t" }] } },
    });
    assert.equal(libraryRefused.statusCode, 400);
    assert.match(libraryRefused.json().error, /the painted ground has 1 cells/);
  } finally {
    await app.close();
    await closeDB();
  }
  console.log("Towns by hand: buildings moved and swapped, ground painted, checked, kept with the world.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
