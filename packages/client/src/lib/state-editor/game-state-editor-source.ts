// ──────────────────────────────────────────────
// State Editor — the roleplay game-state source.
// Sections are the Agent Suite tracker slices, so the shapes, validation and
// patch building stay in one place for both editors.
// ──────────────────────────────────────────────
import type { GameState } from "@marinara-engine/shared";
import { AGENT_SUITE_TRACKER_SLICES } from "../agent-suite-tracker-slices";
import type { StateEditorChange, StateEditorSection } from "./state-editor.types";

/** Section order in the editor: the scene first, then who is in it, then the player's things. */
export const GAME_STATE_EDITOR_SECTION_IDS = [
  "world-state",
  "character-tracker",
  "persona-stats",
  "inventory-tracker",
  "custom-tracker",
  "quest",
] as const;

export type GameStateEditorSectionId = (typeof GAME_STATE_EDITOR_SECTION_IDS)[number];

export function buildGameStateEditorSections(
  gameState: GameState,
  localize: (sectionId: GameStateEditorSectionId, part: "label" | "description") => string,
): StateEditorSection[] {
  return GAME_STATE_EDITOR_SECTION_IDS.map((id) => ({
    id,
    label: localize(id, "label"),
    description: localize(id, "description"),
    value: AGENT_SUITE_TRACKER_SLICES[id]!.getValue(gameState),
  }));
}

/**
 * Folds the changed sections into ONE game-state PATCH body. Each slice builds its patch on top of the
 * previous slices' result: several slices rewrite all of playerStats, so building them from the same
 * snapshot would let the last one silently undo the others.
 */
export function buildGameStateEditorPatch(
  snapshot: GameState,
  changes: StateEditorChange[],
): { patch: Record<string, unknown> } | { error: string; sectionId: string } {
  let working = snapshot;
  const patch: Record<string, unknown> = {};
  for (const change of changes) {
    const slice = AGENT_SUITE_TRACKER_SLICES[change.sectionId];
    if (!slice) return { error: `Unknown section "${change.sectionId}"`, sectionId: change.sectionId };
    const slicePatch = slice.buildPatch(working, change.value);
    if ("error" in slicePatch && typeof slicePatch.error === "string") {
      return { error: slicePatch.error, sectionId: change.sectionId };
    }
    Object.assign(patch, slicePatch);
    working = { ...working, ...slicePatch } as GameState;
  }
  return { patch };
}
