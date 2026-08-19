// ──────────────────────────────────────────────
// Author's Note Preset Types
// ──────────────────────────────────────────────

/**
 * Saved, reusable author's note.
 *
 * Global library. Which presets are on is per-chat state in
 * `ChatMetadata.activeAuthorNotePresetIds`, not on the preset.
 */
export interface AuthorNotePreset {
  id: string;
  name: string;
  /** Body. Macros resolve at prompt assembly, not here. */
  content: string;
  /**
   * Injection depth from the end of the message list: 0 = after the latest
   * message, 4 = four from the end. Per-preset, so several active notes can
   * land at different positions in one generation.
   */
  depth: number;
  /** List position, and the tie-break when presets share a depth. */
  order: number;
  createdAt: string;
  updatedAt: string;
}
