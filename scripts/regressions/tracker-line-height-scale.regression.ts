// Tracker line boxes must scale with the tracker font scale.
//
// Font sizes come from --tracker-fs-* tokens, which multiply by
// --tracker-text-scale (the user's S/M/L/XL setting) and
// --tracker-panel-font-scale. Every line-height in the panel was a fixed rem,
// so it did not. At the default size L the multiplier is 1.3, which put a
// 0.8125rem gauge label inside a 0.75rem line box -- a line box smaller than
// its own font. Under the overflow-hidden that FittedText needs for its
// ellipsis, that shears the descenders off y, g, ą and ę.
//
// A unitless line-height is a ratio of the element's own font-size, so it
// tracks both scales with no token, no breakpoint override, and no globals.css
// allowlist. This pins that: no length-valued leading anywhere in the panel.
//
// Also pins the gauge rail wrapping, which was a snap carousel with
// scrollbar-hide -- a fifth stat scrolled off an edge with no affordance.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const PANEL_DIR = fileURLToPath(new URL("../../packages/client/src/features/tracker-panel/", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/u.test(path) ? [path] : [];
  });
}

const sources = walk(PANEL_DIR).map((path) => ({ path, text: readFileSync(path, "utf8") }));
assert.ok(sources.length > 20, `expected the panel's sources, found ${sources.length}`);

// ── No length-valued line-height ──
// leading-3/4/5/6 are 0.75/1/1.25/1.5rem; leading-[Xrem] is explicit. Both are
// fixed while the font they size is not. Unitless leading-[1.25], leading-none
// and leading-tight are ratios and stay legal.
const FIXED_LEADING = /(?:^|["\s:])(?:@[a-z]+-\[[^\]]+\]:)?leading-(?:\[[\d.]+(?:rem|px|em)\]|[3-6])(?=["\s]|$)/gmu;
const offenders = sources.flatMap(({ path, text }) =>
  [...text.matchAll(FIXED_LEADING)].map((match) => `${path.slice(PANEL_DIR.length)}: ${match[0].trim()}`),
);
assert.deepEqual(offenders, [], `fixed line-height in the tracker panel:\n${offenders.join("\n")}`);

// Guard the guard: the pattern must actually recognise the shapes it forbids.
for (const sample of ['"leading-3"', '"leading-[0.875rem]"', '"@min-[380px]:leading-4"', '"x leading-5"']) {
  assert.match(sample, new RegExp(FIXED_LEADING.source, "u"), `pattern missed ${sample}`);
}
for (const sample of ['"leading-[1.25]"', '"leading-none"', '"leading-tight"', '"leading-[1.3]"']) {
  assert.doesNotMatch(sample, new RegExp(FIXED_LEADING.source, "u"), `pattern over-matched ${sample}`);
}

// ── The nameplate floors its height rather than capping it ──
const nameplate = readFileSync(join(PANEL_DIR, "components/controls/TrackerProfileNameplate.tsx"), "utf8");
const nameplateClass = /NAMEPLATE_CLASS = cn\(\s*"([^"]+)"/u.exec(nameplate)?.[1] ?? "";
assert.ok(nameplateClass.includes("min-h-5"), "nameplate keeps its 1.25rem floor");
assert.ok(
  !/(?:^|\s)h-5(?:\s|$)/u.test(nameplateClass),
  `nameplate must not cap its height while the name scales: ${nameplateClass}`,
);

// The compact card's nameplate is a separate constant with the same shape.
const compactCard = readFileSync(join(PANEL_DIR, "components/character-card/CharacterTrackerCard.tsx"), "utf8");
const compactNameplate = /CHARACTER_NAMEPLATE_CLASS =\s*"([^"]+)"/u.exec(compactCard)?.[1] ?? "";
assert.ok(compactNameplate.includes("min-h-[1.35rem]"), "compact nameplate keeps its floor");
assert.ok(
  !/(?:^|\s)h-\[1\.35rem\](?:\s|$)/u.test(compactNameplate),
  `compact nameplate must not cap its height: ${compactNameplate}`,
);

// ── Gauges wrap instead of scrolling off the edge ──
const statList = readFileSync(join(PANEL_DIR, "components/controls/StatList.tsx"), "utf8");
const wrapClass = /GAUGE_RAIL_WRAP_CLASS =\s*"([^"]+)"/u.exec(statList)?.[1] ?? "";
assert.match(wrapClass, /grid-cols-\[repeat\(auto-fit,minmax\([\d.]+rem,1fr\)\)\]/u, wrapClass);
assert.ok(!wrapClass.includes("overflow-x-auto"), "the wrapping rail must not also scroll");
assert.ok(!wrapClass.includes("snap-"), "snap points belong to the carousel, not the grid");
// The ornament rail is the one-row case, so it may still scroll.
const ornamentClass = /GAUGE_RAIL_ORNAMENT_CLASS = "([^"]+)"/u.exec(statList)?.[1] ?? "";
assert.ok(ornamentClass.includes("flex"), "the ornament rail stays a flex row");
assert.match(
  statList,
  /showGaugeOrnaments \? GAUGE_RAIL_ORNAMENT_CLASS : GAUGE_RAIL_WRAP_CLASS/u,
  "the rail must pick a mode from the gauge count",
);

console.log("tracker-line-height-scale regression passed.");
