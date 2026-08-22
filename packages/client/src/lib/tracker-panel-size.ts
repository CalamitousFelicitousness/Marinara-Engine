// ──────────────────────────────────────────────
// Tracker panel size model
// ──────────────────────────────────────────────
// Panel width and content density are independent settings. They used to be one
// (`trackerPanelSizeProfile` picked both a pixel width and a type scale), which
// meant widening the panel enlarged its text instead of showing more of it, and
// made a resize handle pointless.
//
// Store-free on purpose: this is pure data plus the persisted-state migration,
// so a regression can assert it without booting a Zustand store, and ui.store.ts
// -- a file upstream edits constantly -- keeps only state and re-exports.

export const TRACKER_PANEL_SIZE_PROFILES = ["compact", "standard", "expanded"] as const;
/** A named width+density pairing. A preset, not the storage model. */
export type TrackerPanelSizeProfile = (typeof TRACKER_PANEL_SIZE_PROFILES)[number];

export const TRACKER_PANEL_DENSITIES = ["comfortable", "standard", "compact"] as const;
/** Type and spacing scale. Never derived from width. */
export type TrackerPanelDensity = (typeof TRACKER_PANEL_DENSITIES)[number];

export const TRACKER_PANEL_SIZE_PROFILE_WIDTHS: Record<TrackerPanelSizeProfile, number> = {
  compact: 280,
  standard: 340,
  expanded: 420,
};

export const TRACKER_PANEL_PRESETS: Record<TrackerPanelSizeProfile, { width: number; density: TrackerPanelDensity }> = {
  compact: { width: TRACKER_PANEL_SIZE_PROFILE_WIDTHS.compact, density: "compact" },
  standard: { width: TRACKER_PANEL_SIZE_PROFILE_WIDTHS.standard, density: "standard" },
  expanded: { width: TRACKER_PANEL_SIZE_PROFILE_WIDTHS.expanded, density: "comfortable" },
};

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

/** Density, falling back to the density half of a legacy profile so an upgrade looks unchanged. */
export function normalizeTrackerPanelDensity(value: unknown, legacyProfile?: unknown): TrackerPanelDensity {
  if (TRACKER_PANEL_DENSITIES.includes(value as TrackerPanelDensity)) return value as TrackerPanelDensity;
  if (TRACKER_PANEL_SIZE_PROFILES.includes(legacyProfile as TrackerPanelSizeProfile)) {
    return TRACKER_PANEL_PRESETS[legacyProfile as TrackerPanelSizeProfile].density;
  }
  return "standard";
}

/** Which preset button is active, or null once the user has dragged off all of them. */
export function resolveTrackerPanelPreset(width: number, density: TrackerPanelDensity): TrackerPanelSizeProfile | null {
  const clamped = clampTrackerPanelWidth(width);
  return (
    TRACKER_PANEL_SIZE_PROFILES.find(
      (profile) =>
        TRACKER_PANEL_PRESETS[profile].width === clamped && TRACKER_PANEL_PRESETS[profile].density === density,
    ) ?? null
  );
}

/** Nearest preset by width, for the resize handle's double-click reset. */
export function nearestTrackerPanelPreset(width: number): TrackerPanelSizeProfile {
  const clamped = clampTrackerPanelWidth(width);
  return TRACKER_PANEL_SIZE_PROFILES.reduce((closest, profile) =>
    Math.abs(TRACKER_PANEL_PRESETS[profile].width - clamped) < Math.abs(TRACKER_PANEL_PRESETS[closest].width - clamped)
      ? profile
      : closest,
  );
}

/**
 * Persisted-state migration for the width/density split.
 * Returns the two new fields from whatever the old store held.
 */
export function migrateTrackerPanelSize(persisted: {
  trackerPanelWidth?: unknown;
  trackerPanelDensity?: unknown;
  trackerPanelSizeProfile?: unknown;
}): { width: number; density: TrackerPanelDensity } {
  const legacyProfile = normalizeTrackerPanelSizeProfile(
    persisted.trackerPanelSizeProfile,
    persisted.trackerPanelWidth,
  );
  return {
    // An explicit width from before the profile era still wins.
    width: clampTrackerPanelWidth(persisted.trackerPanelWidth ?? TRACKER_PANEL_PRESETS[legacyProfile].width),
    density: normalizeTrackerPanelDensity(persisted.trackerPanelDensity, legacyProfile),
  };
}
