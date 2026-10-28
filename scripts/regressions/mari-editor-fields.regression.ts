// Prof. Mari points at real Character editor fields: a change-card path and a running
// `character.update` step must name the same `data-mari-field` id the editor puts on the field.
import assert from "node:assert/strict";
import {
  characterPatchFieldId,
  editorFieldId,
  hasMariField,
  mariWorkingFieldFromTool,
  mariFieldDraft,
} from "../../packages/client/src/lib/mari-editor-fields.js";

// Change-card paths come from the row's `data` column.
assert.equal(editorFieldId("data.first_mes"), "first_mes");
assert.equal(editorFieldId("data.extensions.backstory"), "extensions.backstory");
assert.equal(editorFieldId("description"), "description");
assert.deepEqual(mariFieldDraft("description", "Make this warmer", 0, 9), {
  fieldId: "description",
  value: "Make this warmer",
  selection: "Make this",
});
assert.deepEqual(mariFieldDraft("description", "Draft", 2, 2), { fieldId: "description", value: "Draft" });
assert.equal(mariFieldDraft("tags", "half-typed", 0, 4), null, "a tag input is not the Tags field content");

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

// The server's action aliases glow too.
for (const action of ["characters.update", "Character.Update", " CHARACTERS.update "]) {
  assert.deepEqual(
    mariWorkingFieldFromTool("app_data", { action, characterId: "c1", patch: { scenario: "Storm" } }),
    { characterId: "c1", path: "scenario" },
    action,
  );
}

// "Open at this field" only for fields the editor anchors (itself or its parent).
assert.equal(hasMariField("data.first_mes"), true);
assert.equal(hasMariField("data.extensions.backstory"), true);
assert.equal(hasMariField("data.extensions.depth_prompt.role"), true);
assert.equal(hasMariField("data.tags"), true);
assert.equal(hasMariField("name"), true);
assert.equal(hasMariField("data.extensions.talkativeness"), false);
assert.equal(hasMariField("avatarPath"), false);
assert.equal(hasMariField("data.extensions"), false);

console.log("mari-editor-fields regression passed");
