// ──────────────────────────────────────────────
// Tracker panel size model
// ──────────────────────────────────────────────
// Two independent axes, deliberately not derived from one another:
//
//   width      the desktop window's width, or a preset that resizes it
//   text size  a legibility preference, its own header control
//
// They used to be one setting. `trackerPanelSizeProfile` picked both a pixel
// width and a type scale, so widening the panel enlarged its text instead of
// showing more of it, and a resize handle would have bought nothing.
//
// Store-free on purpose: this is pure data plus the persisted-state migration,
// so a regression can assert it without booting a Zustand store, and ui.store.ts
// -- a file upstream edits constantly -- keeps only state and re-exports.

export const TRACKER_PANEL_SIZE_PROFILES = ["compact", "standard", "expanded"] as const;
/** A named width. Presets set width only; text size is a separate axis. */
export type TrackerPanelSizeProfile = (typeof TRACKER_PANEL_SIZE_PROFILES)[number];

export const TRACKER_PANEL_SIZE_PROFILE_WIDTHS: Record<TrackerPanelSizeProfile, number> = {
  compact: 280,
  standard: 340,
  expanded: 420,
};

/**
 * Four steps, no smaller. An XS step would land near 7.6px labels, which is the
 * unreadable state this whole change exists to fix.
 */
export const TRACKER_PANEL_TEXT_SIZES = ["s", "m", "l", "xl"] as const;
export type TrackerPanelTextSize = (typeof TRACKER_PANEL_TEXT_SIZES)[number];

/**
 * Multiplier applied to the panel's type and spacing tokens. Spacing rides along
 * with type so one control moves the whole card; splitting them lets a user
 * build large type in tight rows, which only ever looks broken.
 *
 * Anchored at both ends rather than picked by feel:
 *
 *   S   0.925  the floor, unchanged. The panel's row token is 0.625rem, so at
 *              the app's 17px root this is ~9.8px -- small but legible.
 *   XL  1.5    lands row text at ~15.9px, level with the 16px chat body
 *              (`chatFontSize` default). XL previously stopped at ~13.3px,
 *              which read as smaller than the prose beside it.
 *
 * The two middle steps are geometric between those, so each press is the same
 * proportional jump rather than a flat one.
 */
export const TRACKER_PANEL_TEXT_SCALES: Record<TrackerPanelTextSize, number> = {
  s: 0.925,
  m: 1.1,
  l: 1.3,
  xl: 1.5,
};

export const TRACKER_PANEL_TEXT_SIZE_DEFAULT: TrackerPanelTextSize = "l";

export const TRACKER_PANEL_WIDTH_DEFAULT = TRACKER_PANEL_SIZE_PROFILE_WIDTHS.standard;
// Deliberately wider than the presets: presets are starting points, not limits.
export const TRACKER_PANEL_WIDTH_MIN = 240;
export const TRACKER_PANEL_WIDTH_MAX = 640;

export function clampTrackerPanelWidth(value: unknown) {
  const width = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : TRACKER_PANEL_WIDTH_DEFAULT;
  return Math.max(TRACKER_PANEL_WIDTH_MIN, Math.min(TRACKER_PANEL_WIDTH_MAX, width));
}

export function getTrackerPanelWidthForProfile(profile: TrackerPanelSizeProfile) {
  return TRACKER_PANEL_SIZE_PROFILE_WIDTHS[profile] ?? TRACKER_PANEL_SIZE_PROFILE_WIDTHS.standard;
}

/**
 * Legacy profile resolution, kept for the persisted-state migration only.
 * `legacyWidth` covers stores written before the profile existed.
 */
export function normalizeTrackerPanelSizeProfile(value: unknown, legacyWidth?: unknown): TrackerPanelSizeProfile {
  if (TRACKER_PANEL_SIZE_PROFILES.includes(value as TrackerPanelSizeProfile)) {
    return value as TrackerPanelSizeProfile;
  }

  const width =
    typeof legacyWidth === "number" && Number.isFinite(legacyWidth) ? clampTrackerPanelWidth(legacyWidth) : null;
  if (width !== null) {
    if (width <= 300) return "compact";
    if (width >= 380) return "expanded";
  }

  return "standard";
}

