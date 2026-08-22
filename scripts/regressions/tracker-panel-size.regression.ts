// Tracker panel width/density split.
//
// `trackerPanelSizeProfile` used to pick both the panel's pixel width and its
// type scale, so widening the panel enlarged text instead of showing more of it
// and a resize handle would have been pointless. Width and density are now
// independent. This lane pins the migration off the old profile, the clamp
// range, and the preset resolution the settings UI and the resize handle use.

import assert from "node:assert/strict";

import {
  clampTrackerPanelWidth,
  migrateTrackerPanelSize,
  nearestTrackerPanelPreset,
  normalizeTrackerPanelDensity,
  resolveTrackerPanelPreset,
  TRACKER_PANEL_PRESETS,
  TRACKER_PANEL_SIZE_PROFILE_WIDTHS,
  TRACKER_PANEL_WIDTH_DEFAULT,
  TRACKER_PANEL_WIDTH_MAX,
  TRACKER_PANEL_WIDTH_MIN,
} from "../../packages/client/src/lib/tracker-panel-size.js";
import {
  resolveTrackerPanelDesktopWidth,
  resolveTrackerPanelGutterWidth,
} from "../../packages/client/src/lib/tracker-panel-layout.js";
import { clampPanelWidth } from "../../packages/client/src/hooks/use-panel-resize.js";

// ── The two axes really are independent ──
// A preset pairs them, but nothing derives one from the other.
for (const [profile, preset] of Object.entries(TRACKER_PANEL_PRESETS)) {
  assert.equal(
    preset.width,
    TRACKER_PANEL_SIZE_PROFILE_WIDTHS[profile as keyof typeof TRACKER_PANEL_SIZE_PROFILE_WIDTHS],
  );
}
assert.deepEqual(TRACKER_PANEL_PRESETS.expanded, { width: 420, density: "comfortable" });
assert.deepEqual(TRACKER_PANEL_PRESETS.compact, { width: 280, density: "compact" });

// ── Drag range is wider than the presets ──
// Presets are starting points, not limits; the gutter clamp is what actually
// bounds the rendered width.
assert.ok(TRACKER_PANEL_WIDTH_MIN < TRACKER_PANEL_PRESETS.compact.width, "min must sit below the smallest preset");
assert.ok(TRACKER_PANEL_WIDTH_MAX > TRACKER_PANEL_PRESETS.expanded.width, "max must sit above the largest preset");

// ── Clamping ──
assert.equal(clampTrackerPanelWidth(500), 500);
assert.equal(clampTrackerPanelWidth(10), TRACKER_PANEL_WIDTH_MIN);
assert.equal(clampTrackerPanelWidth(99999), TRACKER_PANEL_WIDTH_MAX);
assert.equal(clampTrackerPanelWidth(340.4), 340, "widths are rounded to whole pixels");
assert.equal(clampTrackerPanelWidth(undefined), TRACKER_PANEL_WIDTH_DEFAULT);
assert.equal(clampTrackerPanelWidth("wide"), TRACKER_PANEL_WIDTH_DEFAULT);
assert.equal(clampTrackerPanelWidth(Number.NaN), TRACKER_PANEL_WIDTH_DEFAULT);

// ── Migration off the old profile ──
// A store on the profile era carries no width: both halves come from the preset.
assert.deepEqual(migrateTrackerPanelSize({ trackerPanelSizeProfile: "expanded" }), {
  width: 420,
  density: "comfortable",
});
assert.deepEqual(migrateTrackerPanelSize({ trackerPanelSizeProfile: "compact" }), { width: 280, density: "compact" });
assert.deepEqual(migrateTrackerPanelSize({}), { width: TRACKER_PANEL_WIDTH_DEFAULT, density: "standard" });

// A pre-profile store kept a free width; it wins, and density comes from the
// profile that width implies.
assert.deepEqual(migrateTrackerPanelSize({ trackerPanelWidth: 296 }), { width: 296, density: "compact" });
assert.deepEqual(migrateTrackerPanelSize({ trackerPanelWidth: 400 }), { width: 400, density: "comfortable" });

// Already migrated: both fields survive untouched.
assert.deepEqual(migrateTrackerPanelSize({ trackerPanelWidth: 512, trackerPanelDensity: "compact" }), {
  width: 512,
  density: "compact",
});

// A junk width does not poison the result.
assert.deepEqual(migrateTrackerPanelSize({ trackerPanelWidth: "440", trackerPanelSizeProfile: "standard" }), {
  width: TRACKER_PANEL_WIDTH_DEFAULT,
  density: "standard",
});

// ── Density normalization ──
assert.equal(normalizeTrackerPanelDensity("comfortable"), "comfortable");
assert.equal(normalizeTrackerPanelDensity(undefined), "standard");
assert.equal(normalizeTrackerPanelDensity("enormous"), "standard");
assert.equal(normalizeTrackerPanelDensity(undefined, "expanded"), "comfortable", "legacy profile supplies density");

// ── Preset resolution drives the settings UI ──
assert.equal(resolveTrackerPanelPreset(420, "comfortable"), "expanded");
assert.equal(resolveTrackerPanelPreset(340, "standard"), "standard");
// Drag off a preset and no button claims to be active.
assert.equal(resolveTrackerPanelPreset(421, "comfortable"), null);
// Right width, wrong density is not the preset either -- that is the whole point
// of splitting them.
assert.equal(resolveTrackerPanelPreset(420, "compact"), null);

// ── Nearest preset drives the handle's double-click reset ──
assert.equal(nearestTrackerPanelPreset(300), "compact");
assert.equal(nearestTrackerPanelPreset(311), "standard");
assert.equal(nearestTrackerPanelPreset(640), "expanded");
assert.equal(nearestTrackerPanelPreset(0), "compact", "clamped before comparing");

// ── The gutter is the drag ceiling ──
// A drag that can exceed the room beside the chat column snaps back on release,
// so the handle needs the gutter, not just the preferred width.
const gutterArgs = {
  mainLeft: 280,
  mainRight: 1920,
  chatColumnLeft: 636,
  chatColumnRight: 1564,
  side: "right" as const,
  gap: 8,
};
assert.equal(resolveTrackerPanelGutterWidth(gutterArgs), 348);
// Preferred width still wins while it fits.
assert.equal(resolveTrackerPanelDesktopWidth({ preferredWidth: 340, ...gutterArgs }), 340);
// And the gutter clamps once it does not.
assert.equal(resolveTrackerPanelDesktopWidth({ preferredWidth: 640, ...gutterArgs }), 348);
// A gutter narrower than the gap cannot go negative.
assert.equal(
  resolveTrackerPanelGutterWidth({ ...gutterArgs, chatColumnRight: 1919 }),
  0,
  "a collapsed gutter clamps to zero rather than inverting",
);

// ── The shared resize clamp ──
assert.equal(clampPanelWidth(300, 240, 640), 300);
assert.equal(clampPanelWidth(100, 240, 640), 240);
assert.equal(clampPanelWidth(900, 240, 640), 640);

console.log("tracker-panel-size regression passed.");
