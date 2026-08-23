import type { TrackerDataPanelSection } from "../../stores/ui.store";
import type { TrackerProfileColors } from "./lib/tracker-profile-style";

export type TrackerPanelSection = TrackerDataPanelSection;
/**
 * Tracker rows are read-only until `edit` is on, which also reveals the add
 * rows -- they used to show whether or not the old `add` mode was active, which
 * gated the harmless action while overwriting a value stayed live.
 *
 * `delete` stays its own mode so a row cannot be removed by mistake while
 * editing.
 */
export type TrackerEditMode = "edit" | "hide" | "lock" | "delete";
export type TrackerStatDensity = "normal" | "compact" | "tight";

export interface TrackerSpriteLookup {
  knownIds: Set<string>;
  idByName: Map<string, string>;
  pictureById: Record<string, string>;
  profileColorsById: Record<string, TrackerProfileColors>;
}
