// ──────────────────────────────────────────────
// The town (worldgen W8b): a settlement laid out as streets, a square and buildings, from the seed. The
// places in it come first (the world's own places inside the settlement and those the story added), then
// its landmark, then the workplaces of the people whose trade fits what the place is known for, then
// homes for everyone. Each person has a home and, by day, a place to be. Lots are claimed nearest the
// crossroads first, as Pixelforge lays its towns out. Pure: the same world gives the same town.
// ──────────────────────────────────────────────
import { z } from "zod";
import { worldStream, type WorldPlace } from "./compile.js";
import { worldPersonByHand } from "./edits.js";
import type { GameWorld } from "./game-world.js";
import type { WorldPresent } from "./ledger.js";
import { WORLD_PEOPLE_DEFAULTS, worldCast, type WorldPerson } from "./people.js";

export const WORLD_TOWN_KINDS = Object.freeze(["landmark", "place", "work", "home"] as const);
export type WorldTownKind = (typeof WORLD_TOWN_KINDS)[number];

export interface WorldTownBuilding {
  id: string;
  kind: WorldTownKind;
  /** Its lot, in town cells; the roof is the top rows, the front the bottom row. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The street cell before its door. */
  door: { x: number; y: number };
  /** A world place it is (inside the settlement, or added by the story), and its name. */
  placeId?: string;
  name?: string;
  /** Work: the trade (the kit's word for the role) of the people who work here. */
  role?: string;
  /** Who lives here (a home) or works here (anything else). */
  people: string[];
}

export interface WorldTown {
  settlementId: string;
  width: number;
  height: number;
  /** One character per cell, row by row: "." open ground, "s" street, "q" the square. */
  ground: string;
  square: { x: number; y: number; w: number; h: number };
  buildings: WorldTownBuilding[];
  /** Each person's home and, if any, workplace, by building id. */
  homeOf: Record<string, string>;
  workOf: Record<string, string>;
  /** Everyone in town: the settlement's people and those of the places inside it. */
  people: WorldPerson[];
  /** Market stalls in the square, by cell. */
  stalls: Array<{ x: number; y: number }>;
}

/** Town cells across and down by size tier (a hamlet .. a city). */
const SIZES: ReadonlyArray<readonly [number, number]> = [
  [22, 16],
  [30, 20],
  [40, 28],
  [52, 36],
];
const SQUARES: ReadonlyArray<readonly [number, number]> = [
  [3, 3],
  [5, 3],
  [7, 5],
  [9, 7],
];
/** A lot: four wide and three deep facing a street that runs across, the other way facing one down. */
const LOT_ACROSS = { w: 4, h: 3 };
const LOT_DOWN = { w: 3, h: 4 };
/** How many people share a home. */
const PER_HOME = 3;
/** The share of the lots still free that the townsfolk the story never names live on, by size tier. */
const FILL = [0.3, 0.45, 0.6, 0.75];
/** A place known for trade (by the words of its tags) has stalls in its square. */
const TRADE = /market|bazaar|trade|souk|fair|merchant/;

/** The size tier of a settlement, 0 (the smallest on the kit's ladder) to 3 (the biggest). */
export function worldTownTier(game: GameWorld, place: WorldPlace): number {
  const top = Math.max(1, game.kit.sizes.length - 1);
  return Math.min(3, Math.floor(((place.rank ?? 0) * 3) / top));
}

