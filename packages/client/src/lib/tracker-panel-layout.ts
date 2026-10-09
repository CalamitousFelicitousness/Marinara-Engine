import { TRACKER_PANEL_MIN_DOCK_WIDTH, type TrackerPanelPlacement } from "./tracker-panel-size";

interface TrackerPanelDesktopWidthInput {
  preferredWidth: number;
  mainLeft: number;
  mainRight: number;
  chatColumnLeft: number;
  chatColumnRight: number;
  side: "left" | "right";
  gap?: number;
  /** Never narrower than this; AppShell narrows the chat column to leave that room. */
  minWidth?: number;
}

/**
 * Room actually available beside the centered Roleplay chat column. This is the
 * ceiling a resize drag must respect, otherwise releasing snaps the panel back.
 */
export function resolveTrackerPanelGutterWidth({
  mainLeft,
  mainRight,
  chatColumnLeft,
  chatColumnRight,
  side,
  gap = 0,
}: Omit<TrackerPanelDesktopWidthInput, "preferredWidth" | "minWidth">) {
  const gutterWidth = side === "left" ? chatColumnLeft - mainLeft : mainRight - chatColumnRight;
  return Math.max(0, Math.floor(gutterWidth - gap));
}

/** Keep the desktop Tracker inside the free gutter beside the centered Roleplay chat column. */
export function resolveTrackerPanelDesktopWidth({
  preferredWidth,
  minWidth = 0,
  ...gutter
}: TrackerPanelDesktopWidthInput) {
  return Math.max(minWidth, Math.min(preferredWidth, resolveTrackerPanelGutterWidth(gutter)));
}

/**
 * Room the Roleplay column leaves on each side for a Tracker Panel open on the desktop, by placement.
 * The column narrows by this much only when the chat pane is too small for both (globals.css
 * --tracker-panel-column-room), and it is fixed per placement so column and panel never resize each other.
 *
 *   dock   the width below which it would float instead, so it stays docked
 *   float  none; the panel sits over the chat column anyway
 *   scale  minDockedWidth, where its own buttons still fit while the type shrinks
 */
export function resolveTrackerPanelColumnRoom(
  placement: TrackerPanelPlacement,
  gap: number,
  minDockedWidth: number,
): number {
  if (placement === "float") return 0;
  return (placement === "dock" ? TRACKER_PANEL_MIN_DOCK_WIDTH : minDockedWidth) + gap;
}

/** Scale constrained Tracker contents while retaining a readable lower bound and responsive reflow. */
export function resolveTrackerPanelContentScale(preferredWidth: number, resolvedWidth: number, minimumScale = 0.65) {
  if (preferredWidth <= 0 || resolvedWidth <= 0 || resolvedWidth >= preferredWidth) return 1;
  return Math.max(minimumScale, resolvedWidth / preferredWidth);
}
