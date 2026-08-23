// Placeholder rows are hidden, and a group of nothing but placeholders goes with
// them.
//
// A tracker prompt emits a fixed schema, so a field that does not apply comes back
// as a placeholder rather than absent. Footwear on a barefoot character is six
// rows of "-", "brak" and 0 that say nothing.
//
// The list is the user's. Placeholder conventions live in their prompt and follow
// its language, so no shipped set can cover them -- "brak" is Polish.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isBlankTrackerNode,
  isBlankTrackerValue,
  normalizeTrackerBlankValues,
  TRACKER_BLANK_VALUE_DEFAULTS,
} from "../../packages/shared/dist/index.js";

const readClient = (path: string) =>
  readFileSync(new URL(`../../packages/client/src/${path}`, import.meta.url), "utf8");

// ── The shipped defaults ──
// Language-neutral placeholders only. "0" is a real value on a heel height or a
// charge count, so it is opt-in rather than shipped.
assert.ok(TRACKER_BLANK_VALUE_DEFAULTS.includes("-"), "the bare dash is the common placeholder");
assert.equal(TRACKER_BLANK_VALUE_DEFAULTS.includes("0" as never), false, "zero is never blank by default");

// ── Normalizing the user's list ──
assert.deepEqual(normalizeTrackerBlankValues(["  Brak ", "N/A", "brak", "", "   "]), ["brak", "n/a"]);
assert.deepEqual(normalizeTrackerBlankValues(["-", 0, null, "none"]), ["-", "none"], "non-strings are dropped");
assert.deepEqual(normalizeTrackerBlankValues("not an array"), []);

// ── Leaf matching ──
const blanks = new Set(normalizeTrackerBlankValues([...TRACKER_BLANK_VALUE_DEFAULTS, "brak"]));
assert.equal(isBlankTrackerValue("-", blanks), true);
assert.equal(isBlankTrackerValue("  BRAK  ", blanks), true, "trimmed and case-insensitive");
assert.equal(isBlankTrackerValue("", blanks), true, "empty needs no configuring");
assert.equal(isBlankTrackerValue("   ", blanks), true, "whitespace only is empty");
assert.equal(isBlankTrackerValue(null, blanks), true);
// Whole-value equality, never substring: "brak" must not swallow "brakuje".
assert.equal(isBlankTrackerValue("brakuje", blanks), false, "substring matches would hide real values");
assert.equal(isBlankTrackerValue("szpilka", blanks), false);
// Numbers match only when listed, so a real zero survives the defaults.
assert.equal(isBlankTrackerValue(0, blanks), false, "zero is a value until the user says otherwise");
assert.equal(isBlankTrackerValue(0, new Set([...blanks, "0"])), true, "and blank once they do");

// ── Cascade: the footwear case ──
const barefoot = {
  Przedmiot: "-",
  "Typ obcasa": "brak",
  "Wysokosc obcasa": 0,
  Stan: "-",
  Polozenie: "-",
};
assert.equal(isBlankTrackerNode(barefoot, blanks), false, "a real 0 keeps the group visible under the defaults");
const withZero = new Set([...blanks, "0"]);
assert.equal(isBlankTrackerNode(barefoot, withZero), true, "listing 0 collapses the whole group");

// One real value anywhere keeps the group.
assert.equal(isBlankTrackerNode({ ...barefoot, "Typ obcasa": "szpilka" }, withZero), false);
// Nesting cascades all the way down.
assert.equal(isBlankTrackerNode({ Obuwie: { Lewy: barefoot, Prawy: barefoot } }, withZero), true);
assert.equal(isBlankTrackerNode([barefoot, { ...barefoot, Stan: "nowe" }], withZero), false);
// An empty container has nothing to show either way.
assert.equal(isBlankTrackerNode({}, blanks), true);
assert.equal(isBlankTrackerNode([], blanks), true);
// A leaf that is not blank is never a blank node.
assert.equal(isBlankTrackerNode("szpilka", blanks), false);

// ── Wiring ──
// Edit mode reveals blank rows, or a placeholder could never be typed over.
const extras = readClient("features/tracker-panel/components/character-card/CharacterTrackerExtras.tsx");
assert.equal(
  extras.includes("return !editMode && isBlankTrackerNode(value, blanks);"),
  true,
  "edit mode shows blank rows so they stay editable",
);
assert.equal(
  extras.includes("if (isEmptyTrackerExtraContainer(value)) return true;"),
  true,
  "an empty container stays hidden in every mode, as before",
);

const sections = readClient("features/tracker-panel/components/character-card/CharacterCardSections.tsx");
assert.equal(
  sections.includes("addMode || !isBlankTrackerValue(rawValue, blanks)"),
  true,
  "custom fields filter too, and edit mode reveals them",
);

// The lookup is memoized: it is passed down the extras tree, where a new Set per
// render would defeat the card's memo boundary.
const hook = readClient("features/tracker-panel/hooks/use-tracker-blank-values.ts");
assert.match(hook, /useMemo\(\(\) => new Set\(normalizeTrackerBlankValues\(values\)\), \[values\]\)/u);

console.log("tracker-blank-values regression passed.");