/** The town a settlement is, laid out from the seed; null for a place that is not a settlement. */
export function worldTown(game: GameWorld, settlementId: string, present?: WorldPresent): WorldTown | null {
  const { world } = game;
  const settlement = world.places.find((place) => place.id === settlementId);
  if (!settlement || settlement.rank === undefined) return null;
  const tier = worldTownTier(game, settlement);
  const [width, height] = SIZES[tier]!;
  const random = worldStream(game.seed, "town", settlementId);
  const cells = Array.from({ length: width * height }, () => ".");
  const at = (x: number, y: number) => cells[y * width + x];
  const set = (x: number, y: number, c: string) => {
    if (x >= 0 && y >= 0 && x < width && y < height) cells[y * width + x] = c;
  };

  // ── Streets and the square ──
  const cx = Math.floor(width / 2) + Math.floor(random() * 3) - 1;
  const cy = Math.floor(height / 2) + Math.floor(random() * 3) - 1;
  const across = [cy, ...(tier >= 2 ? [cy - 9, cy + 9] : [])].filter((y) => y > 2 && y < height - 3);
  const down = [cx, ...(tier >= 2 ? [cx - 12, cx + 12] : [])].filter((x) => x > 2 && x < width - 3);
  for (const y of across) for (let x = 0; x < width; x++) set(x, y, "s");
  for (const x of down) for (let y = 0; y < height; y++) set(x, y, "s");
  const [sw, sh] = SQUARES[tier]!;
  const square = { x: cx - Math.floor(sw / 2), y: cy - Math.floor(sh / 2), w: sw, h: sh };
  for (let y = square.y; y < square.y + sh; y++) for (let x = square.x; x < square.x + sw; x++) set(x, y, "q");

  // ── Lots facing the streets, nearest the crossroads first ──
  const taken = new Set<number>();
  const free = (x: number, y: number, w: number, h: number) => {
    if (x < 1 || y < 1 || x + w > width - 1 || y + h > height - 1) return false;
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) if (at(xx, yy) !== "." || taken.has(yy * width + xx)) return false;
    return true;
  };
  type Lot = { x: number; y: number; w: number; h: number; door: { x: number; y: number } };
  const lots: Lot[] = [];
  for (const y of across) {
    for (let x = 1; x < width - LOT_ACROSS.w; x += LOT_ACROSS.w + 1) {
      // North of the street (door below it) and south of it (door above it).
      lots.push({ x, y: y - LOT_ACROSS.h, ...LOT_ACROSS, door: { x: x + 1, y } });
      lots.push({ x, y: y + 1, ...LOT_ACROSS, door: { x: x + 1, y } });
    }
  }
  for (const x of down) {
    for (let y = 1; y < height - LOT_DOWN.h; y += LOT_DOWN.h + 1) {
      lots.push({ x: x - LOT_DOWN.w, y, ...LOT_DOWN, door: { x, y: y + 2 } });
      lots.push({ x: x + 1, y, ...LOT_DOWN, door: { x, y: y + 2 } });
    }
  }
  const distance = (lot: Lot) => Math.abs(lot.door.x - cx) + Math.abs(lot.door.y - cy) + random() * 0.5;
  const ordered = lots.map((lot) => ({ lot, d: distance(lot) })).sort((a, b) => a.d - b.d);
  const claim = (): Lot | undefined => {
    for (const { lot } of ordered) {
      if (!free(lot.x, lot.y, lot.w, lot.h)) continue;
      for (let yy = lot.y; yy < lot.y + lot.h; yy++)
        for (let xx = lot.x; xx < lot.x + lot.w; xx++) taken.add(yy * width + xx);
      return lot;
    }
    return undefined;
  };

  // ── Who is in town ──
  const within = world.places.filter((place) => place.parentId === settlementId);
  const inside = within.filter((place) => !place.byHand);
  // Places the story added, then those added by hand (W9c): both go last, so the town never moves.
  const added = [
    ...(present?.places ?? []).filter((place) => place.parentId === settlementId),
    ...within.filter((place) => place.byHand),
  ];
  // People added by hand come after everyone drawn, so nobody already in town moves house.
  const cast = [settlement, ...within].flatMap((place) => worldCast(game, place.id));
  const people = [
    ...cast.filter((person) => !worldPersonByHand(person.id)),
    ...cast.filter((person) => worldPersonByHand(person.id)),
  ];
  const buildings: WorldTownBuilding[] = [];
  const homeOf: Record<string, string> = {};
  const workOf: Record<string, string> = {};
  // Ids say what a building is, so they hold as the story goes on: a place's own id, the hall, the n-th
  // workplace, the n-th home.
  const counts = { work: 0, home: 0 };
  const build = (kind: WorldTownKind, extra: Partial<WorldTownBuilding>): WorldTownBuilding | undefined => {
    const lot = claim();
    if (!lot) return undefined;
    const id =
      extra.placeId ?? (kind === "landmark" ? "hall" : kind === "work" ? `w${counts.work++}` : `h${counts.home++}`);
    const building: WorldTownBuilding = { id, kind, ...lot, people: [], ...extra };
    buildings.push(building);
    return building;
  };

  // The places in town first: the world's own (the story's and those added by hand come last, below).
  // Their people work there.
  for (const place of inside) {
    const building = build("place", { placeId: place.id, name: place.name });
    if (!building) break;
    for (const person of people) {
      if (person.placeId !== place.id) continue;
      building.people.push(person.id);
      workOf[person.id] = building.id;
    }
  }
  // The people of a place added by hand work there; its building comes last, below.
  for (const person of people) {
    if (within.some((place) => place.byHand && place.id === person.placeId)) workOf[person.id] = person.placeId;
  }
  // The landmark of a bigger place: where its keepers sit. Members of a group seated here work there.
  if (tier >= 2) {
    const landmark = build("landmark", {});
    if (landmark) {
      for (const person of people) {
        if (!person.group || workOf[person.id]) continue;
        landmark.people.push(person.id);
        workOf[person.id] = landmark.id;
      }
    }
  }
  // Workplaces for the trades the place is known for.
  const roles = game.kit.people?.roles ?? WORLD_PEOPLE_DEFAULTS.roles;
  const wanted = new Set(settlement.tags);
  for (const role of roles) {
    if (!role.tags?.some((tag) => wanted.has(tag))) continue;
    const workers = people.filter((person) => person.role === role.label && !workOf[person.id]);
    if (workers.length === 0) continue;
    const work = build("work", { role: role.label });
    if (!work) break;
    for (const person of workers) {
      work.people.push(person.id);
      workOf[person.id] = work.id;
    }
  }
  // Homes, a few to each, until the lots run out; then the rest share the homes there are.
  const homes: WorldTownBuilding[] = [];
  for (let start = 0; start < people.length; start += PER_HOME) {
    const home = build("home", {});
    if (!home) break;
    homes.push(home);
  }
  people.forEach((person, index) => {
    const home = homes[homes.length ? Math.floor(index / PER_HOME) % homes.length : 0];
    if (!home) return;
    home.people.push(person.id);
    homeOf[person.id] = home.id;
  });
  // The townsfolk the story never names: more of the free lots, the bigger the place.
  const open = ordered.filter(({ lot }) => free(lot.x, lot.y, lot.w, lot.h)).length;
  for (let left = Math.round(open * FILL[tier]!); left > 0; left--) if (!build("home", {})) break;
  // The places the story added, last, so the town as the world laid it out never moves: each takes the
  // next free lot, or else the home furthest out that nobody named lives in.
  for (const place of added) {
    let building = build("place", { placeId: place.id, name: place.name });
    if (!building) {
      const empty = [...buildings].reverse().find((each) => each.kind === "home" && each.people.length === 0);
      if (!empty) break;
      building = Object.assign(empty, { id: place.id, kind: "place" as const, placeId: place.id, name: place.name });
    }
    for (const person of people) if (person.placeId === place.id) building.people.push(person.id);
  }
  // Someone whose workplace found no lot is in the square by day.
  for (const [personId, at] of Object.entries(workOf)) {
    if (!buildings.some((building) => building.id === at)) delete workOf[personId];
  }
  // Stalls along the square's edges, for a place known for trade.
  const stalls: WorldTown["stalls"] = [];
  if (settlement.tags.some((tag) => TRADE.test(tag))) {
    for (let x = square.x; x < square.x + square.w; x += 2) {
      stalls.push({ x, y: square.y });
      if (square.h > 2) stalls.push({ x, y: square.y + square.h - 1 });
    }
  }

  return {
    settlementId,
    width,
    height,
    ground: cells.join(""),
    square,
    buildings,
    homeOf,
    workOf,
    people,
    stalls,
  };
}

