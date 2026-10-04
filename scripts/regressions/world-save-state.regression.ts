/**
 * A world's snapshot (worldgen W11): the world kept as data, so a game plays on in the same world after
 * the generator changes.
 *
 *   - For every starter kit, a world read back from its snapshot (through JSON, as storage keeps it) is the
 *     world as made: its places, its history, the people of every place, every town with the story's
 *     places added, and what the Game Master is told.
 *   - It is read without the generator: with its seed and name lists changed under it, every one of those
 *     is still the same.
 *   - A world with hand edits (places and people added, a person renamed, a town laid out by hand) and a
 *     place the story added in the same town reads back the same.
 *   - A damaged snapshot, or one from a later format, is refused.
 */
import assert from "node:assert/strict";

import {
  WORLD_GENERATOR_VERSION,
  WORLD_SNAPSHOT_VERSION,
  WORLD_STARTER_KITS,
  checkWorldBrief,
  gameWorldFromMetadata,
  gameWorldFromSnapshot,
  parseWorldKit,
  readWorldSnapshot,
  worldCast,
  worldEditsSchema,
  worldHistory,
  worldOverviewPromptText,
  worldPresent,
  worldSnapshot,
  worldTown,
  worldWhereYouAreText,
  type GameWorld,
  type WorldEdits,
  type WorldKit,
  type WorldPresent,
} from "../../packages/shared/src/index.js";

const NAMES = {
  given: ["Ama", "Tobin", "Hesk", "Mira", "Oswin", "Bryn", "Calla", "Doran", "Edda", "Fenn"],
  family: ["Holt", "Drey", "Marrow", "Vane", "Callow"],
};

const made = (kit: WorldKit, seed: number, edits?: WorldEdits): GameWorld => {
  const checked = checkWorldBrief(kit, {
    briefVersion: 1,
    premise: "A quiet season before trouble.",
    peopleNames: kit.cultures.map((culture) => ({ culture: culture.id, ...NAMES })),
  });
  assert.ok(checked.ok, JSON.stringify(checked));
  const game = gameWorldFromMetadata({
    gameWorldKit: kit,
    gameWorld: {
      seed,
      generatorVersion: WORLD_GENERATOR_VERSION,
      grounding: "expand",
      brief: checked.brief,
      ...(edits ? { edits } : {}),
    },
  });
  assert.ok(game, `${kit.id}: a world`);
  if (edits) assert.ok(game.edits, `${kit.id}: its edits fit`);
  return game;
};

/** Through JSON and back, as storage and files keep it. */
const stored = (game: GameWorld): GameWorld => {
  const read = readWorldSnapshot(JSON.parse(JSON.stringify(worldSnapshot(game))));
  assert.ok(read.ok, read.ok ? "" : read.issues.join("; "));
  return gameWorldFromSnapshot(read.snapshot);
};

/** A present with one place the story added in the start's settlement. */
const withStoryPlace = (game: GameWorld): WorldPresent => {
  const present = worldPresent(game, []);
  const start = game.world.places.find((place) => place.id === game.world.startId)!;
  const settlement = start.rank !== undefined ? start : game.world.places.find((place) => place.id === start.parentId)!;
  present.places.push({ id: "x1", name: "The Gilded Gull", parentId: settlement.id } as never);
  return present;
};

/** Everything a game reads of its world, as plain data. */
const reading = (game: GameWorld, present: WorldPresent) => {
  const settlements = game.world.places.filter((place) => place.rank !== undefined);
  const start = game.world.places.find((place) => place.id === game.world.startId)!;
  return {
    world: game.world,
    history: worldHistory(game),
    casts: game.world.places.map((place) => worldCast(game, place.id)),
    towns: settlements.map((place) => worldTown(game, place.id, present)),
    overview: worldOverviewPromptText(game),
    here: worldWhereYouAreText(game, { place: start, present }),
  };
};

// ── Every starter kit: the same world from its snapshot, and with its recipe changed under it ──
let largest = 0;
let storyPlaced = 0;
for (const raw of WORLD_STARTER_KITS) {
  const parsed = parseWorldKit(raw);
  assert.ok(parsed.ok);
  const live = made(parsed.kit, 20261004);
  const present = withStoryPlace(live);
  const expected = reading(live, present);
  const frozen = stored(live);
  assert.ok(frozen.frozen, `${raw.id}: read from its snapshot`);
  assert.deepEqual(reading(frozen, present), expected, `${raw.id}: the snapshot's world is the world as made`);
  // A town with no free lot and no empty home has no room for it.
  if (expected.towns.some((town) => town?.buildings.some((building) => building.id === "x1"))) storyPlaced++;
  // The recipe changed under it: a generator reading it would make another world.
  const tampered: GameWorld = {
    ...frozen,
    seed: frozen.seed + 1,
    brief: { ...frozen.brief, peopleNames: [] },
  };
  assert.deepEqual(reading(tampered, present), expected, `${raw.id}: nothing is made again from the recipe`);
  largest = Math.max(largest, JSON.stringify(worldSnapshot(live)).length);
}

