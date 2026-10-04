// ──────────────────────────────────────────────
// A world's snapshot (worldgen W11): the world as this Engine made it, kept as data, so a game plays on
// in the same world after the generator changes. The recipe (seed, brief, edits) makes the world once,
// when the game is made and whenever its edits are saved; every read after that is the snapshot's:
// its compiled world, its history, the people of every place and every town as laid out, the story's
// places added on top. A new Engine reads an old snapshot as it was, like a save state, and never
// remakes it from the recipe.
// ──────────────────────────────────────────────
import { z } from "zod";
import { WORLD_CHANGE_KINDS, parseWorldKit, type WorldKit } from "../../schemas/world-kit.schema.js";
import { worldBriefSchema } from "../../schemas/world-brief.schema.js";
import { WORLD_GENERATOR_VERSION, WORLD_PROSPERITIES, type CompiledWorld } from "./compile.js";
import { worldEditsSchema } from "./edits.js";
import { WORLD_GROUNDINGS, worldPreEdit, type GameWorld } from "./game-world.js";
import { worldHistory, type WorldHistory } from "./history.js";
import { worldCast, type WorldPerson } from "./people.js";
import { WORLD_TOWN_KINDS, worldTownBase, type WorldTown } from "./town.js";

export const WORLD_SNAPSHOT_VERSION = 1;

/** A town as the snapshot keeps it: everything but its people, who are its places' casts. */
export type WorldSnapshotTown = Omit<WorldTown, "people">;

export interface WorldSnapshot {
  snapshotVersion: typeof WORLD_SNAPSHOT_VERSION;
  /** The generator that made it, for the record: a snapshot is read the same whatever made it. */
  generatorVersion: number;
  kit: WorldKit;
  seed: number;
  grounding: (typeof WORLD_GROUNDINGS)[number];
  brief: GameWorld["brief"];
  edits?: GameWorld["edits"];
  /** The world as compiled, before the edits. */
  compiled: CompiledWorld;
  /** The world with the edits applied, when there are edits. */
  world?: CompiledWorld;
  history: WorldHistory;
  /** The people of every place that has people, by place id, the edits applied. */
  casts: Record<string, WorldPerson[]>;
  /** Every settlement's town, by settlement id, laid out with the edits but none of the story's places. */
  towns: Record<string, WorldSnapshotTown>;
}

/** The snapshot of a world: its own when it was read from one, else made now. */
export function worldSnapshot(game: GameWorld): WorldSnapshot {
  if (game.frozen) return game.frozen;
  const casts: Record<string, WorldPerson[]> = {};
  const towns: Record<string, WorldSnapshotTown> = {};
  for (const place of game.world.places) {
    const cast = worldCast(game, place.id);
    if (cast.length) casts[place.id] = cast;
    if (place.rank === undefined) continue;
    const town = worldTownBase(game, place.id);
    if (!town) continue;
    const { people: _people, ...kept } = town;
    towns[place.id] = kept;
  }
  const compiled = worldPreEdit(game);
  return {
    snapshotVersion: WORLD_SNAPSHOT_VERSION,
    generatorVersion: WORLD_GENERATOR_VERSION,
    kit: game.kit,
    seed: game.seed,
    grounding: game.grounding,
    brief: game.brief,
    ...(game.edits ? { edits: game.edits, world: game.world } : {}),
    compiled,
    history: worldHistory(game),
    casts,
    towns,
  };
}

/** The game's world as its snapshot keeps it. Nothing is compiled again. */
export function gameWorldFromSnapshot(snapshot: WorldSnapshot): GameWorld {
  return {
    kit: snapshot.kit,
    seed: snapshot.seed,
    grounding: snapshot.grounding,
    brief: snapshot.brief,
    ...(snapshot.edits ? { edits: snapshot.edits } : {}),
    world: snapshot.world ?? snapshot.compiled,
    compiled: snapshot.compiled,
    frozen: snapshot,
  };
}

// ── Reading one back ──
//
// A snapshot read from storage or from a file is checked whole, so a damaged or hand-made one is
// refused rather than half-read. The limits are far above any world the generator makes.

const id = z.string().min(1).max(80);
const text = z.string().max(4000);
const word = z.string().max(200);
const cell = z.object({ x: z.number().int().min(0).max(4096), y: z.number().int().min(0).max(4096) }).strict();

const placeSchema = z
  .object({
    id,
    name: word,
    layer: id,
    depth: z.number().int().min(0).max(16),
    parentId: id.nullable(),
    at: cell,
    culture: id,
    size: id.optional(),
    rank: z.number().int().min(0).max(64).optional(),
    prosperity: z.enum(WORLD_PROSPERITIES).optional(),
    tags: z.array(id).max(32),
    note: text.optional(),
    lore: z.array(text).max(64).optional(),
    named: z.boolean(),
    aliases: z.array(word).max(32).optional(),
    byHand: z.literal(true).optional(),
  })
  .strict();

