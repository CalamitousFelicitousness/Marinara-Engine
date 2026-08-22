interface TrackerPanelDesktopWidthInput {
  preferredWidth: number;
  mainLeft: number;
  mainRight: number;
  chatColumnLeft: number;
  chatColumnRight: number;
  side: "left" | "right";
  gap?: number;
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
}: Omit<TrackerPanelDesktopWidthInput, "preferredWidth">) {
  const gutterWidth = side === "left" ? chatColumnLeft - mainLeft : mainRight - chatColumnRight;
  return Math.max(0, Math.floor(gutterWidth - gap));
}

/** Keep the desktop Tracker inside the free gutter beside the centered Roleplay chat column. */
export function resolveTrackerPanelDesktopWidth({ preferredWidth, ...gutter }: TrackerPanelDesktopWidthInput) {
  return Math.min(preferredWidth, resolveTrackerPanelGutterWidth(gutter));
}

/** Scale constrained Tracker contents while retaining a readable lower bound and responsive reflow. */
export function resolveTrackerPanelContentScale(preferredWidth: number, resolvedWidth: number, minimumScale = 0.65) {
  if (preferredWidth <= 0 || resolvedWidth <= 0 || resolvedWidth >= preferredWidth) return 1;
  return Math.max(minimumScale, resolvedWidth / preferredWidth);
}