/** Where a person is at an hour: at work by day (07-18), in the square at dusk (18-21), home at night.
 *  Someone with no workplace spends the day in the square. A building id, or "square". */
export function worldTownWhere(town: WorldTown, personId: string, hour: number): string {
  if (hour >= 7 && hour < 18) return town.workOf[personId] ?? "square";
  if (hour >= 18 && hour < 21) return "square";
  return town.homeOf[personId] ?? "square";
}

// ── A visit in town, told on the next turn ──

/** Town cells walked in a game minute. */
export const WORLD_TOWN_CELLS_PER_MINUTE = 4;

export const worldTownVisitSchema = z
  .object({
    id: z.string().min(1).max(64),
    settlementId: z.string().min(1).max(16),
    /** A building's id, or "square". */
    to: z.string().min(1).max(16),
    minutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
  })
  .strict();
export type WorldTownVisit = z.infer<typeof worldTownVisitSchema>;

/** Where in town the party stands: a building's id or "square", in one settlement. */
export const worldTownSpotSchema = z
  .object({ settlementId: z.string().min(1).max(16), at: z.string().min(1).max(16) })
  .strict();
export type WorldTownSpot = z.infer<typeof worldTownSpotSchema>;

export function worldTownVisitFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): WorldTownVisit | null {
  const parsed = worldTownVisitSchema.safeParse(metadata?.gameTownVisit);
  return parsed.success ? parsed.data : null;
}
export function worldTownSpotFromMetadata(metadata: Record<string, unknown> | null | undefined): WorldTownSpot | null {
  const parsed = worldTownSpotSchema.safeParse(metadata?.gameTownSpot);
  return parsed.success ? parsed.data : null;
}

