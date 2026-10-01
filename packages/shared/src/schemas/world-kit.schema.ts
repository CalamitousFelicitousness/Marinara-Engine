// ──────────────────────────────────────────────
// A setting kit (worldgen W0): the words and scales one kind of setting is written in, so a world
// can be high fantasy, a wuxia empire, a modern town or a space sector without the Engine knowing
// any of them. Data, not code: the player sees it at setup and can change any word, and a world
// generated later is written only in its words. Every word can reach the Game Master's prompt, so
// it follows the same hygiene as a ruleset's labels.
// ──────────────────────────────────────────────
import { z } from "zod";
import { promptSafeText } from "./ruleset.schema.js";

const kitId = z
  .string()
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, "An id is lowercase letters, digits and underscores, starting with a letter");
const word = promptSafeText(80);
const named = z.object({ id: kitId, label: word }).strict();

/** The generic kinds of change a world can go through, gentlest first (worldgen plan section 7). A
 *  kit names each in its own words and says which exist by default. */
export const WORLD_CHANGE_KINDS = Object.freeze([
  "everyday",
  "lives",
  "fortunes",
  "rivalry",
  "leadership",
  "crime",
  "conflict",
  "catastrophe",
] as const);
export type WorldChangeKind = (typeof WORLD_CHANGE_KINDS)[number];

/** How lively a world starts, from no off-screen change at all to a quick one. */
export const WORLD_PACES = Object.freeze(["still", "slow", "steady", "quick"] as const);
/** How big a world the setting wants, from one site to a sector. */
export const WORLD_SCALES = Object.freeze(["site", "town", "region", "realm", "world", "sector"] as const);

const changeKind = z.object({ label: word, on: z.boolean() }).strict();

export const worldKitSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: kitId,
    label: word,
    /** One paragraph for the picker. */
    summary: promptSafeText(400),
    scale: z.enum(WORLD_SCALES),
    /** The layers of place, outermost first; exactly one holds the settlements, whose places have
     *  a size and, with a market, sell things. */
    layers: z
      .array(z.object({ id: kitId, label: word, settlements: z.literal(true).optional() }).strict())
      .min(1)
      .max(8),
    /** The size ladder, smallest first: the market's place sizes where a ruleset declares none. */
    sizes: z.array(named).min(1).max(12),
    groupKinds: z.array(named).min(1).max(24),
    placeTags: z.array(named).max(48).default([]),
    travel: z.array(named).min(1).max(12),
    calendar: z
      .object({
        year: word,
        day: word,
        months: z.array(word).max(24).optional(),
        era: word.optional(),
      })
      .strict(),
    change: z
      .object({
        kinds: z
          .object({
            everyday: changeKind,
            lives: changeKind,
            fortunes: changeKind,
            rivalry: changeKind,
            leadership: changeKind,
            crime: changeKind,
            conflict: changeKind,
            catastrophe: changeKind,
          })
          .strict(),
        pace: z.enum(WORLD_PACES),
      })
      .strict(),
    /** Who lives here and how they are named. Real-world cultures are written with care, never as
     *  caricature; syllables, where given, are what a compile draws names from. */
    cultures: z
      .array(
        z
          .object({
            id: kitId,
            label: word,
            naming: promptSafeText(600),
            syllables: z
              .object({
                given: z.array(promptSafeText(20)).min(4).max(200).optional(),
                family: z.array(promptSafeText(20)).min(4).max(200).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict()
  .superRefine((kit, ctx) => {
    const settlements = kit.layers.filter((layer) => layer.settlements).length;
    if (settlements !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["layers"],
        message: "Exactly one layer holds the settlements",
      });
    }
    for (const key of ["layers", "sizes", "groupKinds", "placeTags", "travel", "cultures"] as const) {
      const seen = new Set<string>();
      kit[key].forEach((entry, index) => {
        if (seen.has(entry.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key, index, "id"],
            message: `Repeats the id "${entry.id}"`,
          });
        }
        seen.add(entry.id);
      });
    }
  });

export type WorldKit = z.infer<typeof worldKitSchema>;
export type WorldKitInput = z.input<typeof worldKitSchema>;

/** A kit read from anywhere (a starter, the model, the player's edits), or the reasons it is not one. */
export function parseWorldKit(input: unknown): { ok: true; kit: WorldKit } | { ok: false; issues: string[] } {
  const parsed = worldKitSchema.safeParse(input);
  if (parsed.success) return { ok: true, kit: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "kit"}: ${issue.message}`),
  };
}

/** The setting kit a game stored when it was created (`gameWorldKit`), or null when it has none.
 *  A stored kit that no longer reads as one is left out rather than half-used. */
export function gameWorldKitFromMetadata(metadata: Record<string, unknown> | null | undefined): WorldKit | null {
  if (!metadata || metadata.gameWorldKit == null) return null;
  const parsed = parseWorldKit(metadata.gameWorldKit);
  return parsed.ok ? parsed.kit : null;
}
