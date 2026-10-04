// ──────────────────────────────────────────────
// Inside a building (worldgen W13): the rooms behind a town building's door, furnished for what the
// building is: a home sleeps the people who live there, a workplace seats the people who work there,
// a temple has its altar and benches, a tavern its counter and tables. Its size follows what it holds,
// never a fixed table; its variations (which side the second room is on, where the hearth stands) come
// from a stream of its own, so nothing else in the world moves. Pure: the same building gives the same
// rooms. A quarter, a district or a neighbourhood is a part of town, not a building: it has none.
//
// Rooms are laid out when asked for, never kept in a world's snapshot (W11): a world holds a thousand or
// more buildings, most of them homes nobody named, and the rooms are what the party sees and what the
// Game Master is told in words, not world state. `WORLD_INTERIOR_VERSION` and the world-interiors lane's
// pinned rooms keep them from changing under a world unnoticed: a change to the layout bumps the
// version on purpose. Rooms laid out by hand (W13b) are kept in the world's hand edits.
// ──────────────────────────────────────────────
import { worldStream } from "./compile.js";
import type { GameWorld } from "./game-world.js";
import type { WorldPerson } from "./people.js";
import { worldTownWhere, type WorldTown, type WorldTownBuilding } from "./town.js";

/** Bumped whenever a building's rooms would lay out differently. */
export const WORLD_INTERIOR_VERSION = 1;

export const WORLD_INTERIOR_USES = Object.freeze([
  "home",
  "hall",
  "tavern",
  "shop",
  "workshop",
  "worship",
  "clinic",
  "guard",
  "study",
  "training",
  "store",
  "workroom",
] as const);
export type WorldInteriorUse = (typeof WORLD_INTERIOR_USES)[number];

/** Furniture, by what it is; each setting family's tiles draw their own look of it. */
export const WORLD_FURNITURE = Object.freeze([
  "bed",
  "table",
  "chair",
  "counter",
  "shelf",
  "hearth",
  "crate",
  "barrel",
  "altar",
  "bench",
  "workbench",
  "furnace",
  "desk",
  "bookshelf",
  "rack",
  "rug",
  "plant",
  "lamp",
] as const);
export type WorldFurniture = (typeof WORLD_FURNITURE)[number];

export const WORLD_INTERIOR_ROOMS = Object.freeze(["main", "sleep", "back"] as const);
export type WorldInteriorRoom = (typeof WORLD_INTERIOR_ROOMS)[number];

export interface WorldInterior {
  buildingId: string;
  use: WorldInteriorUse;
  /** Cells across and down, walls included. */
  width: number;
  height: number;
  /** One character per cell, row by row: "#" wall, "." floor, "d" a doorway between rooms, "D" the way out. */
  ground: string;
  /** The way out, in the bottom wall: where the party stands on coming in. */
  door: { x: number; y: number };
  rooms: Array<{ x: number; y: number; w: number; h: number; use: WorldInteriorRoom }>;
  furniture: Array<{ x: number; y: number; kind: WorldFurniture }>;
  /** Where each person who belongs here is while here, by person id: a work spot, or their bed. */
  seats: Record<string, { x: number; y: number }>;
}

/** What a workplace or a place is furnished as, by the words of its trade, its name and its tags. The
 *  lists reach across settings: an inn, a teahouse, a saloon and a cantina are all taverns. The first
 *  list that matches wins. */
