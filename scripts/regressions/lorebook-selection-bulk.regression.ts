import assert from "node:assert/strict";
import { planLorebookSelectionEnable } from "../../packages/client/src/lib/lorebook-selection.js";

const enabledById = new Map([
  ["world", true],
  ["expansion", false],
  ["notes", false],
]);
assert.deepEqual(
  planLorebookSelectionEnable(["world", "expansion", "notes", "gone"], enabledById, true),
  ["expansion", "notes"],
  "Enable only sends the disabled ones and skips unknown ids",
);
assert.deepEqual(
  planLorebookSelectionEnable(new Set(["world", "expansion"]), enabledById, false),
  ["world"],
  "Disable only sends the enabled ones",
);
assert.deepEqual(
  planLorebookSelectionEnable(["world"], enabledById, true),
  [],
  "nothing to flip leaves the action idle",
);

console.log("lorebook-selection-bulk regression passed");
