import assert from "node:assert/strict";
import { renderAgentPromptTemplate } from "../../packages/server/src/services/agents/agent-executor.js";
import { buildChatMacroContext } from "../../packages/server/src/services/prompt/macro-context.js";
import {
  buildPresetVariables,
  loadPresetVariables,
} from "../../packages/server/src/services/prompt/preset-variables.js";
import { resolveMacros } from "../../packages/shared/src/utils/macro-engine.js";
import type { AgentContext } from "../../packages/shared/src/types/agent.js";

const choiceBlocks = [
  {
    variableName: "narration",
    options: JSON.stringify([
      { id: "1", label: "First person", value: "first person" },
      { id: "2", label: "Second person", value: "second person" },
    ]),
    multiSelect: "false",
    randomPick: "false",
    separator: ", ",
  },
  {
    variableName: "language",
    options: JSON.stringify([
      { id: "1", label: "English", value: "English" },
      { id: "2", label: "Polish", value: "Polish" },
    ]),
    multiSelect: "false",
    randomPick: "false",
    separator: ", ",
  },
];

const variables = buildPresetVariables({
  variableValues: JSON.stringify({ tone: "wry", narration: "third person" }),
  choiceBlocks,
  chatChoices: { narration: "second person", language: "Polish" },
});

assert.equal(variables.narration, "second person", "a choice selection overrides the stored variable value");
assert.equal(variables.language, "Polish", "every choice block lands in the variable namespace");
assert.equal(variables.tone, "wry", "stored variable-group values survive alongside choice blocks");

const unselected = buildPresetVariables({
  variableValues: "{}",
  choiceBlocks,
  chatChoices: {},
});
assert.equal(unselected.narration, "first person", "a legacy preset with no selection falls back to the first option");

const clearedOff = buildPresetVariables({
  variableValues: "{}",
  choiceBlocks,
  chatChoices: { narration: "" },
});
assert.equal(clearedOff.narration, "", "an explicit empty selection is the user's OFF value");

const malformed = buildPresetVariables({
  variableValues: "not json",
  choiceBlocks: [null, { variableName: "" }, ...choiceBlocks],
  chatChoices: { language: "English" },
});
assert.equal(malformed.language, "English", "unparseable stored values and junk rows do not abort resolution");

const noPreset = await loadPresetVariables({
  presets: {
    listChoiceBlocksForPreset: async () => {
      throw new Error("must not read choice blocks without a preset");
    },
  },
  presetId: null,
  variableValues: JSON.stringify({ tone: "wry" }),
  chatChoices: {},
});
assert.deepEqual(noPreset, { tone: "wry" }, "a chat with no preset still exposes stored variable values");

const loaded = await loadPresetVariables({
  presets: { listChoiceBlocksForPreset: async () => choiceBlocks },
  presetId: "preset-1",
  variableValues: "{}",
  chatChoices: { narration: "second person" },
});
assert.equal(loaded.narration, "second person", "the loader resolves choice blocks for the given preset");

const context: AgentContext = {
  chatId: "chat-1",
  chatMode: "roleplay",
  recentMessages: [{ role: "user", content: "hello" }],
  mainResponse: null,
  gameState: null,
  characters: [{ id: "char-1", name: "Ada", description: "" }],
  persona: null,
  memory: {},
  writableLorebookIds: null,
  chatSummary: null,
  presetVariables: variables,
};

const rendered = renderAgentPromptTemplate(
  "All choices shall be written in {{language}} language, using {{narration}} narration. {{unknownVar}}",
  {},
  context,
);
assert.equal(
  rendered,
  "All choices shall be written in Polish language, using second person narration. {{unknownVar}}",
  "an agent prompt resolves preset variables and leaves an unknown macro literal",
);

const withoutVariables = renderAgentPromptTemplate("{{narration}}", {}, { ...context, presetVariables: undefined });
assert.equal(withoutVariables, "{{narration}}", "an agent context without preset variables leaves the macro literal");

const settingsWin = renderAgentPromptTemplate("{{narration}}", { narration: "from settings" }, context);
assert.equal(settingsWin, "from settings", "an agent setting of the same name still shadows a preset variable");

