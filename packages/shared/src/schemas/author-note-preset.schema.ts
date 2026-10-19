// ──────────────────────────────────────────────
// Author's Note Preset Zod Schemas
// ──────────────────────────────────────────────
import { z } from "zod";
import type { AuthorNotePresetSet, AuthorNoteRole } from "../types/author-note-preset.js";

/** Storage-side sanity bound. Depth is clamped again at assembly. */
export const AUTHOR_NOTE_PRESET_MAX_DEPTH = 1000;

/** Depth when unspecified. Previously hardcoded in three generation routes. */
export const DEFAULT_AUTHOR_NOTE_DEPTH = 4;

/** Clamp a stored or user-supplied depth to a usable integer. */
export function normalizeAuthorNoteDepth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : DEFAULT_AUTHOR_NOTE_DEPTH;
}

export const AUTHOR_NOTE_ROLES = ["system", "user", "assistant"] as const satisfies readonly AuthorNoteRole[];

export const DEFAULT_AUTHOR_NOTE_ROLE: AuthorNoteRole = "system";

/** A stored or user-supplied role, or the default when unrecognized. */
export function normalizeAuthorNoteRole(value: unknown): AuthorNoteRole {
  return AUTHOR_NOTE_ROLES.find((role) => role === value) ?? DEFAULT_AUTHOR_NOTE_ROLE;
}

/**
 * Whether every live preset of the set is enabled. Drives the highlighted chips
 * in the Author's Notes panel and the add/remove choice of a chip click.
 *
 * Ids of deleted presets are ignored on both sides. A set saved empty is on
 * when nothing is enabled; a set emptied by deletions is never on.
 */
export function isAuthorNotePresetSetActive(
  set: AuthorNotePresetSet,
  activeIds: readonly string[],
  libraryIds: readonly string[],
): boolean {
  const library = new Set(libraryIds);
  const live = set.presetIds.filter((id) => library.has(id));
  if (set.presetIds.length === 0) return !activeIds.some((id) => library.has(id));
  const active = new Set(activeIds);
  return live.length > 0 && live.every((id) => active.has(id));
}

/**
 * The chat's enabled preset ids after clicking a set chip. An off set adds its
 * presets; an on set removes them, keeping those still held by another on set
 * that is not a subset of it. A set saved empty clears everything.
 */
export function toggleAuthorNotePresetSet(
  sets: readonly AuthorNotePresetSet[],
  set: AuthorNotePresetSet,
  activeIds: readonly string[],
  libraryIds: readonly string[],
): string[] {
  const library = new Set(libraryIds);
  const current = activeIds.filter((id) => library.has(id));
  if (set.presetIds.length === 0) return [];
  const live = set.presetIds.filter((id) => library.has(id));
  if (!isAuthorNotePresetSetActive(set, current, libraryIds)) {
    return [...current, ...live.filter((id) => !current.includes(id))];
  }
  const own = new Set(live);
  const held = new Set(
    sets
      .filter((other) => other.id !== set.id && isAuthorNotePresetSetActive(other, current, libraryIds))
      .map((other) => other.presetIds.filter((id) => library.has(id)))
      .filter((otherLive) => otherLive.some((id) => !own.has(id)))
      .flat(),
  );
  return current.filter((id) => !own.has(id) || held.has(id));
}

const authorNotePresetShape = z.object({
  name: z.string().min(1).max(200),
  content: z.string().default(""),
  depth: z.number().int().min(0).max(AUTHOR_NOTE_PRESET_MAX_DEPTH).default(DEFAULT_AUTHOR_NOTE_DEPTH),
  role: z.enum(AUTHOR_NOTE_ROLES).default(DEFAULT_AUTHOR_NOTE_ROLE),
  order: z.number().int().optional(),
});

export const createAuthorNotePresetSchema = authorNotePresetShape;
export const updateAuthorNotePresetSchema = authorNotePresetShape.partial();
export const reorderAuthorNotePresetsSchema = z.object({
  presetIds: z.array(z.string().min(1)),
});

/** app_settings key holding every saved preset set as one JSON array. */
export const AUTHOR_NOTE_PRESET_SETS_SETTINGS_KEY = "author-note-preset-sets";

export const authorNotePresetSetSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(200),
    presetIds: z.array(z.string().min(1)).transform((ids) => Array.from(new Set(ids))),
  })
  .strict();

export const authorNotePresetSetListSchema = z
  .array(authorNotePresetSetSchema)
  .max(200)
  .refine((sets) => new Set(sets.map((set) => set.id)).size === sets.length, "Set ids must be unique");

export type CreateAuthorNotePresetInput = z.infer<typeof createAuthorNotePresetSchema>;
export type UpdateAuthorNotePresetInput = z.infer<typeof updateAuthorNotePresetSchema>;
export type ReorderAuthorNotePresetsInput = z.infer<typeof reorderAuthorNotePresetsSchema>;
