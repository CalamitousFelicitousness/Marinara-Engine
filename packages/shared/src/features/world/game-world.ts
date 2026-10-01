// ──────────────────────────────────────────────
// A game's world (worldgen W1): what a game stores (the seed, the generator version, the grounding and
// the brief, beside the setting kit) and what the Game Master is told of it. Everything else is the
// compile's, recomputed from those inputs, so a world is small, travels with its chat, and is the same
// world on every read.
// ──────────────────────────────────────────────
import { z } from "zod";
import { gameWorldKitFromMetadata, type WorldKit } from "../../schemas/world-kit.schema.js";
import { checkWorldBrief, worldBriefSchema, type WorldBrief } from "../../schemas/world-brief.schema.js";
import { WORLD_GENERATOR_VERSION, compileWorld, type CompiledWorld, type WorldPlace } from "./compile.js";
import { worldCast, worldPersonSheet } from "./people.js";
import { worldHistory, worldHistoryLine, worldNotablePast, worldPlacePast } from "./history.js";

/** How many people not yet met the Game Master is shown at once. */
const WHERE_YOU_ARE_PEOPLE = 5;

export const WORLD_GROUNDINGS = Object.freeze(["expand", "strict"] as const);

/** What a game stores as `gameWorld`: the inputs of its compile. */
export const gameWorldSchema = z
  .object({
    seed: z.number().int().min(0).max(0xffffffff),
    generatorVersion: z.number().int().min(1),
    grounding: z.enum(WORLD_GROUNDINGS).default("expand"),
    brief: worldBriefSchema,
  })
  .strict();
export type GameWorldInput = z.input<typeof gameWorldSchema>;

export interface GameWorld {
  kit: WorldKit;
  seed: number;
  grounding: (typeof WORLD_GROUNDINGS)[number];
  brief: WorldBrief;
  world: CompiledWorld;
}

// A few compiled worlds, by their inputs: a turn reads the world more than once, and the inputs never
// change in play.
const cache = new Map<string, CompiledWorld>();
const CACHE_SIZE = 8;

/** Compiles a world from its stored inputs, or reuses the same inputs' last compile. */
export function compileGameWorld(input: Omit<GameWorld, "world">): CompiledWorld {
  const key = JSON.stringify([input.seed, input.grounding, input.kit, input.brief]);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const world = compileWorld({
    seed: input.seed,
    kit: input.kit,
    brief: input.brief,
    strict: input.grounding === "strict",
  });
  cache.set(key, world);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return world;
}

/** The game's world, or null when it has none, or none this Engine can read. A world made by another
 *  generator version is never reshaped by this one, so it reads as no world rather than a different one. */
export function gameWorldFromMetadata(metadata: Record<string, unknown> | null | undefined): GameWorld | null {
  if (!metadata || metadata.gameWorld == null) return null;
  const kit = gameWorldKitFromMetadata(metadata);
  if (!kit) return null;
  const parsed = gameWorldSchema.safeParse(metadata.gameWorld);
  if (!parsed.success || parsed.data.generatorVersion !== WORLD_GENERATOR_VERSION) return null;
  const checked = checkWorldBrief(kit, parsed.data.brief);
  if (!checked.ok) return null;
  const inputs = { kit, seed: parsed.data.seed, grounding: parsed.data.grounding, brief: checked.brief };
  return { ...inputs, world: compileGameWorld(inputs) };
}

/** The world's place by the name the Game Master used, ignoring case and spacing. */
export function worldPlaceByName(world: CompiledWorld, name: string | undefined): WorldPlace | undefined {
  if (!name) return undefined;
  const key = name.trim().replace(/\s+/g, " ").toLowerCase();
  return world.places.find((place) => place.name.toLowerCase() === key);
}

/**
 * A place tag's name, read against the world: undefined when the world does not list it, else the
 * world's own name for it and its size. A place inside a settlement has its settlement's size, and a
 * place above the settlements (a province, a system) has none, as the road and the wilds have none.
 * The size is the kit's, or, given the ladder a ruleset's market declares, the place on that ladder at
 * the same height, so a world's capital is the market's biggest place.
 */