const USE_WORDS: ReadonlyArray<readonly [WorldInteriorUse, RegExp]> = [
  [
    "tavern",
    /\b(inns?|innkeepers?|taverns?|alehouses?|pubs?|bars?|barkeeps?|bartenders?|saloons?|speakeasy|speakeasies|cantinas?|teahouses?|tea ?houses?|wine ?shops?|izakayas?|caf[eé]s?|coffee ?houses?|coffee ?shops?|diners?|restaurants?|canteens?|mess ?halls?|hostels?|hotels?|motels?|brewers?|brewery|breweries|cooks?|noodle|dumpling|baristas?|boarding ?houses?|clubs?|nightclubs?|capsule)\b/i,
  ],
  [
    "worship",
    /\b(temples?|shrines?|churche?s?|chapels?|cathedrals?|abbey|abbeys|monaster(?:y|ies)|mosques?|synagogues?|pagodas?|sanctuar(?:y|ies)|oracles?|priests?|priestess(?:es)?|monks?|nuns?|clerics?|shamans?|chaplains?|imams?|rabbis?|faith|holy|sacred|daoist|taoist|buddhist)\b/i,
  ],
  [
    "clinic",
    /\b(clinics?|hospitals?|infirmar(?:y|ies)|apothecar(?:y|ies)|pharmac(?:y|ies)|pharmacists?|med ?bays?|surger(?:y|ies)|surgeons?|healers?|herbalists?|doctors?|physicians?|medics?|nurses?|alchemists?|medicine|ripperdocs?)\b/i,
  ],
  [
    "guard",
    /\b(guards?|barracks|garrisons?|watch ?houses?|watchmen|police|sheriffs?|constables?|militia|soldiers?|patrols?|security|marshals?|forts?|outposts?|enforcers?|wardens?|yamen|cops?|sentr(?:y|ies)|bouncers?|gate ?watchers?)\b/i,
  ],
  [
    "study",
    /\b(librar(?:y|ies)|librarians?|archives?|archivists?|schools?|academ(?:y|ies)|colleges?|universit(?:y|ies)|scriptorium|observator(?:y|ies)|labs?|laborator(?:y|ies)|scholars?|scribes?|teachers?|tutors?|sages?|scientists?|researchers?|mages?|wizards?|astrologers?|offices?|professors?|bureaucrats?|diplomats?|archaeologists?|reporters?|journalists?|netrunners?|hackers?|radio)\b/i,
  ],
  [
    "training",
    /\b(dojos?|training ?halls?|martial ?halls?|sects?|sect ?halls?|gyms?|gymnasi(?:um|a)|arenas?|fencing|sword ?schools?|disciples?|drill ?yards?|boxing)\b/i,
  ],
  [
    "store",
    /\b(farmers?|farms?|farmland|fishers?|fishermen|fisherm[ae]n|fishing|miners?|mines?|mining|woodcutters?|lumberjacks?|hunters?|gardeners?|gardens?|groundskeepers?|scavengers?|boatm[ae]n|boats?|sailors?|dockhands?|stablehands?|stables?|granar(?:y|ies)|warehouses?|storehouses?|depots?|silos?|barns?|sheds?|scrapyards?|rangers?|herders?|shepherds?)\b/i,
  ],
  [
    "workshop",
    /\b(smiths?|blacksmiths?|forges?|smith(?:y|ies)|workshops?|carpenters?|joiners?|masons?|potters?|weavers?|tailors?|tanners?|cobblers?|crafters?|craftsm[ae]n|artisans?|mechanics?|engineers?|garages?|factor(?:y|ies)|mills?|millers?|foundr(?:y|ies)|fabricators?|machinists?|tinkers?|tinkerers?|technicians?|repair|armou?rers?|weaponsmiths?|jewell?ers?|workers?|labou?rers?|builders?|shipwrights?|wrights?|dock(?:s|yards?)?)\b/i,
  ],
  [
    "shop",
    /\b(shops?|shopkeepers?|stores?|markets?|bazaars?|souks?|stalls?|merchants?|traders?|trading|vendors?|grocers?|bakers?|baker(?:y|ies)|butchers?|chandlers?|pawn|emporium|boutiques?|dealers?|brokers?|sellers?|peddlers?|pedlars?|hawkers?|booksellers?|hairdressers?|barbers?|florists?|clerks?)\b/i,
  ],
];

/** Fewest and most floor cells across and down a room. */
const MAIN_W = [5, 15] as const;
const MAIN_H = [4, 8] as const;
/** The most beds or work spots a building lays out. */
const MOST_PEOPLE = 8;

const clamp = (value: number, [low, high]: readonly [number, number]) => Math.max(low, Math.min(high, value));

