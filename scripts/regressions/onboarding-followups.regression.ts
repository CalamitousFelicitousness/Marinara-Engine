// Interactive onboarding follow-ups (#7795): the shared card parse and the rule
// for chat variables a character leaves behind.
//
// `readCardOnboarding` is the one parse the server seeding/removal and both
// client surfaces use; `cardVariableNamesToDrop` is the ownership rule. Pinning
// the rule here, not by restating it at the call sites, is what makes the
// regression able to fail when the production behaviour changes.
import assert from "node:assert/strict";
import {
  cardVariableNamesToDrop,
  characterExtensionsSchema,
  getCardVariableNames,
  readCardOnboarding,
  type CharacterOnboarding,
} from "../../packages/shared/src/index.js";

function onboarding(input: Record<string, unknown> = {}): CharacterOnboarding {
  const parsed = characterExtensionsSchema.parse({ onboarding: { enabled: true, ...input } }).onboarding;
  assert.ok(parsed);
  return parsed as CharacterOnboarding;
}
const question = (id: string, variableName: string) => ({ id, variableName, question: `${variableName}?` });

// ── readCardOnboarding: one parse, every card shape ──
const cardData = {
  name: "Raven",
  description: "She greets {{bond}}.",
  personality: "Loyal",
  scenario: "A guildhall at dusk.",
  extensions: {
    backstory: "Raised far from the guild.",
    appearance: "Tall, with a scar.",
    onboarding: {
      enabled: true,
      cardVariables: [question("bond", "bond"), question("rank", "rank")],
    },
  },
};
const fromObject = readCardOnboarding(cardData);
assert.ok(fromObject);
assert.equal(fromObject.name, "Raven");
// Top-level fields come from the card root; backstory/appearance live on
// `extensions`. Reading all five from one place silently drops two references.
assert.equal(fromObject.cardFields.description, "She greets {{bond}}.");
assert.equal(fromObject.cardFields.personality, "Loyal");
assert.equal(fromObject.cardFields.scenario, "A guildhall at dusk.");
assert.equal(fromObject.cardFields.backstory, "Raised far from the guild.");
assert.equal(fromObject.cardFields.appearance, "Tall, with a scar.");
assert.deepEqual(
  fromObject.onboarding.cardVariables.map((variable) => variable.variableName),
  ["bond", "rank"],
);

// The same data as the row's JSON string, because the storage layer stores text.
assert.deepEqual(readCardOnboarding(JSON.stringify(cardData)), fromObject);

// An enabled block is returned; `enabled` is the CALLER's gate (seeding and the
// player-facing paths check it, the removal's "stays in chat" side must see it).
const disabled = readCardOnboarding({
  extensions: { onboarding: { enabled: false, cardVariables: [question("bond", "bond")] } },
});
assert.equal(disabled?.onboarding.enabled, false);

// Repeated ids are made unique, exactly as the editor and the questions window
// expect: cards saved before that rule (or written via the API) still repeat one.
const repeated = readCardOnboarding({
  extensions: {
    onboarding: {
      enabled: true,
      cardVariables: [question("same", "bond"), question("same", "rank")],
    },
  },
});
assert.deepEqual(
  repeated?.onboarding.cardVariables.map((variable) => variable.id),
  ["same", "same_2"],
);

// Unreadable input is `null`, never a throw: the draw stores foreign data.
assert.equal(readCardOnboarding("not json"), null);
assert.equal(readCardOnboarding(null), null);
assert.equal(readCardOnboarding({ name: "No extensions" }), null);
assert.equal(readCardOnboarding({ extensions: { onboarding: { variables: "not an array" } } }), null);

// ── getCardVariableNames: storable declarations only ──
const mixed = onboarding({
  cardVariables: [
    question("a", "bond"),
    question("b", "bond"),
    question("c", "bad-name"),
    question("d", "char"),
    question("e", ""),
    question("f", "rank"),
  ],
});
assert.deepEqual(getCardVariableNames(mixed), ["bond", "rank"]);
// Blank, malformed and reserved names can never reach `macroVariables`, so they
// can never need removing either.
assert.deepEqual(getCardVariableNames(onboarding()), []);
assert.deepEqual(getCardVariableNames(null), []);
// Declarations are reported for a disabled block too; the drop rule gates it.
const switchedOff = onboarding({ enabled: false, cardVariables: [question("bond", "bond")] });
assert.deepEqual(getCardVariableNames(switchedOff), ["bond"]);

// ── cardVariableNamesToDrop: owned by the leaving card, not declared by a stayer ──
const bondAndRank = onboarding({ cardVariables: [question("bond", "bond"), question("rank", "rank")] });
const rankOnly = onboarding({ cardVariables: [question("rank", "rank")] });

// A shared name stays: the remaining card still declares it and reads it.
assert.deepEqual(cardVariableNamesToDrop([bondAndRank], [rankOnly]), ["bond"]);
// Leaving the card declared by nobody removes every name it owned.
assert.deepEqual(cardVariableNamesToDrop([bondAndRank], []), ["bond", "rank"]);
// A card whose onboarding is switched off owns nothing: nothing was seeded for it.
assert.deepEqual(cardVariableNamesToDrop([switchedOff], []), []);
// The stayer's block being switched off does NOT release the name: its card's
// fields can still read the variable, so deleting it is the worse outcome.
assert.deepEqual(cardVariableNamesToDrop([bondAndRank], [switchedOff]), ["rank"]);
// Two leaving cards declaring the same name drop it once.
assert.deepEqual(cardVariableNamesToDrop([bondAndRank, rankOnly], []), ["bond", "rank"]);
// Non-storable names never enter the rule.
const weird = onboarding({ cardVariables: [question("a", "bad-name"), question("b", "char")] });
assert.deepEqual(cardVariableNamesToDrop([weird], []), []);