export function worldPlaceForTag(
  { kit, world }: GameWorld,
  name: string,
  ladder?: ReadonlyArray<{ id: string }>,
): { name: string; size?: string } | undefined {
  const place = worldPlaceByName(world, name);
  if (!place) return undefined;
  const parent = place.parentId ? world.places.find((each) => each.id === place.parentId) : undefined;
  const settlement = place.rank !== undefined ? place : parent?.rank !== undefined ? parent : undefined;
  if (!settlement) return { name: place.name };
  if (!ladder) return { name: place.name, size: settlement.size };
  const top = Math.max(1, kit.sizes.length - 1);
  // Rounded down, so only the world's own top places reach the market's biggest.
  const at = Math.floor((settlement.rank! * (ladder.length - 1)) / top);
  return { name: place.name, size: ladder[Math.min(ladder.length - 1, Math.max(0, at))]!.id };
}

/** A size word (id or label, any case) on the kit's own ladder, for a world without a market. */
export function worldKitSize(kit: WorldKit, word: string): { id: string } | undefined {
  const key = word.trim().toLowerCase();
  return kit.sizes.find((size) => size.id === key || size.label.toLowerCase() === key);
}

// ── What the Game Master is told ──

const labelOf = (entries: ReadonlyArray<{ id: string; label: string }>, id: string | undefined) =>
  entries.find((entry) => entry.id === id)?.label ?? id ?? "";
const plural = (word: string) => (/s$/i.test(word) ? word : `${word}s`);

function days(kit: WorldKit, count: number): string {
  const day = kit.calendar.day;
  if (count < 0.1) return `well under a ${day}`;
  if (count < 1) return `about ${Math.round(count * 10) / 10} of a ${day}`;
  const rounded = Math.round(count * 2) / 2;
  return `about ${rounded} ${rounded === 1 ? day : plural(day)}`;
}

function describe(kit: WorldKit, place: WorldPlace): string {
  const layer = labelOf(kit.layers, place.layer);
  if (place.size === undefined) return `${place.name} (${layer})`;
  return `${place.name} (${labelOf(kit.sizes, place.size)}, ${place.prosperity})`;
}

/** The fixed part, for the cached system prompt: the premise, the outer places, the biggest settlements. */
export function worldOverviewPromptText(game: GameWorld): string {
  const { kit, brief, world } = game;
  const history = worldHistory(game);
  const settlementsDepth = kit.layers.findIndex((layer) => layer.settlements);
  const outer = world.places.filter((place) => place.depth < settlementsDepth && place.depth <= 1);
  const biggest = world.places
    .filter((place) => place.depth === settlementsDepth)
    .sort((a, b) => b.rank! - a.rank! || a.id.localeCompare(b.id))
    .slice(0, 6);
  const lines = [
    `<world_places>`,
    `This world was made before play; its places are real and keep their names.`,
    `- Now: ${brief.premise}`,
    ...(outer.length ? [`- ${outer.map((place) => describe(kit, place)).join("; ")}.`] : []),
    `- Biggest places: ${biggest.map((place) => describe(kit, place)).join("; ")}.`,
    ...brief.groups
      .slice(0, 8)
      .map((group) =>
        [
          `- ${group.name} (${labelOf(kit.groupKinds, group.kind)}${group.seat ? `, at ${group.seat}` : ""}${
            history.leaders[group.name]?.name ? `, led by ${history.leaders[group.name]!.name}` : ""
          })`,
          group.note ? `: ${group.note}` : ".",
          group.allies.length ? ` Allies: ${group.allies.join(", ")}.` : "",
          group.rivals.length ? ` Rivals: ${group.rivals.join(", ")}.` : "",
        ].join(""),
      ),
    ...(() => {
      const past = worldNotablePast(history);
      return past.length ? [`- The past:`, ...past.map((event) => `  - ${worldHistoryLine(event)}`)] : [];
    })(),
    `To recall the past of a place or group not shown here, write [history: place="Name"] or [history: group="Name"]; the answer comes with your next turn.`,
    `Use these places and names. When the party goes somewhere, say where with [place: name="..."], using a name from this world when it is one; a place this world does not list (a farmhouse, a camp, a ship) gets a name of its own.`,
    `</world_places>`,
  ];
  return lines.join("\n");
}

