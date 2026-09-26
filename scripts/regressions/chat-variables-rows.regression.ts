// The Chat Variables editor folds saved values into its rows when a save
// settles. That fold must not throw away what the user typed in the meantime.
import assert from "node:assert/strict";
import {
  newDraftRow,
  reconcileRows,
  toRows,
  type VariableRow,
} from "../../packages/client/src/features/chat-settings/sections/chat-variables-rows.js";

const byName = (rows: VariableRow[], name: string) => rows.find((row) => row.name === name);

// An edit made while an earlier save was in flight survives the fold.
const editedDuringSave: VariableRow[] = [
  { key: "a", name: "char1", value: "Mary", savedName: "char1", savedValue: "Mary" },
  { key: "b", name: "char2", value: "Anna typing", savedName: "char2", savedValue: "Ana" },
];
const afterSave = reconcileRows(editedDuringSave, { char1: "Mary", char2: "Ana" });
assert.equal(byName(afterSave, "char2")!.value, "Anna typing", "an in-progress edit must not be overwritten");
assert.equal(byName(afterSave, "char2")!.savedValue, "Ana", "its saved snapshot still tracks the server");
assert.equal(byName(afterSave, "char1")!.value, "Mary");

// A rename in progress survives too, and is not mistaken for a new row.
const renaming: VariableRow[] = [{ key: "a", name: "lead", value: "Mary", savedName: "char1", savedValue: "Mary" }];
const afterRename = reconcileRows(renaming, { char1: "Mary" });
assert.equal(afterRename.length, 1, "the old name must not come back as a second row");
assert.equal(afterRename[0]!.name, "lead");
assert.equal(afterRename[0]!.savedName, "char1");

// An untouched row adopts a value changed elsewhere — this is how a {{setvar}}
// from a generation reaches the editor.
const untouched: VariableRow[] = [{ key: "a", name: "mood", value: "calm", savedName: "mood", savedValue: "calm" }];
const afterSetvar = reconcileRows(untouched, { mood: "tense" });
assert.equal(afterSetvar[0]!.value, "tense");
assert.equal(afterSetvar[0]!.savedValue, "tense");

// A name deleted elsewhere drops out when the row is clean...
assert.deepEqual(reconcileRows(untouched, {}), [], "a clean row for a deleted name disappears");

// ...but is kept while the user is mid-edit, so a background deletion cannot
// swallow their typing.
const editedThenDeleted: VariableRow[] = [
  { key: "a", name: "mood", value: "still typing", savedName: "mood", savedValue: "calm" },
];
const afterDelete = reconcileRows(editedThenDeleted, {});
assert.equal(afterDelete.length, 1);
assert.equal(afterDelete[0]!.value, "still typing");

// Names with no row yet are appended, and drafts stay at the end.
const withDraft: VariableRow[] = [
  { key: "a", name: "char1", value: "Mary", savedName: "char1", savedValue: "Mary" },
  { ...newDraftRow(), name: "char3", value: "half typed" },
];
const withNewName = reconcileRows(withDraft, { char1: "Mary", mood: "tense" });
assert.deepEqual(
  withNewName.map((row) => row.name),
  ["char1", "mood", "char3"],
  "a variable set elsewhere is appended before the draft row",
);
assert.equal(withNewName.at(-1)!.savedName, null, "the draft is still a draft");

// toRows seeds a saved snapshot, so a freshly loaded row reads as unedited.
const seeded = toRows({ char1: "Mary" });
assert.equal(seeded[0]!.savedName, "char1");
assert.equal(seeded[0]!.savedValue, "Mary");
assert.deepEqual(
  reconcileRows(seeded, { char1: "Mary" }).map((row) => row.value),
  ["Mary"],
);

// Non-string values in stored metadata are ignored rather than rendered.
assert.deepEqual(
  toRows({ ok: "yes", bad: 7 as unknown as string }).map((row) => row.name),
  ["ok"],
);

console.info("chat variables row reconciliation regressions passed.");
