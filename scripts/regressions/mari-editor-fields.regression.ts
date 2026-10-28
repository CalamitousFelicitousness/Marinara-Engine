// Prof. Mari points at real Character editor fields: a change-card path and a running
// `character.update` step must name the same `data-mari-field` id the editor puts on the field.
import assert from "node:assert/strict";
import {
  characterPatchFieldId,
  editorFieldId,
  mariWorkingFieldFromTool,
} from "../../packages/client/src/lib/mari-editor-fields.js";

// Change-card paths come from the row's `data` column.
assert.equal(editorFieldId("data.first_mes"), "first_mes");
assert.equal(editorFieldId("data.extensions.backstory"), "extensions.backstory");
assert.equal(editorFieldId("description"), "description");

// Patch keys in every spelling the server accepts map to the editor id; unknown keys do not.
assert.equal(characterPatchFieldId("firstMes"), "first_mes");
assert.equal(characterPatchFieldId("firstMessage"), "first_mes");
assert.equal(characterPatchFieldId("postHistoryInstructions"), "post_history_instructions");
assert.equal(characterPatchFieldId("backstory"), "extensions.backstory");
assert.equal(characterPatchFieldId("appearance"), "extensions.appearance");
assert.equal(characterPatchFieldId("description"), "description");
assert.equal(characterPatchFieldId("characterId"), null);
assert.equal(characterPatchFieldId("comment"), null);

// A running step: the first field of its patch, wherever the fields sit.
assert.deepEqual(
  mariWorkingFieldFromTool("app_data", {
    action: "character.update",
    characterId: "c1",
    patch: { appearance: "Silver hair", personality: "Dry" },
    apply: true,
  }),
  { characterId: "c1", path: "extensions.appearance" },
);
assert.deepEqual(mariWorkingFieldFromTool("app_data", { action: "character.update", id: "c2", firstMes: "Hi" }), {
  characterId: "c2",
  path: "first_mes",
});
// Not a character field edit: no glow.
assert.equal(mariWorkingFieldFromTool("app_data", { action: "character.create", data: { name: "X" } }), null);
assert.equal(
  mariWorkingFieldFromTool("app_data", { action: "character.update", characterId: "c1", comment: "x" }),
  null,
);
assert.equal(
  mariWorkingFieldFromTool("web_search", { action: "character.update", characterId: "c1", name: "X" }),
  null,
);

console.log("mari-editor-fields regression passed");
