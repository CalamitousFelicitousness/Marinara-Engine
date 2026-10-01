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

/** What a stretch of ground is, for travel: open ground anyone can cross, water a boat or a bridge
 *  crosses, or a barrier (peaks, a gravity well) only a way that crosses anything gets over. */
export const WORLD_TERRAIN_KINDS = Object.freeze(["open", "water", "barrier"] as const);
/** What a way of travel crosses: open ground, water, or anything. */
export const WORLD_TRAVEL_CROSSES = Object.freeze(["open", "water", "any"] as const);

/** One class of the world's ground, in the setting's words, and how much of the ground it covers. */
const terrain = z
  .object({ id: kitId, label: word, kind: z.enum(WORLD_TERRAIN_KINDS), share: z.number().int().min(1).max(100) })
  .strict();
/** A way of travel. `crosses` and `speed` (multiples of walking pace) say where it goes and how fast;
 *  a kit written before worlds (W0) leaves them out, and the world reads open ground at walking pace. */
const travelWay = z
  .object({
    id: kitId,
    label: word,
    crosses: z.enum(WORLD_TRAVEL_CROSSES).optional(),
    speed: z.number().min(0.25).max(500).optional(),
  })
  .strict();

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
    travel: z.array(travelWay).min(1).max(12),
    /** The ground a generated world is laid out on (worldgen W1). A kit without one gets open
     *  ground named for its outermost layer. */
    terrain: z.array(terrain).min(1).max(16).optional(),
    /** The words a world's people are drawn in (worldgen W2): the jobs its places need (by the place
     *  tags they are common at; none means anywhere, and a tag the kit no longer has simply never
     *  matches), and how people look, in the setting's own terms
     *  (beastfolk, androids or spirits described as themselves). What a kit leaves out is filled from
     *  `WORLD_PEOPLE_DEFAULTS`. */
    people: z
      .object({
        roles: z
          .array(z.object({ label: word, tags: z.array(kitId).max(12).optional() }).strict())
          .min(1)
          .max(60),
        hair: z.array(word).min(1).max(30),
        marks: z.array(word).min(1).max(40),
        ages: z.array(word).min(1).max(12).optional(),
        builds: z.array(word).min(1).max(20).optional(),
        temperaments: z.array(word).min(1).max(30).optional(),
        values: z.array(word).min(1).max(30).optional(),
        speech: z.array(word).min(1).max(20).optional(),
      })
      .strict()
      .optional(),
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
    for (const key of ["layers", "sizes", "groupKinds", "placeTags", "travel", "cultures", "terrain"] as const) {
      const seen = new Set<string>();
      (kit[key] ?? []).forEach((entry, index) => {
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
