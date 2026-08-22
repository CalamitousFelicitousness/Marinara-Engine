// ──────────────────────────────────────────────
// Tracker Preset Types
// ──────────────────────────────────────────────
import type { CharacterTrackerCustomFieldDefault, RPGStatPool } from "./character.js";
import type { PersonaStatBar } from "./persona.js";

/**
 * Saved, reusable tracker layout applied to every character and the persona.
 *
 * Global library. Which preset is active is a global app setting
 * (`TRACKER_PRESET_SETTINGS_KEY`) with a per-chat override in
 * `ChatMetadata.trackerPresetId`, not on the preset.
 *
 * A preset is a base layer, never a replacement: card configuration wins on a
 * name collision and card-only entries survive. See `mergeTrackerNamedEntries`.
 */
export interface TrackerPreset {
  id: string;
  name: string;
  /** Seeded into `PresentCharacter.customFields` for every character. */
  characterFields: CharacterTrackerCustomFieldDefault[];
  /** Seeded into `PresentCharacter.stats`. Applied only to cards with `rpgStats.enabled`. */
  characterStats: RPGStatPool[];
  /** Seeded into `PlayerStats.customTrackerFields`. No card-level equivalent existed before. */
  personaFields: CharacterTrackerCustomFieldDefault[];
  /** Seeded into `GameState.personaStats`. Applied only when the persona has stats enabled. */
  personaStats: PersonaStatBar[];
  /** List position. */
  order: number;
  createdAt: string;
  updatedAt: string;
}

/** Resolved answer to "which preset applies to this chat". */
export interface ResolvedTrackerPreset {
  preset: TrackerPreset | null;
  /** Where the choice came from, for UI labelling. */
  source: "chat" | "global" | "none";
}
