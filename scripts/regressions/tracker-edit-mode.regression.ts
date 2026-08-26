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

// ── Every add affordance follows edit mode ──
// The nested-extras "Add row" was gated only on the node being an array, so it
// showed in every mode -- the one add control the mode did not govern. It reaches
// both card layouts through the shared section tail, so this is a single gate.
const extras = readClient("features/tracker-panel/components/character-card/CharacterTrackerExtras.tsx");
const sections = readClient("features/tracker-panel/components/character-card/CharacterCardSections.tsx");
assert.equal(extras.includes("{addMode && Array.isArray(node) && ("), true, "the extras add row is gated on edit mode");
assert.equal(sections.includes("addMode={addMode}"), true, "the shared section tail passes edit mode to extras");

// Every other add control was already gated; keep it that way.
//
// A panel may satisfy this two ways: render its own gated <AddRowButton>, or
// hand `addMode` to StatList and let the shared control gate. Upstream's
// "unify tracker and settings controls" moved PersonaInventoryPanel to the
// second shape, so accepting only the first would fail a panel that is still
// correctly gated. StatList's own gates are asserted below, so delegation is
// only accepted because the delegate is checked.
for (const file of [
  "sections/CharacterTrackerPanel.tsx",
  "sections/CustomTrackerPanel.tsx",
  "sections/InventoryTrackerPanel.tsx",
  "sections/PersonaInventoryPanel.tsx",
  "sections/quest-tracker/QuestBoard.tsx",
  "sections/WorldStatePanel.tsx",
]) {
  const source = readClient(`features/tracker-panel/components/${file}`);
  const gatesOwnButton = /addMode (\?|&&)[\s\S]{0,120}?<AddRowButton/u.test(source);
  const delegatesToStatList = /<StatList[\s\S]{0,400}?addMode=\{addMode\}/u.test(source);
  assert.equal(
    gatesOwnButton || delegatesToStatList,
    true,
    `${file} must gate its own AddRowButton or hand addMode to StatList`,
  );
  // Whichever shape it uses, it must not also carry an ungated add control.
  assert.equal(
    /(?<!addMode[^<]{0,120})<AddRowButton/u.test(source) && !gatesOwnButton,
    false,
    `${file} has an AddRowButton that edit mode does not govern`,
  );
}

// The delegate. Both of StatList's add paths -- the empty-state one and the
// trailing row -- are what PersonaInventoryPanel now relies on.
const statList = readClient("features/tracker-panel/components/controls/StatList.tsx");
assert.match(statList, /return addMode \? \(\s*<InlineAddRow/u, "StatList gates its empty-state add row");
assert.match(statList, /\{addMode && \(\s*<InlineAddRow/u, "StatList gates its trailing add row");

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