/** The words of a part of town rather than a building: a place on such a layer has no rooms. */
const PART_OF_TOWN =
  /\b(quarters?|districts?|neighbou?rhoods?|wards?|boroughs?|sectors?|zones?|precincts?|parishes?|suburbs?|outskirts|areas?|levels?|decks?|rings?|blocks?|streets?|squares?|plazas?|parks?|docks?|harbou?rs?|ports?|beach(?:es)?|grounds?|fields?|woods?|forests?|cemeter(?:y|ies)|graveyards?)\b/i;

/** What a building is furnished as, from the words of its place's tags first, then its trade, then its
 *  name (each on whole words); `tags` are its world place's, when it is one. */
export function worldInteriorUse(
  building: Pick<WorldTownBuilding, "kind" | "role" | "name">,
  tags: readonly string[] = [],
): WorldInteriorUse {
  if (building.kind === "home") return "home";
  if (building.kind === "landmark") return "hall";
  for (const words of [tags.join(" ").replace(/_/g, " "), building.role ?? "", building.name ?? ""]) {
    if (!words) continue;
    for (const [use, pattern] of USE_WORDS) if (pattern.test(words)) return use;
  }
  return building.kind === "place" ? "hall" : "workroom";
}

/** Whether a building has rooms: not when it stands for a part of town (a quarter, a district), by its
 *  place's layer in the kit or, for a place the story added, its name. */
export function worldBuildingHasRooms(game: GameWorld, building: WorldTownBuilding): boolean {
  if (building.kind !== "place") return true;
  const place = building.placeId ? game.world.places.find((each) => each.id === building.placeId) : undefined;
  const layer = place ? game.kit.layers.find((each) => each.id === place.layer) : undefined;
  if (layer) return !PART_OF_TOWN.test(`${layer.label} ${layer.id}`);
  // A place the story added has only its name: "the Old Quarter" is a part of town, "the Harbour Inn" a
  // building.
  const name = building.name ?? "";
  return !PART_OF_TOWN.test(name) || USE_WORDS.some(([, pattern]) => pattern.test(name));
}

/** A building's rooms, laid out now. Null for no such building, or one that is a part of town. */
export function worldInterior(game: GameWorld, town: WorldTown, buildingId: string): WorldInterior | null {
  const building = town.buildings.find((each) => each.id === buildingId);
  if (!building || !worldBuildingHasRooms(game, building)) return null;
  return layOutInterior(game, town, building);
}

type Item = { kind: WorldFurniture; where: "wall" | "floor" | "side"; for?: string; seat?: "below" | "above" | "on" };