assert.ok(storyPlaced >= WORLD_STARTER_KITS.length / 2, `the story's place stood in ${storyPlaced} towns`);

// ── A world with hand edits and a place the story added, in one town ──
{
  const parsed = parseWorldKit(WORLD_STARTER_KITS.find((each) => each.id === "high_fantasy")!);
  assert.ok(parsed.ok);
  const kit = parsed.kit;
  const base = made(kit, 31);
  const city = [...base.world.places]
    .filter((place) => place.rank !== undefined)
    .sort((a, b) => b.rank! - a.rank! || a.id.localeCompare(b.id))[0]!;
  const inner = kit.layers[kit.layers.findIndex((layer) => layer.settlements) + 1]!;
  const town = worldTown(base, city.id)!;
  const home = town.buildings.find((building) => building.kind === "home")!;
  const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const free = town.lots.filter((lot) => town.buildings.every((building) => !overlaps(building, lot)));
  const edits = worldEditsSchema.parse({
    editsVersion: 1,
    added: [{ id: "e1", name: "The Lantern", layer: inner.id, parentId: city.id, at: city.at }],
    addedPeople: [
      { id: `${city.id}-e1`, placeId: city.id, name: "Wren Hollis", role: "a cartographer" },
      { id: "e1-e1", placeId: "e1", name: "Pell Garrow" },
    ],
    people: [{ id: `${city.id}-1`, name: "Old Tomas" }],
    towns: [
      { settlement: city.id, moves: [{ building: home.id, x: free.at(-1)!.x, y: free.at(-1)!.y, w: free.at(-1)!.w }] },
    ],
  });
  const live = made(kit, 31, edits);
  const present = worldPresent(live, []);
  present.places.push({ id: "x1", name: "The Gilded Gull", parentId: city.id } as never);
  const frozen = stored(live);
  assert.deepEqual(reading(frozen, present), reading(live, present), "an edited world reads back the same");
  const laidOut = worldTown(frozen, city.id, present)!;
  const lantern = laidOut.buildings.findIndex((building) => building.id === "e1");
  const gull = laidOut.buildings.findIndex((building) => building.id === "x1");
  assert.ok(lantern >= 0 && gull > lantern, "the place added by hand stands before the story's");
  assert.equal(laidOut.buildings.find((building) => building.id === home.id)!.x, free.at(-1)!.x, "the move holds");
  assert.ok(
    laidOut.people.some((person) => person.name === "Wren Hollis"),
    "an added person lives in town",
  );
  assert.ok(
    laidOut.people.some((person) => person.name === "Old Tomas"),
    "a renamed person keeps the name",
  );
  assert.deepEqual(worldSnapshot(frozen), frozen.frozen, "a frozen world's snapshot is the one it was read from");
}

// ── A damaged snapshot, or a later one, is refused ──
{
  const parsed = parseWorldKit(WORLD_STARTER_KITS[0]!);
  assert.ok(parsed.ok);
  const snapshot = JSON.parse(JSON.stringify(worldSnapshot(made(parsed.kit, 5))));
  assert.equal(snapshot.snapshotVersion, WORLD_SNAPSHOT_VERSION);
  const refused = (change: (value: Record<string, unknown>) => void, words: RegExp) => {
    const value = structuredClone(snapshot);
    change(value);
    const read = readWorldSnapshot(value);
    assert.ok(!read.ok, `refused: ${words}`);
    assert.match(read.issues.join(" "), words);
  };
  refused((value) => (value.snapshotVersion = WORLD_SNAPSHOT_VERSION + 1), /newer version/);
  refused((value) => ((value.compiled as { ground: string }).ground += "0"), /ground does not fill/);
  refused((value) => (value.extra = true), /extra|Unrecognized/i);
  refused((value) => ((value.kit as { id: unknown }).id = 5), /snapshot\.kit/);
  refused((value) => delete value.history, /history/);
  assert.equal(readWorldSnapshot(null).ok, false);
}

console.log(`world-save-state regression passed (largest snapshot ${Math.round(largest / 1024)} KB)`);
