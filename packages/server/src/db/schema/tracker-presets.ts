// ──────────────────────────────────────────────
// Schema: Tracker Presets
// ──────────────────────────────────────────────
import { fileTable, text, integer } from "../file-schema.js";

/**
 * Saved, reusable tracker layouts. Global, not per-card: which preset is on
 * lives in app settings (`activeTrackerPresetId`) with a per-chat override in
 * `chats.metadata.trackerPresetId`, so editing a preset never rewrites cards.
 *
 * The four payload columns are JSON arrays. Stored as text because the
 * file-backed store has no array column type.
 */
export const trackerPresets = fileTable("tracker_presets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** JSON CharacterTrackerCustomFieldDefault[]. */
  characterFields: text("character_fields").notNull().default("[]"),
  /** JSON RPGStatPool[]. */
  characterStats: text("character_stats").notNull().default("[]"),
  /** JSON CharacterTrackerCustomFieldDefault[]. */
  personaFields: text("persona_fields").notNull().default("[]"),
  /** JSON PersonaStatBar[]. */
  personaStats: text("persona_stats").notNull().default("[]"),
  /** List position. */
  order: integer("order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
