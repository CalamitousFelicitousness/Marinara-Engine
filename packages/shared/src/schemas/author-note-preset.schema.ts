// ──────────────────────────────────────────────
// Author's Note Preset Zod Schemas
// ──────────────────────────────────────────────
import { z } from "zod";
import type { AuthorNotePresetSet } from "../types/author-note-preset.js";

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

/**
 * First set whose live presets equal the chat's live enabled ones, or null.
 * Drives the highlighted chip in the Author's Notes panel.
 *
 * Ids of deleted presets are ignored on both sides. A set saved empty matches
 * a chat with nothing on; a set emptied by deletions matches nothing.
 */
export function findMatchingAuthorNotePresetSet(
  sets: readonly AuthorNotePresetSet[],
  activeIds: readonly string[],
  libraryIds: readonly string[],
): AuthorNotePresetSet | null {
  const library = new Set(libraryIds);
  const active = new Set(activeIds.filter((id) => library.has(id)));
  return (
    sets.find((set) => {
      const live = new Set(set.presetIds.filter((id) => library.has(id)));
      if (live.size === 0 && set.presetIds.length > 0) return false;
      return live.size === active.size && [...live].every((id) => active.has(id));
    }) ?? null
  );
}

const authorNotePresetShape = z.object({
  name: z.string().min(1).max(200),
  content: z.string().default(""),
  depth: z.number().int().min(0).max(AUTHOR_NOTE_PRESET_MAX_DEPTH).default(DEFAULT_AUTHOR_NOTE_DEPTH),
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