const escaped = renderAgentPromptTemplate(
  "{{narration}}",
  {},
  { ...context, presetVariables: { narration: "<second> & person" } },
  { escapeValues: true },
);
assert.equal(
  escaped,
  "&lt;second&gt; &amp; person",
  "preset variables are escaped alongside every other value in an XML agent document",
);

// Seeding the variable map is safe to do for every chat mode because the
// catch-all pass runs last: a choice block cannot claim the name of a built-in
// macro, so resolution can only change text that would otherwise stay literal.
const shadowContext = {
  user: "Mari",
  char: "Dottore",
  characters: ["Dottore"],
  characterFields: { description: "a real card field" },
};
for (const [template, expected] of [
  ["{{user}}", "Mari"],
  ["{{char}}", "Dottore"],
  ["{{description}}", "a real card field"],
] as const) {
  assert.equal(
    resolveMacros(template, {
      ...shadowContext,
      variables: { user: "hijacked", char: "hijacked", description: "hijacked" },
    }),
    expected,
    `a choice block named after a built-in macro cannot shadow ${template}`,
  );
}

const conditional = "{{#if narration}}[{{narration}}]{{else}}none{{/if}}";
assert.equal(
  resolveMacros(conditional, { ...shadowContext, variables: { narration: "second person" } }),
  "[second person]",
  "a selected choice drives its conditional",
);
assert.equal(
  resolveMacros(conditional, { ...shadowContext, variables: { narration: "" } }),
  "none",
  "a choice the user turned off reads as absent rather than as its own name",
);
assert.equal(
  resolveMacros(conditional, { ...shadowContext, variables: {} }),
  "[{{narration}}]",
  "an unresolved variable takes the true branch and emits its own braces, which is what a mode without preset variables used to send",
);

// A route builds its macro context from the chat itself, so the fields that
// used to be silently omissible are derived rather than passed. No character
// or persona ids, so storage is never reached and no writer lease is taken.
const noStorage = null as unknown as Parameters<typeof buildChatMacroContext>[0]["db"];
const chatMacroContext = await buildChatMacroContext({
  db: noStorage,
  chat: { id: "chat-1", mode: "conversation" },
  chatMeta: {
    macroVariables: { streak: "3" },
    conversationTimeZone: "Europe/Warsaw",
    promptTimeZone: "America/Chicago",
    groupScenarioText: "  a shared scene  ",
    gameStoryboardKeyframeCount: 5,
  },
  presetVariables: variables,
  characterIds: [],
  personaName: "Mari",
  lastGenerationType: "regression",
});

assert.equal(chatMacroContext.chatId, "chat-1", "the chat supplies its own id");
assert.equal(chatMacroContext.variables.narration, "second person", "preset variables reach the context");
assert.equal(chatMacroContext.localVariables?.streak, "3", "the chat's local variable store is derived, not omitted");
assert.equal(
  chatMacroContext.timeZone,
  "Europe/Warsaw",
  "a Conversation schedule zone wins over the remembered browser zone",
);
assert.equal(
  chatMacroContext.variables.gameStoryboardKeyframeCount,
  "5",
  "the engine-owned storyboard key is always present",
);
assert.equal(
  chatMacroContext.characterFields?.scenario,
  "a shared scene",
  "a group scenario override is trimmed and applied",
);

const requestZoneContext = await buildChatMacroContext({
  db: noStorage,
  chat: { id: "chat-1", mode: "roleplay" },
  chatMeta: { promptTimeZone: "America/Chicago" },
  presetVariables: {},
  requestTimeZone: "Asia/Tokyo",
  characterIds: [],
  personaName: "Mari",
  lastGenerationType: "regression",
});
assert.equal(requestZoneContext.timeZone, "Asia/Tokyo", "a request zone wins over the chat's remembered zone");
assert.equal(
  requestZoneContext.variables.gameStoryboardKeyframeCount !== undefined,
  true,
  "a chat with no preset still gets the engine-owned keys",
);

console.log("Agent preset variables regression passed.");