/** Maps the short-lived density setting onto the text-size scale it became. */
const LEGACY_DENSITY_TEXT_SIZES: Record<string, TrackerPanelTextSize> = {
  compact: "s",
  standard: "m",
  comfortable: "l",
};

export function normalizeTrackerPanelTextSize(value: unknown, legacyDensity?: unknown): TrackerPanelTextSize {
  if (TRACKER_PANEL_TEXT_SIZES.includes(value as TrackerPanelTextSize)) return value as TrackerPanelTextSize;
  if (typeof legacyDensity === "string" && legacyDensity in LEGACY_DENSITY_TEXT_SIZES) {
    return LEGACY_DENSITY_TEXT_SIZES[legacyDensity]!;
  }
  return TRACKER_PANEL_TEXT_SIZE_DEFAULT;
}

/** Next step in the header's cycle button, wrapping at the end. */
export function nextTrackerPanelTextSize(current: TrackerPanelTextSize): TrackerPanelTextSize {
  const index = TRACKER_PANEL_TEXT_SIZES.indexOf(current);
  return TRACKER_PANEL_TEXT_SIZES[(index + 1) % TRACKER_PANEL_TEXT_SIZES.length]!;
}

/** Which width preset is active, or null once the user has dragged off all of them. */
export function resolveTrackerPanelPreset(width: number): TrackerPanelSizeProfile | null {
  const clamped = clampTrackerPanelWidth(width);
  return TRACKER_PANEL_SIZE_PROFILES.find((profile) => TRACKER_PANEL_SIZE_PROFILE_WIDTHS[profile] === clamped) ?? null;
}

/** Nearest preset by width, for a window resized off every preset. */
export function nearestTrackerPanelPreset(width: number): TrackerPanelSizeProfile {
  const clamped = clampTrackerPanelWidth(width);
  return TRACKER_PANEL_SIZE_PROFILES.reduce((closest, profile) =>
    Math.abs(TRACKER_PANEL_SIZE_PROFILE_WIDTHS[profile] - clamped) <
    Math.abs(TRACKER_PANEL_SIZE_PROFILE_WIDTHS[closest] - clamped)
      ? profile
      : closest,
  );
}

/**
 * Persisted-state migration for the size model.
 * Returns the two fields from whatever the old store held.
 */
export function migrateTrackerPanelSize(persisted: {
  trackerPanelWidth?: unknown;
  trackerPanelTextSize?: unknown;
  trackerPanelDensity?: unknown;
  trackerPanelSizeProfile?: unknown;
}): { width: number; textSize: TrackerPanelTextSize } {
  const legacyProfile = normalizeTrackerPanelSizeProfile(
    persisted.trackerPanelSizeProfile,
    persisted.trackerPanelWidth,
  );
  return {
    // An explicit width from before the profile era still wins.
    width: clampTrackerPanelWidth(persisted.trackerPanelWidth ?? TRACKER_PANEL_SIZE_PROFILE_WIDTHS[legacyProfile]),
    textSize: normalizeTrackerPanelTextSize(persisted.trackerPanelTextSize, persisted.trackerPanelDensity),
  };
}

const LEGACY_SIZE_KEYS = ["trackerPanelSizeProfile", "trackerPanelDensity", "trackerPanelNarrowBehavior"] as const;
// Settings of the edge-docked panel the desktop window replaced.
export const RETIRED_TRACKER_PANEL_KEYS = ["trackerPanelPlacement"] as const;

/**
 * Same migration for the server-synced settings blob, in place. A blob with no
 * legacy keys keeps its text size as written; only the width is clamped.
 */
export function migrateSyncedTrackerPanelSize(settings: Record<string, unknown>): void {
  if (LEGACY_SIZE_KEYS.some((key) => key in settings)) {
    const size = migrateTrackerPanelSize(settings);
    settings.trackerPanelWidth = size.width;
    settings.trackerPanelTextSize = size.textSize;
    for (const key of LEGACY_SIZE_KEYS) delete settings[key];
  } else if ("trackerPanelWidth" in settings) {
    settings.trackerPanelWidth = clampTrackerPanelWidth(settings.trackerPanelWidth);
  }
  for (const key of RETIRED_TRACKER_PANEL_KEYS) delete settings[key];
}
