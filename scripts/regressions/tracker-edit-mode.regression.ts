// Tracker rows are read-only until edit mode, and the add rows go with them.
//
// Before, every value was editable all the time while "add mode" gated only the
// `+ Add row` affordances -- the mode guarded the harmless action and left
// overwriting a value permanently live. `add` became `edit`: it turns on inline
// editing and reveals the add rows together. `delete` stays separate so a row
// cannot be removed by mistake while editing.
//
// Verified in a browser: inside edit mode one add row and one live input; outside,
// zero of each.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readClient = (path: string) =>
  readFileSync(new URL(`../../packages/client/src/${path}`, import.meta.url), "utf8");

const types = readClient("features/tracker-panel/tracker-panel.types.ts");
const sidebar = readClient("features/tracker-panel/components/TrackerDataSidebar.tsx");
const lockContext = readClient("features/tracker-panel/components/TrackerLockContext.tsx");
const inlineControls = readClient("features/tracker-panel/components/controls/InlineControls.tsx");
const header = readClient("features/tracker-panel/components/TrackerSidebarHeader.tsx");
const en = JSON.parse(readClient("localization/locales/en.json")) as Record<string, string>;

// ── The mode itself ──
const modes = /export type TrackerEditMode = ([^;]+);/u.exec(types)?.[1] ?? "";
assert.match(modes, /"edit"/u, "edit replaces add");
assert.doesNotMatch(modes, /"add"/u, "add mode is gone; editing and adding are one mode");
assert.match(modes, /"delete"/u, "delete stays its own mode to prevent accidental removal");

assert.equal(
  sidebar.includes('const addMode = activeEditMode === "edit"'),
  true,
  "the add affordances follow edit mode",
);
assert.equal(sidebar.includes("editMode={addMode}"), true, "edit mode reaches the lock context");
assert.equal(lockContext.includes("editMode?: boolean"), true, "the context carries edit mode");

// ── The read-only gate ──
// `editMode === false`, never `!editMode`. InlineEdit and InlineNumber are also
// used by the Roleplay HUD, which sits outside TrackerLockProvider and therefore
// reads `undefined` -- `!undefined` is true, which would make the HUD read-only.
const gates = [...inlineControls.matchAll(/useTrackerLockContext\(\)\.editMode\s*===\s*false/gu)];
assert.equal(gates.length, 2, `InlineEdit and InlineNumber both gate on an explicit false, got ${gates.length}`);
assert.equal(
  /useTrackerLockContext\(\)\.editMode\s*\)/u.test(inlineControls) ||
    /!\s*useTrackerLockContext\(\)\.editMode/u.test(inlineControls),
  false,
  "a truthiness check would make the Roleplay HUD read-only, since it has no provider",
);
assert.equal(inlineControls.includes("if (readOnly) return;"), true, "a read-only field does not open an editor");
assert.equal(inlineControls.includes("readOnly={readOnly}"), true, "the number input is read-only too");

// Lock mode still toggles the lock rather than doing nothing.
assert.match(
  inlineControls,
  /if \(lockToggleActive\) \{[\s\S]{0,80}?onToggleLock\?\.\(\);[\s\S]{0,40}?\}\s*\n\s*if \(readOnly\) return;/u,
  "the lock toggle is checked before the read-only gate",
);

// ── Toolbar wording ──
for (const key of ["enterEditMode", "exitEditMode", "enterTrackerEditMode", "exitTrackerEditMode"]) {
  assert.equal(typeof en[`ui.trackerPanel.trackersidebarheader.${key}`], "string", `${key} is localized`);
  assert.equal(header.includes(key), true, `the toolbar uses ${key}`);
}
for (const retired of ["enterAddMode", "exitAddMode", "enterTrackerAddMode", "exitTrackerAddMode"]) {
  assert.equal(
    `ui.trackerPanel.trackersidebarheader.${retired}` in en,
    false,
    `${retired} is retired and must not linger in the catalog`,
  );
}

console.log("tracker-edit-mode regression passed.");
