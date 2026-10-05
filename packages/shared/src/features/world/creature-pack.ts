// ──────────────────────────────────────────────
// Creature packs (design-game-creature-art.md): art for the creatures Game Mode fights, by creature, with
// a size and looks of their own, in four facings (still now, walking later). DRAFT: the pack's schema,
// its import checks and its place in the library are Pixelforge's; this is the shape agreed with it
// (2026-10-05) for the Engine to read, to be replaced by Pixelforge's own when it lands.
// ──────────────────────────────────────────────
import { z } from "zod";

export const CREATURE_PACK_SIZES = Object.freeze(["tiny", "small", "medium", "large", "huge", "gargantuan"] as const);
export type CreaturePackSize = (typeof CREATURE_PACK_SIZES)[number];
/** A creature's facings, in a block's rows (RPG Maker's layout, as a walking character's). */
export const CREATURE_FACINGS = Object.freeze(["down", "left", "right", "up"] as const);
export type CreatureFacing = (typeof CREATURE_FACINGS)[number];

const CREATURE_PACK_MAX = Object.freeze({ creatures: 2000, variants: 8, sheets: 64, span: 6, sheetPx: 8192 });
const PNG_DATA_URL = "data:image/png;base64,";
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "An id is lowercase letters, digits, _ and -");

export const creaturePackSchema = z
  .object({
    creaturePackVersion: z.literal(1),
    id,
    name: z.string().trim().min(1).max(80),
    version: z.number().int().min(1).max(100_000),
    author: z.string().trim().max(80).optional(),
    /** One cell, in pixels (as an image tile pack's). */
    tileSize: z
      .number()
      .int()
      .min(16)
      .max(96)
      .refine((size) => size % 16 === 0, "A cell is a multiple of 16 pixels"),
    sheets: z
      .array(
        z
          .object({
            id,
            // Base64 and nothing else after the header, so a sheet is only ever its own picture.
            png: z
              .string()
              .startsWith(PNG_DATA_URL, "A sheet is a PNG data URL")
              .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/u, "A sheet is a PNG data URL"),
            width: z.number().int().min(1).max(CREATURE_PACK_MAX.sheetPx),
            height: z.number().int().min(1).max(CREATURE_PACK_MAX.sheetPx),
          })
          .strict(),
      )
      .min(1)
      .max(CREATURE_PACK_MAX.sheets),
    creatures: z
      .array(
        z
          .object({
            id,
            /** What it is the art of: a ruleset creature (`<catalog>/<entry>`, or `<ruleset>/<catalog>/<entry>`
             *  for one ruleset only) and names, matched with case and punctuation set aside. */
            match: z.array(z.string().trim().min(1).max(160)).min(1).max(16),
            size: z.enum(CREATURE_PACK_SIZES),
            /** One frame, in cells (RPG Maker blocks: 1 x 1 a wolf, 1 x 2 an upright Medium, 2 x 2 Large). */
            w: z.number().int().min(1).max(CREATURE_PACK_MAX.span),
            h: z.number().int().min(1).max(CREATURE_PACK_MAX.span),
            /** 1: still, one column of the four facings; 3: walking (step, stand, step). */
            frames: z.union([z.literal(1), z.literal(3)]),
            /** Its looks: each block's top-left cell on a sheet. */
            variants: z
              .array(
                z
                  .object({
                    sheet: id,
                    x: z.number().int().min(0).max(CREATURE_PACK_MAX.sheetPx),
                    y: z.number().int().min(0).max(CREATURE_PACK_MAX.sheetPx),
                  })
                  .strict(),
              )
              .min(1)
              .max(CREATURE_PACK_MAX.variants),
          })
          .strict(),
      )
      .max(CREATURE_PACK_MAX.creatures),
  })
  .strict();
export type CreaturePack = z.infer<typeof creaturePackSchema>;
export type CreaturePackCreature = CreaturePack["creatures"][number];