const compiledSchema = z
  .object({
    generatorVersion: z.number().int().min(1),
    seed: z.number().int().min(0).max(0xffffffff),
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
    terrain: z.array(id).max(36),
    ground: z.string().max(4_000_000),
    places: z.array(placeSchema).max(20_000),
    links: z
      .array(z.object({ from: id, to: id, way: id, days: z.number().finite().min(0).max(100_000) }).strict())
      .max(100_000),
    startId: id,
  })
  .strict()
  .refine((world) => world.ground.length === world.width * world.height, "The ground does not fill the world");

const personSchema = z
  .object({
    id,
    name: word,
    named: z.boolean(),
    placeId: id,
    culture: id,
    origin: word.optional(),
    role: word,
    group: word.optional(),
    temperament: word,
    value: word,
    speech: word,
    age: word,
    build: word,
    hair: word,
    mark: word,
  })
  .strict();

const historySchema = z
  .object({
    span: z.number().int().min(0).max(100_000),
    events: z
      .array(
        z
          .object({
            yearsAgo: z.number().int().min(0).max(100_000),
            kind: z.enum([...WORLD_CHANGE_KINDS, "founding"]),
            text,
            places: z.array(word).max(64),
            groups: z.array(word).max(64),
            severe: z.literal(true).optional(),
            brewing: z.literal(true).optional(),
            fixed: z.literal(true).optional(),
          })
          .strict(),
      )
      .max(50_000),
    keepers: z.record(id, word),
    leaders: z.record(word, z.object({ name: word, sinceYearsAgo: z.number().int().min(0).max(100_000) }).strict()),
    relations: z.record(z.string().max(500), z.number().finite().min(-100).max(100)),
    lost: z
      .array(z.object({ name: word, at: cell, fellYearsAgo: z.number().int().min(0).max(100_000) }).strict())
      .max(10_000),
  })
  .strict();

const lotShape = {
  x: z.number().int().min(0).max(1024),
  y: z.number().int().min(0).max(1024),
  w: z.number().int().min(1).max(64),
  h: z.number().int().min(1).max(64),
  door: cell,
};

const townSchema = z
  .object({
    settlementId: id,
    width: z.number().int().min(1).max(1024),
    height: z.number().int().min(1).max(1024),
    ground: z.string().max(1_048_576),
    square: z.object({ x: lotShape.x, y: lotShape.y, w: lotShape.w, h: lotShape.h }).strict(),
    buildings: z
      .array(
        z
          .object({
            id,
            kind: z.enum(WORLD_TOWN_KINDS),
            ...lotShape,
            placeId: id.optional(),
            name: word.optional(),
            role: word.optional(),
            people: z.array(id).max(10_000),
          })
          .strict(),
      )
      .max(10_000),
    homeOf: z.record(id, id),
    workOf: z.record(id, id),
    stalls: z.array(cell).max(1_000),
    lots: z.array(z.object(lotShape).strict()).max(10_000),
  })
  .strict()
  .refine((town) => town.ground.length === town.width * town.height, "A town's ground does not fill it");

const snapshotShape = z
  .object({
    snapshotVersion: z.literal(WORLD_SNAPSHOT_VERSION),
    generatorVersion: z.number().int().min(1),
    kit: z.unknown(),
    seed: z.number().int().min(0).max(0xffffffff),
    grounding: z.enum(WORLD_GROUNDINGS),
    brief: worldBriefSchema,
    edits: worldEditsSchema.optional(),
    compiled: compiledSchema,
    world: compiledSchema.optional(),
    history: historySchema,
    casts: z.record(id, z.array(personSchema).max(10_000)),
    towns: z.record(id, townSchema),
  })
  .strict();

/** A snapshot read back from storage or a file, checked whole, or why it cannot be read. A snapshot of a
 *  later format than this Engine knows is refused; an earlier one is brought up to this format first.
 *
 *  ponytail: the kit is checked by today's kit schema, so a kit field a later Engine drops would make an
 *  old snapshot unreadable; `migrateSnapshot` is where such a change is carried, a format version at a
 *  time, when one first happens. */
export function readWorldSnapshot(
  value: unknown,
): { ok: true; snapshot: WorldSnapshot } | { ok: false; issues: string[] } {
  if (!value || typeof value !== "object") return { ok: false, issues: ["The world's snapshot is not an object."] };
  const version = (value as { snapshotVersion?: unknown }).snapshotVersion;
  if (typeof version === "number" && version > WORLD_SNAPSHOT_VERSION) {
    return { ok: false, issues: ["The world's snapshot was made by a newer version of Marinara Engine."] };
  }
  const parsed = snapshotShape.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 5).map((issue) => `snapshot.${issue.path.join(".")}: ${issue.message}`),
    };
  }
  const kit = parseWorldKit(parsed.data.kit);
  if (!kit.ok) return { ok: false, issues: kit.issues.slice(0, 5).map((issue) => `snapshot.kit: ${issue}`) };
  return { ok: true, snapshot: { ...parsed.data, kit: kit.kit } as WorldSnapshot };
}
