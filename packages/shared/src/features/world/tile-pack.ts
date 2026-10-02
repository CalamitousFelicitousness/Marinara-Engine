// ──────────────────────────────────────────────
// Tile packs (worldgen W9a): the overworld's and the towns' art as data, a palette and every tile as
// sixteen rows of sixteen characters, one per pixel: a palette index from `0-9a-zA-Z`, or "." for clear.
// The Engine's own packs are drawn in code (scripts/art/build-overworld-tiles.mjs); a pack made in
// Pixelforge, or shared as a file, has the same shape. A tile a pack lacks is drawn plain.
// ──────────────────────────────────────────────
import { z } from "zod";
import { WORLD_GROUND_LOOKS } from "./overworld.js";

/** Pixels across and down a tile. */
export const TILE_PACK_SIZE = 16;
/** The characters a row is written in, a palette index each; "." is a clear pixel. */
export const TILE_PACK_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const TILE_PACK_CLEAR = ".";
/** The most variants a tile has. */
export const TILE_PACK_MAX_VARIANTS = 8;
/** The largest share file the Engine reads. */
export const TILE_PACK_MAX_BYTES = 1_000_000;

const NINE = ["nw", "n", "ne", "w", "c", "e", "sw", "s", "se"] as const;

/** Every tile the overworld and the towns draw. */
export const WORLD_TILE_IDS = Object.freeze([
  ...WORLD_GROUND_LOOKS,
  "marker0",
  "marker1",
  "marker2",
  "marker3",
  "ruin",
  "party",
  "town_ground",
  "street",
  "square",
  "wall",
  "wall_window",
  "wall_door",
  "stall",
  "well",
  "tree",
  "folk",
  ...NINE.map((at) => `roof_${at}`),
  ...NINE.map((at) => `hall_${at}`),
] as const);
export type WorldTileId = (typeof WORLD_TILE_IDS)[number];

const colour = z.string().regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i, "A colour is #rrggbb or #rrggbbaa");
const row = z.string().length(TILE_PACK_SIZE);
const variant = z.array(row).length(TILE_PACK_SIZE);

export const tilePackSchema = z
  .object({
    tilePackVersion: z.literal(1),
    /** Stored packs are namespaced (`local/...`); a built-in pack's id is its family's. */
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9_/-]*$/, "An id is lowercase letters, digits, _ - and /"),
    name: z.string().trim().min(1).max(80),
    /** The setting family it is drawn for (fantasy, wuxia ...), or a kit's own. */
    family: z.string().trim().min(1).max(40),
    version: z.number().int().min(1).max(100_000),
    author: z.string().trim().max(80).optional(),
    palette: z.array(colour).min(1).max(TILE_PACK_ALPHABET.length),
    tiles: z.record(z.string().max(40), z.array(variant).min(1).max(TILE_PACK_MAX_VARIANTS)),
  })
  .strict();
export type TilePack = z.infer<typeof tilePackSchema>;

export type TilePackRead = { ok: true; pack: TilePack; notes: string[] } | { ok: false; issues: string[] };

const KNOWN = new Set<string>(WORLD_TILE_IDS);

/** A pack read and checked: its shape, every pixel within its palette; tiles the Engine does not draw
 *  are left out and noted. */
export function parseTilePack(input: unknown): TilePackRead {
  let value = input;
  if (typeof input === "string") {
    if (input.length > TILE_PACK_MAX_BYTES)
      return { ok: false, issues: ["The file is larger than a tile pack can be."] };
    try {
      value = JSON.parse(input);
    } catch {
      return { ok: false, issues: ["The file is not JSON."] };
    }
  }
  const parsed = tilePackSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
  }
  const pack = parsed.data;
  const notes: string[] = [];
  const issues: string[] = [];
  const allowed = new Set([TILE_PACK_CLEAR, ...TILE_PACK_ALPHABET.slice(0, pack.palette.length)]);
  const tiles: TilePack["tiles"] = {};
  for (const [id, variants] of Object.entries(pack.tiles)) {
    if (!KNOWN.has(id)) {
      notes.push(`"${id}" is not a tile the Engine draws, so it was left out.`);
      continue;
    }
    variants.forEach((rows, index) => {
      rows.forEach((line, y) => {
        for (const char of line) {
          if (!allowed.has(char)) {
            issues.push(`${id} variant ${index + 1} row ${y + 1}: "${char}" is not in the palette.`);
            return;
          }
        }
      });
    });
    tiles[id] = variants;
  }
  if (issues.length) return { ok: false, issues: issues.slice(0, 20) };
  return { ok: true, pack: { ...pack, tiles }, notes };
}

/** A tile's pixels as RGBA, row by row. */
export function tilePackPixels(pack: TilePack, rows: readonly string[]): Uint8ClampedArray<ArrayBuffer> {
  const colours = pack.palette.map((value) => {
    const hex = value.slice(1);
    return [0, 2, 4, 6].map((at) => (at < hex.length ? parseInt(hex.slice(at, at + 2), 16) : 255));
  });
  const out = new Uint8ClampedArray(TILE_PACK_SIZE * TILE_PACK_SIZE * 4);
  rows.forEach((line, y) => {
    [...line].forEach((char, x) => {
      if (char === TILE_PACK_CLEAR) return;
      const rgba = colours[TILE_PACK_ALPHABET.indexOf(char)];
      if (rgba) out.set(rgba, (y * TILE_PACK_SIZE + x) * 4);
    });
  });
  return out;
}