/** A building's rooms laid out from the seed and what it holds. */
export function layOutInterior(game: GameWorld, town: WorldTown, building: WorldTownBuilding): WorldInterior {
  const random = worldStream(game.seed, "interior", town.settlementId, building.id);
  const place = building.placeId ? game.world.places.find((each) => each.id === building.placeId) : undefined;
  const use = worldInteriorUse(building, place?.tags);
  const tier = Math.min(3, Math.max(0, Math.round((town.width - 22) / 10)));
  const homeOf = (id: string) => town.homeOf[id] === building.id;
  const workOf = (id: string) => town.workOf[id] === building.id;
  // Room for so many and no more: a home where too many share, or a hall every keeper in town sits in,
  // seats the first of them (the rest are about the place, unseated).
  const residents = building.people.filter(homeOf).slice(0, MOST_PEOPLE);
  const workers = building.people
    .filter((id) => workOf(id) || (!homeOf(id) && building.kind !== "home"))
    .slice(0, MOST_PEOPLE);

  // ── What it holds, in the order it is placed: the main room's, then the second room's ──
  const main: Item[] = [];
  const second: Item[] = [];
  let secondUse: WorldInteriorRoom | null = null;
  const each = (count: number, make: (index: number) => Item) => {
    for (let index = 0; index < count; index++) main.push(make(index));
  };
  const staff = (kind: WorldFurniture, seat: Item["seat"], where: Item["where"] = "floor") =>
    workers.forEach((id) => main.push({ kind, where, for: id, seat }));
  switch (use) {
    case "home": {
      main.push({ kind: "hearth", where: "wall" }, { kind: "shelf", where: "wall" }, { kind: "table", where: "floor" });
      secondUse = "sleep";
      const beds = Math.max(1, residents.length || 2);
      for (let index = 0; index < beds; index++)
        second.push({ kind: "bed", where: "wall", for: residents[index], seat: "on" });
      second.push({ kind: "crate", where: "side" });
      break;
    }
    case "tavern":
      main.push({ kind: "hearth", where: "wall" }, { kind: "barrel", where: "wall" }, { kind: "shelf", where: "wall" });
      staff("counter", "above");
      each(2 + tier, () => ({ kind: "table", where: "floor" }));
      secondUse = "back";
      second.push(
        { kind: "barrel", where: "wall" },
        { kind: "barrel", where: "wall" },
        { kind: "crate", where: "side" },
      );
      break;
    case "shop":
      each(2 + Math.min(2, tier), () => ({ kind: "shelf", where: "wall" }));
      staff("counter", "above");
      main.push({ kind: "crate", where: "side" }, { kind: "crate", where: "side" });
      secondUse = "back";
      second.push({ kind: "crate", where: "wall" }, { kind: "crate", where: "wall" }, { kind: "shelf", where: "side" });
      break;
    case "workshop":
      main.push({ kind: "furnace", where: "wall" }, { kind: "rack", where: "wall" });
      staff("workbench", "below");
      main.push({ kind: "crate", where: "side" });
      secondUse = "back";
      second.push(
        { kind: "crate", where: "wall" },
        { kind: "barrel", where: "wall" },
        { kind: "shelf", where: "side" },
      );
      break;
    case "worship":
      staff("altar", "below", "wall");
      if (workers.length === 0) main.push({ kind: "altar", where: "wall" });
      main.push({ kind: "lamp", where: "wall" }, { kind: "lamp", where: "wall" });
      each(2 + tier, () => ({ kind: "bench", where: "floor" }));
      break;
    case "clinic":
      main.push({ kind: "shelf", where: "wall" }, { kind: "shelf", where: "wall" });
      staff("table", "below");
      each(2 + tier, () => ({ kind: "bed", where: "side" }));
      break;
    case "guard":
      main.push({ kind: "rack", where: "wall" }, { kind: "rack", where: "wall" });
      staff("table", "below");
      secondUse = "sleep";
      for (let index = 0; index < Math.max(2, workers.length); index++) second.push({ kind: "bed", where: "wall" });
      break;
    case "study":
      each(2 + Math.min(2, tier), () => ({ kind: "bookshelf", where: "wall" }));
      staff("desk", "below");
      if (workers.length === 0) main.push({ kind: "desk", where: "floor" });
      main.push({ kind: "lamp", where: "side" });
      break;
    case "hall":
      main.push({ kind: "hearth", where: "wall" }, { kind: "rug", where: "floor" });
      staff("table", "below");
      each(Math.max(0, 2 - workers.length) + tier, () => ({ kind: "table", where: "floor" }));
      main.push({ kind: "plant", where: "side" });
      break;
    case "training":
      main.push({ kind: "rack", where: "wall" }, { kind: "rack", where: "wall" });
      each(1 + Math.min(2, tier), () => ({ kind: "rug", where: "floor" }));
      staff("bench", "below", "side");
      secondUse = "back";
      second.push({ kind: "crate", where: "wall" }, { kind: "barrel", where: "wall" });
      break;
    case "store":
      main.push({ kind: "rack", where: "wall" }, { kind: "shelf", where: "wall" });
      each(2 + tier, () => ({ kind: "crate", where: "floor" }));
      main.push({ kind: "barrel", where: "side" }, { kind: "barrel", where: "side" });
      workers.forEach((id) => main.push({ kind: "crate", where: "side", for: id, seat: "below" }));
      break;
    default:
      main.push({ kind: "shelf", where: "wall" });
      staff("workbench", "below");
      if (workers.length === 0) main.push({ kind: "table", where: "floor" });
      main.push({ kind: "crate", where: "side" });
      secondUse = "back";
      second.push({ kind: "crate", where: "wall" }, { kind: "shelf", where: "side" });
  }
  if (random() < 0.4) main.push({ kind: random() < 0.5 ? "plant" : "rug", where: random() < 0.5 ? "side" : "floor" });

  // ── How big: as wide as its wall and floor things need, as deep as its floor things ──
  const count = (items: Item[], where: Item["where"]) => items.filter((item) => item.where === where).length;
  // Floor things stand two apart (a chair or a seat between), in rows two apart.
  const mainFloor = count(main, "floor");
  const mainW = clamp(
    Math.max(count(main, "wall") + 2, Math.ceil(mainFloor / 2) * 2 + 1, 5 + (random() < 0.5 ? 1 : 0)),
    MAIN_W,
  );
  const floorRows = Math.ceil(mainFloor / Math.max(1, Math.floor((mainW - 1) / 2)));
  const mainH = clamp(3 + floorRows * 2 - (floorRows ? 1 : 0) + Math.ceil(count(main, "side") / 2 / 3), MAIN_H);
  const secondW = secondUse ? clamp(Math.ceil(count(second, "wall") / 2) + 2, [3, 8]) : 0;
  const height = mainH + 2;
  const width = mainW + 2 + (secondUse ? secondW + 1 : 0);

  // ── The walls, the rooms, the way out ──
  const cells = Array.from({ length: width * height }, () => "#");
  const secondLeft = secondUse ? random() < 0.5 : false;
  const mainX = secondLeft ? secondW + 2 : 1;
  const secondX = secondLeft ? 1 : mainW + 2;
  const rooms: WorldInterior["rooms"] = [{ x: mainX, y: 1, w: mainW, h: mainH, use: "main" }];
  if (secondUse) rooms.push({ x: secondX, y: 1, w: secondW, h: mainH, use: secondUse });
  for (const room of rooms)
    for (let y = room.y; y < room.y + room.h; y++)
      for (let x = room.x; x < room.x + room.w; x++) cells[y * width + x] = ".";
  const door = { x: mainX + Math.floor(mainW / 2) + (mainW > 6 ? Math.floor(random() * 3) - 1 : 0), y: height - 1 };
  cells[door.y * width + door.x] = "D";
  // The doorway between the rooms, low in their shared wall, near the way out.
  const between = secondUse ? { x: secondLeft ? mainX - 1 : mainX + mainW, y: mainH - Math.floor(random() * 2) } : null;
  if (between) cells[between.y * width + between.x] = "d";

  // ── The furniture ──
  const furniture: WorldInterior["furniture"] = [];
  const seats: WorldInterior["seats"] = {};
  const taken = new Set<number>();
  const key = (x: number, y: number) => y * width + x;
  // Kept clear: the way in and the step inside it, the walk up the room from it, and both sides of the
  // doorway between the rooms.
  for (let y = 1; y < height - 1; y++) taken.add(key(door.x, y));
  if (between) for (const dx of [-1, 1]) taken.add(key(between.x + dx, between.y));
  const isFloor = (x: number, y: number) => cells[key(x, y)] === ".";
  const free = (x: number, y: number) => isFloor(x, y) && !taken.has(key(x, y));
  /** Cells furniture stands on: what a person walks round. */
  const blocked = new Set<number>();
  const entry = key(door.x, door.y - 1);
  /** Whether a piece may stand here: free, and with it there every bit of open floor is still reached
   *  from the way in and every bed still has open floor beside it, so nothing and nobody is walled in. */
  const fits = (x: number, y: number) => {
    if (!free(x, y)) return false;
    const cell = key(x, y);
    blocked.add(cell);
    const seen = new Set<number>();
    const queue = [entry];
    while (queue.length) {
      const at = queue.pop()!;
      if (seen.has(at)) continue;
      seen.add(at);
      for (const next of [at + 1, at - 1, at + width, at - width]) {
        const c = cells[next];
        if ((c === "." || c === "d") && !blocked.has(next) && !seen.has(next)) queue.push(next);
      }
    }
    let ok = true;
    for (let at = 0; at < cells.length && ok; at++) {
      if (cells[at] !== "." && cells[at] !== "d") continue;
      if (!blocked.has(at)) ok = seen.has(at);
      else if (furniture.some((piece) => piece.kind === "bed" && key(piece.x, piece.y) === at) || at === cell)
        ok = [at + 1, at - 1, at + width, at - width].some((next) => seen.has(next));
    }
    blocked.delete(cell);
    return ok;
  };
  const put = (item: Item, x: number, y: number) => {
    furniture.push({ x, y, kind: item.kind });
    blocked.add(key(x, y));
    taken.add(key(x, y));
    if (!item.for) return;
    const at = item.seat === "on" ? { x, y } : item.seat === "above" ? { x, y: y - 1 } : { x, y: y + 1 };
    if (item.seat !== "on" && (!isFloor(at.x, at.y) || taken.has(key(at.x, at.y)))) return;
    seats[item.for] = at;
    taken.add(key(at.x, at.y));
  };
  const furnish = (room: (typeof rooms)[number], items: Item[]) => {
    const columns = Array.from({ length: room.w }, (_, index) => room.x + index);
    // Things against the back wall, spread from the middle out.
    const middle = room.x + Math.floor(room.w / 2);
    const byMiddle = [...columns].sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b);
    const counters = items.filter((item) => item.kind === "counter");
    const walls = items.filter((item) => item.where === "wall");
    const floors = items.filter((item) => item.where === "floor" && item.kind !== "counter");
    const sides = items.filter((item) => item.where === "side");
    // A counter is a run across the room two rows down from the back wall, its keepers behind it.
    if (counters.length) {
      const row = room.y + 2;
      const run: number[] = [];
      for (const x of byMiddle) if (run.length < Math.max(2, counters.length + 1) && free(x, row)) run.push(x);
      run
        .sort((a, b) => a - b)
        .forEach((x, index) => {
          const item = counters[index] ?? { kind: "counter" as const, where: "floor" as const };
          if (fits(x, row)) put(item, x, row);
        });
    }
    // Things against the back wall, and once it is full, along the side walls instead.
    for (const item of walls) {
      const row = room.y;
      const x = byMiddle.find(
        (column) => fits(column, row) && (!item.for || item.seat === "on" || free(column, row + 1)),
      );
      if (x !== undefined) put(item, x, row);
      else sides.unshift(item);
    }
    // Things standing on the floor, in rows two apart from the counter or the back wall down.
    const firstRow = room.y + (counters.length ? 4 : 2);
    let index = 0;
    for (let y = firstRow; y < room.y + room.h - 1 && index < floors.length; y += 2) {
      for (const x of byMiddle) {
        if (index >= floors.length) break;
        if (!fits(x, y)) continue;
        // Not side by side with another thing on the floor, so a chair or a person fits between.
        if (taken.has(key(x - 1, y)) && furniture.some((f) => f.x === x - 1 && f.y === y)) continue;
        if (taken.has(key(x + 1, y)) && furniture.some((f) => f.x === x + 1 && f.y === y)) continue;
        const item = floors[index++]!;
        put(item, x, y);
        // A table has a chair beside it when there is room.
        if (item.kind === "table" && !item.for) {
          const side = fits(x + 1, y) ? x + 1 : fits(x - 1, y) ? x - 1 : null;
          if (side !== null) put({ kind: "chair", where: "floor" }, side, y);
        }
      }
    }
    // Things along the side walls, from the back down.
    for (const item of sides) {
      let done = false;
      for (let y = room.y; y < room.y + room.h - 1 && !done; y++) {
        for (const x of [room.x, room.x + room.w - 1]) {
          if (!fits(x, y)) continue;
          put(item, x, y);
          done = true;
          break;
        }
      }
    }
  };
  furnish(rooms[0]!, main);
  if (rooms[1]) furnish(rooms[1], second);

  // Anyone who belongs here and found no spot stands somewhere free in the main room.
  for (const id of [...workers, ...residents]) {
    if (seats[id]) continue;
    const room = rooms[0]!;
    outer: for (let y = room.y + 1; y < room.y + room.h; y++)
      for (let x = room.x; x < room.x + room.w; x++) {
        if (!free(x, y)) continue;
        seats[id] = { x, y };
        taken.add(key(x, y));
        break outer;
      }
  }

  return { buildingId: building.id, use, width, height, ground: cells.join(""), door, rooms, furniture, seats };
}

