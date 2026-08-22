// ──────────────────────────────────────────────
// Tracker Preset Zod Schemas
// ──────────────────────────────────────────────
import { z } from "zod";

/** App-settings key holding the globally active preset id. Empty string = none. */
export const TRACKER_PRESET_SETTINGS_KEY = "activeTrackerPresetId";

/** Storage-side sanity bounds. Rows are re-clamped when seeded into a tracker. */
export const TRACKER_PRESET_MAX_FIELDS = 60;
export const TRACKER_PRESET_MAX_STATS = 30;

const trackerFieldSchema = z.object({
  name: z.string().min(1).max(120),
  value: z.string().max(2000).default(""),
});

const trackerStatSchema = z.object({
  name: z.string().min(1).max(120),
  value: z.number().finite().min(0).default(100),
  max: z.number().finite().min(1).default(100),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .default("#a78bfa"),
});

const trackerPresetShape = z.object({
  name: z.string().min(1).max(200),
  characterFields: z.array(trackerFieldSchema).max(TRACKER_PRESET_MAX_FIELDS).default([]),
  characterStats: z.array(trackerStatSchema).max(TRACKER_PRESET_MAX_STATS).default([]),
  personaFields: z.array(trackerFieldSchema).max(TRACKER_PRESET_MAX_FIELDS).default([]),
  personaStats: z.array(trackerStatSchema).max(TRACKER_PRESET_MAX_STATS).default([]),
  order: z.number().int().optional(),
});

export const createTrackerPresetSchema = trackerPresetShape;
export const updateTrackerPresetSchema = trackerPresetShape.partial();
export const reorderTrackerPresetsSchema = z.object({
  presetIds: z.array(z.string().min(1)),
});

/** `null` clears the selection. On a chat, `null` means "no preset", not "inherit". */
export const setActiveTrackerPresetSchema = z.object({
  presetId: z.string().min(1).nullable(),
});

/**
 * Explicit apply-to-chat. Omitting `presetId` uses whatever the chat already
 * resolves to, so the button works without repeating the selection.
 */
export const applyTrackerPresetSchema = z.object({
  chatId: z.string().min(1),
  presetId: z.string().min(1).optional(),
  characters: z.boolean().default(true),
  persona: z.boolean().default(true),
});

export type CreateTrackerPresetInput = z.infer<typeof createTrackerPresetSchema>;
export type UpdateTrackerPresetInput = z.infer<typeof updateTrackerPresetSchema>;
export type ReorderTrackerPresetsInput = z.infer<typeof reorderTrackerPresetsSchema>;
export type SetActiveTrackerPresetInput = z.infer<typeof setActiveTrackerPresetSchema>;
export type ApplyTrackerPresetInput = z.infer<typeof applyTrackerPresetSchema>;
