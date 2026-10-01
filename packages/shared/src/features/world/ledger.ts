// ──────────────────────────────────────────────
// A world's ledger (worldgen W4): what the story does to the world. The Game Master writes a deed or a
// fact as a `[world: ...]` tag in its reply, answered in place against the world and the kinds of change
// it allows. The ledger is those answered tags in the visible replies, oldest first, so a swipe, a
// regeneration, a deleted message, a branch and a checkpoint all take a world change back or keep it,
// exactly as they do the place. Nothing is stored beside the replies. The present world is the compile,
// then the history, then the ledger folded over them; the seed never overwrites what the story did.
// ──────────────────────────────────────────────
import type { WorldChangeKind } from "../../schemas/world-kit.schema.js";
import { readGmTagAttributes } from "../../utils/skill-check-tag.js";
import { WORLD_PROSPERITIES, type WorldPlace, type WorldProsperity } from "./compile.js";
import type { GameWorld } from "./game-world.js";
import { worldHistory } from "./history.js";

/** What the story can do to a world, and the kind of change each one is. */
export const WORLD_DEED_KINDS = Object.freeze({
  help: "fortunes",
  hinder: "fortunes",
  befriend: "rivalry",
  set_against: "rivalry",
  improve: "fortunes",
  damage: "crime",
  ally: "rivalry",
  betray: "rivalry",
  take: "conflict",
  destroy: "conflict",
  crown: "leadership",
  fall: "catastrophe",
} as const satisfies Record<string, WorldChangeKind>);
export type WorldDeed = keyof typeof WORLD_DEED_KINDS;
const DEEDS = Object.keys(WORLD_DEED_KINDS) as WorldDeed[];

export interface WorldLedgerEntry {
  deed?: WorldDeed;
  fact?: "place" | "group";
  /** The group a deed is done to, or the first of two. */
  group?: string;
  /** The second group of `befriend` and `set_against`. */
  with?: string;
  place?: string;
  /** Who `crown` makes a group's head. */
  who?: string;
  /** A fact's new place or group, and where it is or what kind. */
  name?: string;
  in?: string;
  kind?: string;
  seat?: string;
  note?: string;
}

/** The world as the story has left it. */
export interface WorldPresent {
  prosperity: Record<string, WorldProsperity>;
  ruined: string[];
  keepers: Record<string, string>;
  leaders: Record<string, { name: string; sinceYearsAgo: number }>;
  /** How each pair of groups gets on, keyed "A|B" in name order. */
  relations: Record<string, number>;
  /** The party's standing with each group it has dealt with (-100 to 100). */
  standing: Record<string, number>;
  gone: string[];
  /** Places and groups the story added. */
  places: Array<{ id: string; name: string; parentId: string }>;
  groups: Array<{ name: string; kind: string; seat?: string }>;
  /** What the story did at each place, oldest first. */
  done: Record<string, string[]>;
}

const WORLD_TAG = /\[world:([^\]]*)\]/gi;
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const clamp = (value: number) => Math.max(-100, Math.min(100, value));

