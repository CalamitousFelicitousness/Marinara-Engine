// ──────────────────────────────────────────────
// Author's Note Preset Zod Schemas
// ──────────────────────────────────────────────
import { z } from "zod";

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

export type CreateAuthorNotePresetInput = z.infer<typeof createAuthorNotePresetSchema>;
export type UpdateAuthorNotePresetInput = z.infer<typeof updateAuthorNotePresetSchema>;
export type ReorderAuthorNotePresetsInput = z.infer<typeof reorderAuthorNotePresetsSchema>;