/** The people inside a building at an hour, each where they are in it. */
export function worldInteriorPeopleAt(
  town: WorldTown,
  interior: WorldInterior,
  hour: number,
): Array<{ person: WorldPerson; at: { x: number; y: number }; asleep: boolean }> {
  const out: Array<{ person: WorldPerson; at: { x: number; y: number }; asleep: boolean }> = [];
  for (const person of town.people) {
    if (worldTownWhere(town, person.id, hour) !== interior.buildingId) continue;
    const at = interior.seats[person.id];
    if (!at) continue;
    const night = hour < 7 || hour >= 21;
    out.push({ person, at, asleep: night && town.homeOf[person.id] === interior.buildingId });
  }
  return out;
}

const FURNITURE_WORDS: Record<WorldFurniture, [string, string]> = {
  bed: ["a bed", "beds"],
  table: ["a table", "tables"],
  chair: ["a chair", "chairs"],
  counter: ["a counter", "a long counter"],
  shelf: ["shelves", "shelves"],
  hearth: ["a hearth", "hearths"],
  crate: ["a crate", "crates"],
  barrel: ["a barrel", "barrels"],
  altar: ["an altar", "altars"],
  bench: ["a bench", "rows of benches"],
  workbench: ["a workbench", "workbenches"],
  furnace: ["a furnace", "furnaces"],
  desk: ["a desk", "desks"],
  bookshelf: ["a bookcase", "bookcases"],
  rack: ["a rack", "racks"],
  rug: ["a rug", "rugs"],
  plant: ["a plant", "plants"],
  lamp: ["a lamp", "lamps"],
};
/** A piece's words in a setting family, where they differ from the plain ones. */
const FAMILY_WORDS: Record<string, Partial<Record<WorldFurniture, [string, string]>>> = {
  wuxia: {
    hearth: ["a brazier", "braziers"],
    bench: ["a row of floor mats", "rows of floor mats"],
    bed: ["a sleeping mat", "sleeping mats"],
    furnace: ["a forge", "forges"],
    altar: ["an altar with incense", "altars with incense"],
  },
  modern: { hearth: ["a stove", "stoves"], furnace: ["a machine", "machines"], crate: ["a box", "boxes"] },
  jazz_age: { hearth: ["a fireplace", "fireplaces"], furnace: ["a boiler", "boilers"] },
  scifi: {
    hearth: ["a heater", "heaters"],
    furnace: ["a fabricator", "fabricators"],
    bed: ["a bunk", "bunks"],
    shelf: ["storage racks", "storage racks"],
    crate: ["a cargo crate", "cargo crates"],
  },
  wasteland: { hearth: ["a fire barrel", "fire barrels"], furnace: ["a scrap forge", "scrap forges"] },
};
const ROOM_WORDS: Record<WorldInteriorRoom, string> = {
  main: "a front room",
  sleep: "a room to sleep in",
  back: "a back room",
};

