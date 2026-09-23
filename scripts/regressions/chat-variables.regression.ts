// Chat variables: a per-chat {{name}} the user defines in Chat Settings and
// types into a message. Covers the engine lookup order, the guards that keep
// prototype members out of prompts, and the creation-time name rules.
import assert from "node:assert/strict";
import {
  RESERVED_MACRO_NAMES,
  resolveMacros,
  validateChatVariableName,
  type MacroContext,
} from "../../packages/shared/src/index.js";

const baseContext = (overrides: Partial<MacroContext> = {}): MacroContext => ({
  user: "Kentaro",
  char: "Pantalone",
  characters: ["Pantalone"],
  variables: {},
  ...overrides,
});

// A name defined in Chat Settings resolves anywhere macros do, including a
// message the user typed.
assert.equal(
  resolveMacros("{{char1}} walks in.", baseContext({ localVariables: { char1: "Mary" } }), {}),
  "Mary walks in.",
);

// Preset variables keep precedence, matching the post-assembly merge.
assert.equal(
  resolveMacros("{{char1}}", baseContext({ variables: { char1: "Preset" }, localVariables: { char1: "Chat" } }), {}),
  "Preset",
);

// Unknown names still survive verbatim.
assert.equal(resolveMacros("{{nope}}", baseContext({ localVariables: { char1: "Mary" } }), {}), "{{nope}}");

// Built-in macros run first, so a chat variable cannot shadow one.
assert.equal(resolveMacros("{{char}}", baseContext({ localVariables: { char: "Wrong" } }), {}), "Pantalone");

// Prototype members are not variables. Before the own-property guard these
// rendered native-code source text into the prompt.
for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
  assert.equal(resolveMacros(`{{${name}}}`, baseContext(), {}), `{{${name}}}`, name);
  assert.equal(
    resolveMacros(`{{${name}}}`, baseContext({ localVariables: {} }), {}),
    `{{${name}}}`,
    `${name} with a chat map`,
  );
}

// A {{setvar}} earlier in the same resolution is visible to a later bare tag,
// and the caller's map keeps the value for the next turn.
const liveVariables: Record<string, string> = {};
assert.equal(
  resolveMacros("{{setvar::char1::Anna}}{{char1}}", baseContext({ localVariables: liveVariables }), {}),
  "Anna",
);
assert.deepEqual(liveVariables, { char1: "Anna" });

// Conditionals read the same map, both as an explicit var: operand and bare.
assert.equal(
  resolveMacros("{{#if var:char1}}yes{{/if}}", baseContext({ localVariables: { char1: "Mary" } }), {}),
  "yes",
);
assert.equal(
  resolveMacros('{{#if char1 == "Mary"}}yes{{else}}no{{/if}}', baseContext({ localVariables: { char1: "Mary" } }), {}),
  "yes",
);

// An unset name reads as empty through getvar, unchanged behavior.
assert.equal(resolveMacros("[{{getvar::missing}}]", baseContext({ localVariables: {} }), {}), "[]");

// Creation-time name rules.
assert.equal(validateChatVariableName("char1"), null);
assert.equal(validateChatVariableName("_private"), null);
assert.equal(validateChatVariableName("  spaced  "), null, "names are trimmed before validation");
assert.equal(validateChatVariableName(""), "empty");
assert.equal(validateChatVariableName("1char"), "format");
assert.equal(validateChatVariableName("story.day"), "format", "a dotted name could never resolve as a bare tag");
assert.equal(validateChatVariableName("my-var"), "format");
assert.equal(validateChatVariableName("a".repeat(65)), "format");
assert.equal(validateChatVariableName("char"), "reserved");
assert.equal(validateChatVariableName("USER"), "reserved", "built-in passes are case-insensitive");
assert.equal(validateChatVariableName("__proto__"), "reserved", "object members are not variable names");
assert.equal(validateChatVariableName("constructor"), "reserved");
assert.equal(validateChatVariableName("char1", ["char1"]), "duplicate");
assert.equal(validateChatVariableName("char1", ["char2"]), null);

for (const reserved of ["char", "user", "input", "date", "time", "random", "roll", "getvar", "setvar"]) {
  assert.ok(RESERVED_MACRO_NAMES.has(reserved), `${reserved} must be reserved`);
}

console.info("chat variables regressions passed.");
