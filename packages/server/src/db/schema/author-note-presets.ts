// ──────────────────────────────────────────────
// Schema: Author's Note Presets
// ──────────────────────────────────────────────
import { fileTable, text, integer } from "../file-schema.js";

/**
 * Saved, reusable author's notes. Global, not per-chat: which presets are on
 * lives in chat metadata (`activeAuthorNotePresetIds`), so a note is recallable
 * from any chat without being copied.
 */
export const authorNotePresets = fileTable("author_note_presets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  content: text("content").notNull().default(""),
  /** 0 = after the latest message. */
  depth: integer("depth").notNull().default(4),
  /** List position, and the tie-break when presets share a depth. */
  order: integer("order").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