/** The street cell a spot is entered from: a building's door, or the middle of the square. */
export function worldTownDoor(town: WorldTown, at: string): { x: number; y: number } | null {
  if (at === "square") {
    return { x: town.square.x + Math.floor(town.square.w / 2), y: town.square.y + Math.floor(town.square.h / 2) };
  }
  return town.buildings.find((building) => building.id === at)?.door ?? null;
}

/** The minutes a walk across town takes, from one spot to another (at least one). */
export function worldTownMinutes(town: WorldTown, from: string, to: string): number {
  const [a, b] = [worldTownDoor(town, from), worldTownDoor(town, to)];
  if (!a || !b) return 1;
  return Math.max(1, Math.round((Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) / WORLD_TOWN_CELLS_PER_MINUTE));
}

/** The people at a spot at an hour. */
export function worldTownPeopleAt(town: WorldTown, at: string, hour: number): WorldPerson[] {
  return town.people.filter((person) => worldTownWhere(town, person.id, hour) === at);
}

/** What the Game Master is told of a spot in words: a named place, a trade's workplace, the seat of
 *  the place's keepers, a home (and whose), or the square. */
function spotWords(town: WorldTown, at: string): string {
  if (at === "square") return "the square";
  const building = town.buildings.find((each) => each.id === at);
  if (!building) return "the square";
  if (building.name) return building.name;
  if (building.kind === "landmark") return "the hall where the place's keepers sit";
  if (building.kind === "work") return `the ${building.role ?? "workshop"}'s workplace`;
  const residents = building.people
    .map((id) => town.people.find((person) => person.id === id))
    .filter((person): person is WorldPerson => Boolean(person?.named));
  return residents.length ? `the home of ${residents.map((person) => person.name).join(" and ")}` : "a home";
}

/** What the Game Master is told of the visit its turn tells, with who is there at the hour. */
export function worldTownVisitText(game: GameWorld, town: WorldTown, visit: WorldTownVisit, hour: number): string {
  const settlement = game.world.places.find((place) => place.id === town.settlementId);
  const there = worldTownPeopleAt(town, visit.to, hour)
    .filter((person) => person.named)
    .slice(0, 6)
    .map((person) => `${person.name} (${person.role})`);
  return `In ${settlement?.name ?? "town"}, the party has walked to ${spotWords(town, visit.to)}.${
    there.length ? ` There now: ${there.join(", ")}.` : ""
  } That time is counted already: tell what the party finds there.`;
}

/** The place tag a visit to a named place carries, so the place in force is that place. */
export function worldTownVisitTags(town: WorldTown, visit: WorldTownVisit): string {
  const building = town.buildings.find((each) => each.id === visit.to);
  return building?.placeId && building.name ? `[place: name="${building.name}"]` : "";
}