/** The changing part, for the per-turn reminder: where the party is, and where it can go from there. */
export function worldWhereYouAreText(
  game: GameWorld,
  at: { place?: WorldPlace; name?: string; met?: ReadonlySet<string> },
): string {
  const { kit, world } = game;
  const byId = new Map(world.places.map((place) => [place.id, place]));
  const place = at.place;
  const lines = [`<where_you_are>`];
  if (!place) {
    lines.push(`The party is at ${at.name ?? "an unnamed place"}, which this world does not list.`);
    lines.push(`</where_you_are>`);
    return lines.join("\n");
  }
  const chain: WorldPlace[] = [];
  for (
    let up = place.parentId ? byId.get(place.parentId) : undefined;
    up;
    up = up.parentId ? byId.get(up.parentId) : undefined
  ) {
    chain.push(up);
  }
  lines.push(
    `The party is in ${describe(kit, place)}${chain.length ? `, in ${chain.map((each) => describe(kit, each)).join(", ")}` : ""}.`,
  );
  if (place.tags.length) lines.push(`- Known for: ${place.tags.map((tag) => labelOf(kit.placeTags, tag)).join(", ")}.`);
  if (place.note) lines.push(`- ${place.note}`);
  // Who keeps it now, and its past (worldgen W3), told for the settlement it is in.
  const history = worldHistory(game);
  const home = place.rank !== undefined ? place : chain.find((each) => each.rank !== undefined);
  if (home) {
    const keeper = history.keepers[home.id];
    const leader = keeper ? history.leaders[keeper]?.name : undefined;
    if (keeper) lines.push(`- Kept by ${keeper}${leader ? `, led by ${leader}` : ""}.`);
    const past = worldPlacePast(history, home, 4);
    if (past.length) lines.push(`- Its past: ${past.map(worldHistoryLine).join(" ")}`);
  }
  // Where it goes from here: the settlement's links (or its town's, for a place inside one).
  const settlement = place.size !== undefined ? place : chain.find((each) => each.size !== undefined);
  const inside = world.places.filter((each) => each.parentId === (settlement ?? place).id);
  if (inside.length) lines.push(`- Inside it: ${inside.map((each) => each.name).join(", ")}.`);
  if (settlement) {
    const routes = world.links
      .filter((link) => link.from === settlement.id || link.to === settlement.id)
      .map((link) => ({ other: byId.get(link.from === settlement.id ? link.to : link.from)!, link }))
      .sort((a, b) => a.link.days - b.link.days);
    if (routes.length) {
      lines.push(
        `- From here: ${routes
          .map(
            ({ other, link }) => `${describe(kit, other)}, ${days(kit, link.days)} by ${labelOf(kit.travel, link.way)}`,
          )
          .join("; ")}.`,
      );
    }
  }
  // The people here not met yet (worldgen W2), so someone new in the scene is one of them, not a name
  // the model reaches for.
  const unmet = worldCast(game, place.id)
    .filter((person) => person.named && !at.met?.has(person.id))
    .slice(0, WHERE_YOU_ARE_PEOPLE);
  if (unmet.length) {
    lines.push(
      `- People here the party has not met. When someone new comes into the scene, make it one of them, by their full name:`,
      ...unmet.map((person) => `  - ${person.name}: ${worldPersonSheet(kit, person)}`),
    );
  }
  lines.push(`</where_you_are>`);
  return lines.join("\n");
}