const list = (words: string[]) =>
  words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;

/** What the Game Master is told of a building's rooms, in words, in the setting family's words for its
 *  furniture: "Inside: a front room with a counter and shelves, and a back room with crates." Chairs and
 *  rugs go unsaid. A home is told as it is if the party is let in. English, as the rest of the prompt. */
export function worldInteriorWords(interior: WorldInterior, family?: string): string {
  const words = { ...FURNITURE_WORDS, ...(family ? FAMILY_WORDS[family] : undefined) };
  const parts = interior.rooms.map((room) => {
    const counts = new Map<WorldFurniture, number>();
    for (const piece of interior.furniture) {
      if (piece.kind === "chair" || piece.kind === "rug" || piece.kind === "plant" || piece.kind === "lamp") continue;
      if (piece.x < room.x || piece.x >= room.x + room.w || piece.y < room.y || piece.y >= room.y + room.h) continue;
      counts.set(piece.kind, (counts.get(piece.kind) ?? 0) + 1);
    }
    const things = [...counts].map(([kind, n]) => words[kind]![n > 1 ? 1 : 0]);
    const name = interior.rooms.length === 1 ? "one room" : ROOM_WORDS[room.use];
    return things.length ? `${name} with ${list(things)}` : name;
  });
  return `${interior.use === "home" ? "Inside, if the party is let in" : "Inside"}: ${list(parts)}.`;
}
