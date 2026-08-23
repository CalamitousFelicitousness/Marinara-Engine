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
  nextTrackerPanelTextSize,
  normalizeTrackerPanelNarrowBehavior,
  normalizeTrackerPanelTextSize,
  resolveTrackerPanelPreset,
  TRACKER_PANEL_MIN_DOCK_WIDTH,
  TRACKER_PANEL_SIZE_PROFILE_WIDTHS,
  TRACKER_PANEL_TEXT_SCALES,
  TRACKER_PANEL_TEXT_SIZE_DEFAULT,
  TRACKER_PANEL_TEXT_SIZES,
  TRACKER_PANEL_WIDTH_DEFAULT,
  TRACKER_PANEL_WIDTH_MAX,
  TRACKER_PANEL_WIDTH_MIN,
} from "../../packages/client/src/lib/tracker-panel-size.js";
import {
  resolveTrackerPanelDesktopWidth,
  resolveTrackerPanelGutterWidth,
} from "../../packages/client/src/lib/tracker-panel-layout.js";
import { clampPanelWidth } from "../../packages/client/src/hooks/use-panel-resize.js";

// ── Three independent axes ──
// Presets set width only. Coupling text size into them would re-conflate the
// two things this change exists to separate.
assert.equal(resolveTrackerPanelPreset(420), "expanded");
assert.equal(resolveTrackerPanelPreset(280), "compact");

// ── Text size ──
// Four steps, no XS: an XS step lands near 7.6px labels, the unreadable state
// the reflow work exists to fix.
assert.deepEqual([...TRACKER_PANEL_TEXT_SIZES], ["s", "m", "l", "xl"]);
assert.equal(TRACKER_PANEL_TEXT_SIZE_DEFAULT, "l");
// Both ends are anchored to real numbers rather than picked by feel. The panel's
// row token is 0.625rem, the app's default root is 17px, and the chat body is
// 16px (chatFontSize default).
const ROW_TOKEN_PX = 0.625 * 17;
const CHAT_BODY_PX = 16;
assert.ok(
  TRACKER_PANEL_TEXT_SCALES.s * ROW_TOKEN_PX > 9,
  "S is the floor and must stay legible, not drift back toward the 6px state this replaced",
);
assert.ok(
  Math.abs(TRACKER_PANEL_TEXT_SCALES.xl * ROW_TOKEN_PX - CHAT_BODY_PX) < 1,
  "XL must reach the chat body size; smaller than the prose beside it is what made it feel wrong",
);
// Each press is the same proportional jump, so the control feels even.
{
  const scales = TRACKER_PANEL_TEXT_SIZES.map((size) => TRACKER_PANEL_TEXT_SCALES[size]);
  const ratios = scales.slice(1).map((value, index) => value / scales[index]!);
  assert.ok(
    Math.max(...ratios) - Math.min(...ratios) < 0.08,
    `steps should be near-geometric, got ratios ${ratios.map((r) => r.toFixed(3)).join(", ")}`,
  );
}
// Monotonic, so the header's cycle button always moves in one direction.
{
  const scales = TRACKER_PANEL_TEXT_SIZES.map((size) => TRACKER_PANEL_TEXT_SCALES[size]);
  assert.deepEqual(
    scales,
    [...scales].sort((a, b) => a - b),
  );
}
// The cycle wraps.
assert.equal(nextTrackerPanelTextSize("s"), "m");
assert.equal(nextTrackerPanelTextSize("xl"), "s");

assert.equal(normalizeTrackerPanelTextSize("xl"), "xl");
assert.equal(normalizeTrackerPanelTextSize("xs"), TRACKER_PANEL_TEXT_SIZE_DEFAULT, "a dropped step falls back");
assert.equal(normalizeTrackerPanelTextSize(undefined), TRACKER_PANEL_TEXT_SIZE_DEFAULT);
// The short-lived density setting maps onto the scale it became.
assert.equal(normalizeTrackerPanelTextSize(undefined, "compact"), "s");
assert.equal(normalizeTrackerPanelTextSize(undefined, "comfortable"), "l");

// ── Narrow behaviour ──
assert.equal(normalizeTrackerPanelNarrowBehavior(undefined), "overlay", "reflow-and-overlay is the default");
assert.equal(normalizeTrackerPanelNarrowBehavior("scale"), "scale", "shrinking type stays available as an opt-out");
assert.equal(normalizeTrackerPanelNarrowBehavior("zoom"), "overlay");
// The dock threshold is the same width at which a label and a value stop
// sharing a line, which is what makes overlaying the right answer below it.
assert.equal(TRACKER_PANEL_MIN_DOCK_WIDTH, 176);
assert.ok(TRACKER_PANEL_MIN_DOCK_WIDTH < TRACKER_PANEL_WIDTH_MIN);

// ── Drag range is wider than the presets ──
// Presets are starting points, not limits; the gutter clamp is what actually
// bounds the rendered width.
assert.ok(TRACKER_PANEL_WIDTH_MIN < TRACKER_PANEL_SIZE_PROFILE_WIDTHS.compact, "min sits below the smallest preset");
assert.ok(TRACKER_PANEL_WIDTH_MAX > TRACKER_PANEL_SIZE_PROFILE_WIDTHS.expanded, "max sits above the largest preset");

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
  textSize: "l",
  narrowBehavior: "overlay",
});
assert.deepEqual(migrateTrackerPanelSize({}), {
  width: TRACKER_PANEL_WIDTH_DEFAULT,
  textSize: "l",
  narrowBehavior: "overlay",
});
// A store that already migrated to the density step keeps its choice.
assert.equal(migrateTrackerPanelSize({ trackerPanelDensity: "compact" }).textSize, "s");
assert.equal(migrateTrackerPanelSize({ trackerPanelTextSize: "xl" }).textSize, "xl");
assert.equal(migrateTrackerPanelSize({ trackerPanelNarrowBehavior: "scale" }).narrowBehavior, "scale");

// A pre-profile store kept a free width; it wins, and density comes from the
// profile that width implies.
assert.equal(migrateTrackerPanelSize({ trackerPanelWidth: 296 }).width, 296);
assert.equal(migrateTrackerPanelSize({ trackerPanelWidth: 400 }).width, 400);

// Already migrated: both fields survive untouched.
assert.deepEqual(migrateTrackerPanelSize({ trackerPanelWidth: 512, trackerPanelTextSize: "s" }), {
  width: 512,
  textSize: "s",
  narrowBehavior: "overlay",
});

// A junk width does not poison the result.
assert.equal(
  migrateTrackerPanelSize({ trackerPanelWidth: "440", trackerPanelSizeProfile: "standard" }).width,
  TRACKER_PANEL_WIDTH_DEFAULT,
);

// ── Preset resolution drives the settings UI ──
assert.equal(resolveTrackerPanelPreset(340), "standard");
// Drag off a preset and no button claims to be active.
assert.equal(resolveTrackerPanelPreset(421), null);

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