function tagValues(body: string): Map<string, string> {
  return new Map(
    readGmTagAttributes(body).map((attribute) => [
      attribute.key.trim().toLowerCase(),
      attribute.rawValue
        .trim()
        .replace(/^["']|["']$/g, "")
        .replace(/[\s"[\]]+/g, " ")
        .trim()
        .slice(0, 200),
    ]),
  );
}

function serialize(entry: WorldLedgerEntry, answer: { result: "ok" } | { result: "refused"; reason: string }): string {
  const parts = Object.entries(entry)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}="${value}"`);
  parts.push(`result="${answer.result}"`);
  if (answer.result === "refused") parts.push(`reason="${answer.reason}"`);
  return `[world: ${parts.join(" ")}]`;
}

/** The world's places and groups as the story has left them, to read a tag's names against. */
function known(game: GameWorld, present: WorldPresent) {
  const places = new Map<string, string>();
  for (const place of game.world.places) places.set(place.name.toLowerCase(), place.name);
  for (const place of present.places) places.set(place.name.toLowerCase(), place.name);
  const groups = new Map<string, string>();
  for (const group of game.brief.groups) groups.set(group.name.toLowerCase(), group.name);
  for (const group of present.groups) groups.set(group.name.toLowerCase(), group.name);
  for (const gone of present.gone) groups.delete(gone.toLowerCase());
  return { places, groups };
}

/**
 * Every world tag in a reply, answered in place: a deed of a kind the world allows, on places and
 * groups it has, is ok (with their names as the world spells them); anything else is refused with the
 * reason. Facts and deeds earlier in the same reply count for the ones after them.
 */
export function applyWorldTags(content: string, game: GameWorld, before: WorldLedgerEntry[]): string {
  const ledger = [...before];
  return content.replace(WORLD_TAG, (_whole, body: string) => {
    const values = tagValues(body);
    const present = worldPresent(game, ledger);
    const { places, groups } = known(game, present);
    const entry: WorldLedgerEntry = {};
    for (const key of [
      "deed",
      "fact",
      "group",
      "with",
      "place",
      "who",
      "name",
      "in",
      "kind",
      "seat",
      "note",
    ] as const) {
      const value = values.get(key);
      if (value) (entry as Record<string, string>)[key] = value;
    }
    const refuse = (reason: string) => serialize(entry, { result: "refused", reason });
    const placeName = (value: string | undefined) => (value ? places.get(value.toLowerCase()) : undefined);
    const groupName = (value: string | undefined) => (value ? groups.get(value.toLowerCase()) : undefined);

    if (entry.fact === "place" || entry.fact === "group") {
      if (!entry.name) return refuse("unreadable");
      if (entry.fact === "place") {
        if (places.has(entry.name.toLowerCase())) return refuse("exists");
        const inside = placeName(entry.in);
        if (!inside) return refuse("unknown-place");
        entry.in = inside;
      } else {
        if (groups.has(entry.name.toLowerCase())) return refuse("exists");
        if (!game.kit.groupKinds.some((kind) => kind.id === entry.kind)) return refuse("unknown-kind");
        if (entry.seat) {
          const seat = placeName(entry.seat);
          if (!seat) return refuse("unknown-place");
          entry.seat = seat;
        }
      }
      ledger.push(entry);
      return serialize(entry, { result: "ok" });
    }

    const deed = DEEDS.find((each) => each === entry.deed);
    if (!deed) return refuse("unreadable");
    if (!game.kit.change.kinds[WORLD_DEED_KINDS[deed]].on) return refuse("kind-off");
    const needsGroup = ["help", "hinder", "befriend", "set_against", "ally", "betray", "take", "destroy", "crown"];
    const needsPlace = ["improve", "damage", "take", "fall"];
    if (needsGroup.includes(deed)) {
      const group = groupName(entry.group);
      if (!group) return refuse("unknown-group");
      entry.group = group;
    }
    if (deed === "befriend" || deed === "set_against") {
      const other = groupName(entry.with);
      if (!other || other === entry.group) return refuse("unknown-group");
      entry.with = other;
    }
    if (needsPlace.includes(deed)) {
      const place = placeName(entry.place);
      if (!place) return refuse("unknown-place");
      entry.place = place;
    }
    if (deed === "crown" && !entry.who) return refuse("unreadable");
    ledger.push(entry);
    return serialize(entry, { result: "ok" });
  });
}

/** The ledger: every world tag answered ok in these replies, oldest first. */
export function readWorldLedger(replies: readonly string[]): WorldLedgerEntry[] {
  const entries: WorldLedgerEntry[] = [];
  for (const reply of replies) {
    for (const match of reply.matchAll(WORLD_TAG)) {
      const values = tagValues(match[1] ?? "");
      if (values.get("result") !== "ok") continue;
      values.delete("result");
      entries.push(Object.fromEntries(values) as WorldLedgerEntry);
    }
  }
  return entries;
}

/** The world as the history left it, with the ledger folded over it. */
export function worldPresent(game: GameWorld, ledger: readonly WorldLedgerEntry[]): WorldPresent {
  const history = worldHistory(game);
  const byName = new Map(game.world.places.map((place) => [place.name.toLowerCase(), place]));
  const present: WorldPresent = {
    prosperity: Object.fromEntries(
      game.world.places.filter((place) => place.prosperity).map((place) => [place.id, place.prosperity!]),
    ),
    ruined: [],
    keepers: { ...history.keepers },
    leaders: { ...history.leaders },
    relations: { ...history.relations },
    standing: {},
    gone: [],
    places: [],
    groups: [],
    done: {},
  };
  const placeId = (name: string | undefined) => {
    if (!name) return undefined;
    return (
      byName.get(name.toLowerCase())?.id ??
      present.places.find((place) => place.name.toLowerCase() === name.toLowerCase())?.id
    );
  };
  const record = (name: string | undefined, line: string) => {
    const id = placeId(name);
    if (id) present.done[id] = [...(present.done[id] ?? []), line];
  };
  const step = (id: string, by: number) => {
    const at = WORLD_PROSPERITIES.indexOf(present.prosperity[id] ?? "modest");
    present.prosperity[id] = WORLD_PROSPERITIES[Math.max(0, Math.min(WORLD_PROSPERITIES.length - 1, at + by))]!;
  };
  for (const entry of ledger) {
    const note = entry.note ? ` (${entry.note})` : "";
    if (entry.fact === "place" && entry.name && entry.in) {
      // Inside a place the story added, it is within that place's own world place.
      const key = entry.in.toLowerCase();
      const parentId =
        byName.get(key)?.id ?? present.places.find((place) => place.name.toLowerCase() === key)?.parentId;
      if (parentId) present.places.push({ id: `x${present.places.length + 1}`, name: entry.name, parentId });
      continue;
    }
    if (entry.fact === "group" && entry.name && entry.kind) {
      present.groups.push({ name: entry.name, kind: entry.kind, ...(entry.seat ? { seat: entry.seat } : {}) });
      // A group the story brings back under a gone group's name is a group again.
      present.gone = present.gone.filter((gone) => gone.toLowerCase() !== entry.name!.toLowerCase());
      continue;
    }
    const group = entry.group ?? "";
    const id = placeId(entry.place);
    switch (entry.deed) {
      case "help":
      case "hinder":
        present.standing[group] = clamp((present.standing[group] ?? 0) + (entry.deed === "help" ? 15 : -15));
        break;
      case "ally":
      case "betray":
        present.standing[group] = clamp((present.standing[group] ?? 0) + (entry.deed === "ally" ? 50 : -50));
        break;
      case "befriend":
      case "set_against": {
        const key = pairKey(group, entry.with ?? "");
        present.relations[key] = clamp((present.relations[key] ?? 0) + (entry.deed === "befriend" ? 25 : -25));
        break;
      }
      case "improve":
      case "damage":
        if (id) step(id, entry.deed === "improve" ? 1 : -1);
        record(entry.place, `${entry.deed === "improve" ? "The party improved it" : "The party damaged it"}${note}.`);
        break;
      case "take":
        if (id) present.keepers[id] = group;
        record(entry.place, `${group} took it${note}.`);
        break;
      case "destroy":
        present.gone.push(group);
        for (const [place, keeper] of Object.entries(present.keepers))
          if (keeper === group) delete present.keepers[place];
        break;
      case "crown":
        present.leaders[group] = { name: entry.who ?? "", sinceYearsAgo: 0 };
        break;
      case "fall":
        if (id && !present.ruined.includes(id)) present.ruined.push(id);
        record(entry.place, `It fell to ruin${note}.`);
        break;
    }
  }
  return present;
}

/** A place the story added, by name, as the place tag reads it. */
export function worldAddedPlace(
  game: GameWorld,
  present: WorldPresent,
  name: string,
): { place: { id: string; name: string }; within: WorldPlace } | undefined {
  const added = present.places.find((place) => place.name.toLowerCase() === name.trim().toLowerCase());
  const within = added ? game.world.places.find((place) => place.id === added.parentId) : undefined;
  return added && within ? { place: added, within } : undefined;
}

/** How the Game Master records what the story does to the world, for the deeds this world allows. */
export function worldLedgerInstructions(game: GameWorld): string {
  const on = (deed: WorldDeed) => game.kit.change.kinds[WORLD_DEED_KINDS[deed]].on;
  const list = (deeds: WorldDeed[]) => deeds.filter(on).join(", ");
  const toGroup = list(["help", "hinder", "ally", "betray", "destroy"]);
  const toTwo = list(["befriend", "set_against"]);
  const toPlace = list(["improve", "damage", "fall"]);
  return [
    `When the party changes the world, record it in your reply and the world remembers it, with note="what happened" on any of these:`,
    ...(toGroup ? [`- To a group: [world: deed="..." group="Name"] for ${toGroup}.`] : []),
    ...(on("crown") ? [`- A group's new head: [world: deed="crown" group="Name" who="Their name"].`] : []),
    ...(toTwo ? [`- Between two groups: [world: deed="..." group="Name" with="Other"] for ${toTwo}.`] : []),
    ...(toPlace ? [`- To a place: [world: deed="..." place="Name"] for ${toPlace}.`] : []),
    ...(on("take") ? [`- A place taken for a group: [world: deed="take" place="Name" group="Name"].`] : []),
    `- A place or group the story brings in: [world: fact="place" name="Name" in="Where it is"] or [world: fact="group" name="Name" kind="${game.kit.groupKinds[0]!.id}" seat="Where"], kind one of ${game.kit.groupKinds.map((kind) => kind.id).join(", ")}.`,
  ].join("\n");
}

const STANDING_WORDS: Array<[number, string]> = [
  [50, "trusted"],
  [15, "on good terms"],
  [-14, "neither"],
  [-49, "on bad terms"],
  [-100, "enemies"],
];

/** The party's standing with a group, in words. */
export function worldStandingWord(standing: number): string {
  return STANDING_WORDS.find(([floor]) => standing >= floor)![1];
}

/** What the story has changed across the world since play began, for the per-turn reminder. */
export function worldChangesLines(game: GameWorld, present: WorldPresent): string[] {
  const history = worldHistory(game);
  const nameOf = (id: string) =>
    game.world.places.find((place) => place.id === id)?.name ?? present.places.find((place) => place.id === id)?.name;
  const changes = [
    ...Object.entries(present.leaders)
      .filter(([group, leader]) => !present.gone.includes(group) && history.leaders[group]?.name !== leader.name)
      .map(([group, leader]) => `${group} is now led by ${leader.name}.`),
    ...present.gone.map((group) => `${group} is gone.`),
    ...present.ruined.flatMap((id) => (nameOf(id) ? [`${nameOf(id)} lies in ruins.`] : [])),
    ...present.groups
      .filter((group) => !present.gone.includes(group.name))
      .map((group) => {
        const kind = game.kit.groupKinds.find((each) => each.id === group.kind)?.label ?? group.kind;
        return `${group.name} (${kind}${group.seat ? `, at ${group.seat}` : ""}) has come into the world.`;
      }),
  ];
  const standing = Object.entries(present.standing)
    .filter(([group, value]) => !present.gone.includes(group) && worldStandingWord(value) !== "neither")
    .sort(([, a], [, b]) => Math.abs(b) - Math.abs(a))
    .slice(0, 8);
  return [
    ...(changes.length ? [`- Since play began: ${changes.join(" ")}`] : []),
    ...(standing.length
      ? [
          `- The party's standing: ${standing.map(([group, value]) => `${group} (${worldStandingWord(value)})`).join(", ")}.`,
        ]
      : []),
  ];
}
