// ──────────────────────────────────────────────
// Tracker panel size model
// ──────────────────────────────────────────────
// Three independent axes, deliberately not derived from one another:
//
//   width           dragged or set from a preset
//   text size       a legibility preference, its own header control
//   narrow behavior what happens when the gutter cannot hold the panel
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

/**
 * Where the panel sits relative to the chat column.
 *
 *   dock   beside the chat, reflowing as it narrows, floating only when the
 *          gutter drops below TRACKER_PANEL_MIN_DOCK_WIDTH. The default.
 *   float  always over the chat column, at whatever width the panel is set to,
 *          regardless of how much gutter there is.
 *   scale  always docked, shrinking type to fit. The behaviour that shipped
 *          before reflow existed, kept as an opt-out.
 */
export const TRACKER_PANEL_PLACEMENTS = ["dock", "float", "scale"] as const;
export type TrackerPanelPlacement = (typeof TRACKER_PANEL_PLACEMENTS)[number];
export const TRACKER_PANEL_PLACEMENT_DEFAULT: TrackerPanelPlacement = "dock";

/** The short-lived narrow-behaviour setting this replaced. */
const LEGACY_NARROW_BEHAVIOR_PLACEMENTS: Record<string, TrackerPanelPlacement> = {
  overlay: "dock",
  scale: "scale",
};

/**
 * Below this the docked panel cannot show a usable row at any type size, so
 * `overlay` stops docking and floats over the chat column instead. It is also
 * the card's stacked/two-column container breakpoint, which is not a
 * coincidence: it is the width at which a label and a value stop fitting side
 * by side.
 */
export const TRACKER_PANEL_MIN_DOCK_WIDTH = 176;

export const TRACKER_PANEL_WIDTH_DEFAULT = TRACKER_PANEL_SIZE_PROFILE_WIDTHS.standard;
// Deliberately wider than the presets: presets are starting points, not limits.
// resolveTrackerPanelDesktopWidth still clamps to the gutter actually available.
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

export function normalizeTrackerPanelPlacement(value: unknown, legacyNarrowBehavior?: unknown): TrackerPanelPlacement {
  if (TRACKER_PANEL_PLACEMENTS.includes(value as TrackerPanelPlacement)) return value as TrackerPanelPlacement;
  if (typeof legacyNarrowBehavior === "string" && legacyNarrowBehavior in LEGACY_NARROW_BEHAVIOR_PLACEMENTS) {
    return LEGACY_NARROW_BEHAVIOR_PLACEMENTS[legacyNarrowBehavior]!;
  }
  return TRACKER_PANEL_PLACEMENT_DEFAULT;
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

/** Nearest preset by width, for the resize handle's double-click reset. */
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
 * Returns the three fields from whatever the old store held.
 */
export function migrateTrackerPanelSize(persisted: {
  trackerPanelWidth?: unknown;
  trackerPanelTextSize?: unknown;
  trackerPanelDensity?: unknown;
  trackerPanelPlacement?: unknown;
  trackerPanelNarrowBehavior?: unknown;
  trackerPanelSizeProfile?: unknown;
}): { width: number; textSize: TrackerPanelTextSize; placement: TrackerPanelPlacement } {
  const legacyProfile = normalizeTrackerPanelSizeProfile(
    persisted.trackerPanelSizeProfile,
    persisted.trackerPanelWidth,
  );
  return {
    // An explicit width from before the profile era still wins.
    width: clampTrackerPanelWidth(persisted.trackerPanelWidth ?? TRACKER_PANEL_SIZE_PROFILE_WIDTHS[legacyProfile]),
    textSize: normalizeTrackerPanelTextSize(persisted.trackerPanelTextSize, persisted.trackerPanelDensity),
    placement: normalizeTrackerPanelPlacement(persisted.trackerPanelPlacement, persisted.trackerPanelNarrowBehavior),
  };
}
