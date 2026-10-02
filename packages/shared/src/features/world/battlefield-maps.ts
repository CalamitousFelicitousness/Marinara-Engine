// ──────────────────────────────────────────────
// Hand-made battlefields (worldgen W9g): tactical boards painted for a world's places, kept in its hand
// edits so they travel wherever the world does (world files, map packs, the library, a new game's
// setup). A fight that starts while the party is at a place, or at a place inside it, is fought on one
// of that place's boards exactly as painted, instead of a generated one: the nearest place up that has
// any, and of several, the one the fight's seed picks.
// ──────────────────────────────────────────────
import { z } from "zod";
import { promptSafeText } from "../../schemas/ruleset.schema.js";
import { TACTICAL_ENVIRONMENTS, TACTICAL_TERRAINS } from "../tactical-combat/environments.js";
import { gridDimensions, tacticalMadeBoardIssues } from "../tactical-combat/grid-gen.js";
import type {
  TacticalEnvironment,
  TacticalGrid,
  TacticalMadeBattlefield,
  TacticalTerrain,
} from "../tactical-combat/types.js";
import type { GameWorld } from "./game-world.js";

/** The most battlefields a world has. */
export const WORLD_BATTLEFIELDS_MAX = 32;

/** One character per tile in a painted row. */
export const WORLD_BATTLEFIELD_TILE_CHARS: Readonly<Record<TacticalTerrain, string>> = Object.freeze({
  plains: "p",
  forest: "f",
  mountain: "m",
  ruin: "r",
  water: "w",
  wall: "#",
});
const TERRAIN_OF = new Map(TACTICAL_TERRAINS.map((terrain) => [WORLD_BATTLEFIELD_TILE_CHARS[terrain], terrain]));

export const worldBattlefieldMapSchema = z
  .object({
    /** `b<n>`, as the editor numbers them. */
    id: z.string().regex(/^b\d{1,4}$/, "A battlefield's id is b and a number"),
    name: promptSafeText(60).refine((value) => value.trim().length > 0, "A name needs more than spaces"),
    /** The place it is fought at: a compiled place or one added by hand. */
    place: z.string().min(1).max(16),
    size: z.enum(["small", "medium", "large"]),
    /** The battlefield it looks like: its colours, and the weather's reach. */
    scene: z.enum(TACTICAL_ENVIRONMENTS),
    /** Its tiles, a row of characters each (p plains, f forest, m mountain, r ruin, w water, # wall). */
    rows: z
      .array(z.string().regex(/^[pfmrw#]{1,14}$/, "A battlefield row is p, f, m, r, w or # per tile"))
      .min(1)
      .max(10),
  })
  .strict();
export type WorldBattlefieldMap = z.infer<typeof worldBattlefieldMapSchema>;

/** A painted board as the tactical engine reads it. */
export function worldBattlefieldGrid(map: Pick<WorldBattlefieldMap, "rows">): TacticalGrid {
  const tiles = map.rows.map((row) => [...row].map((char) => TERRAIN_OF.get(char) ?? "plains"));
  return { width: tiles[0]?.length ?? 0, height: tiles.length, tiles };
}

/** Why a painted board cannot be fought on, or nothing (`tacticalMadeBoardIssues`). */
export function worldBattlefieldIssues(map: WorldBattlefieldMap): string[] {
  return tacticalMadeBoardIssues(map.size, worldBattlefieldGrid(map));
}

/** A board of the size, plains throughout: where painting one starts. */
export function worldBattlefieldBlankRows(size: WorldBattlefieldMap["size"]): string[] {
  const { width, height } = gridDimensions(0, size);
  return Array.from({ length: height }, () => "p".repeat(width));
}

/**
 * The board a fight at `placeId` is fought on: one of the place's own, else of the nearest place it is
 * inside that has any; of several, the one the seed picks. Null where none applies.
 */
export function worldBattlefieldHere(
  game: GameWorld,
  placeId: string | null | undefined,
  seed: number,
): { made: TacticalMadeBattlefield; scene: TacticalEnvironment } | null {
  const maps = game.edits?.battlefields;
  if (!maps?.length) return null;
  const parents = new Map(game.world.places.map((place) => [place.id, place.parentId]));
  for (let at = placeId ?? null, hops = 0; at && hops < 64; at = parents.get(at) ?? null, hops++) {
    const here = maps.filter((map) => map.place === at);
    if (!here.length) continue;
    const map = here[(seed >>> 0) % here.length]!;
    return {
      made: { id: map.id, name: map.name, size: map.size, grid: worldBattlefieldGrid(map) },
      scene: map.scene,
    };
  }
  return null;
}
