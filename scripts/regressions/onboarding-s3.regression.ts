// Interactive onboarding — slice 3: card variables (#7434).
//
// A second list of questions whose answers become CHAT variables instead of
// persona text, so a card field can carry a permanent `{{relationshipToUser}}`
// that each chat fills in during setup. This pins the resolver, the relevance
// rule, the guard that suppresses an enabled-but-empty block, the id/cap
// handling for the second list, and the validator's card path.
import assert from "node:assert/strict";
import {
  characterExtensionsSchema,
  dropUnreadableOnboarding,
  findUnresolvedCardVariableUses,
  getNextCardVariable,
  getRelevantCardVariables,
  hasOnboardingContent,
  ONBOARDING_MAX_QUESTIONS,
  resolveCardVariables,
  validateOnboarding,
  withUniqueOnboardingIds,
  type CharacterOnboarding,
  type OnboardingAnswers,
} from "../../packages/shared/src/index.js";

function onboarding(input: Record<string, unknown> = {}): CharacterOnboarding {
  const parsed = characterExtensionsSchema.parse({ onboarding: { enabled: true, ...input } }).onboarding;
  assert.ok(parsed);
  return parsed as CharacterOnboarding;
}
const option = (id: string, value: string, label = value) => ({ id, label, value });

// ── The fixture ──
// `relationshipToUser` and `tone` are read by the card's description.
// `formality` is reached ONLY from `tone`'s chosen option value, so it becomes
// relevant only after `tone` is answered — the engine reads option values lazily.
// `mood` is referenced nowhere and must never be asked.
const CARD_FIELDS = {
  description: "She greets {{relationshipToUser}} {{tone}}.",
  scenario: "A guildhall at dusk.",
};
const card = onboarding({
  cardVariables: [
    {
      id: "rel",
      variableName: "relationshipToUser",
      question: "Who are you to her?",
      options: [option("friend", "a childhood friend"), option("rival", "a rival")],
    },
    {
      id: "tone",
      variableName: "tone",
      question: "How does she address you?",
      options: [option("warm", "warmly, as {{formality}}")],
    },
    { id: "formality", variableName: "formality", question: "What does she call you?" },
    { id: "mood", variableName: "mood", question: "Your mood?" },
  ],
});
const names = (variables: Array<{ variableName: string }>) => variables.map((variable) => variable.variableName);
const answers = (input: Record<string, { optionIds?: string[]; text?: string }>) => input as OnboardingAnswers;

// ── The resolver: answers become chat variables ──
assert.deepEqual(
  resolveCardVariables(
    card,
    answers({
      relationshipToUser: { optionIds: ["friend"] },
      tone: { optionIds: ["warm"] },
      formality: { text: "my lady" },
    }),
  ),
  { relationshipToUser: "a childhood friend", tone: "warmly, as my lady", formality: "my lady" },
  "a picked option and free text both resolve",
);

// Option values are pre-resolved: the engine's `{{name}}` catch-all is a single
// pass (macro-engine.ts), so a value inserted with a macro still inside it would
// reach the prompt as a literal tag.
assert.equal(
  resolveCardVariables(
    card,
    answers({
      relationshipToUser: { optionIds: ["friend"] },
      tone: { optionIds: ["warm"] },
      formality: { text: "my lady" },
    }),
  ).tone,
  "warmly, as my lady",
  "a macro inside a chosen option value is resolved before the value is stored",
);

// A blank option value means "same as the label".
assert.deepEqual(
  resolveCardVariables(
    onboarding({
      cardVariables: [{ id: "r", variableName: "faction", question: "?", options: [option("c", "", "Crown")] }],
    }),
    answers({ faction: { optionIds: ["c"] } }),
  ),
  { faction: "Crown" },
  "a blank option value falls back to its label",
);

// Only answered questions are written, so a half-finished wizard stores nothing.
assert.deepEqual(
  resolveCardVariables(card, answers({ relationshipToUser: { optionIds: ["friend"] } })),
  { relationshipToUser: "a childhood friend" },
  "unanswered questions are omitted entirely",
);

// A value that still holds a bare tag is dropped, never stored: storing it would
// put a literal `{{...}}` into every prompt from then on.
assert.deepEqual(
  resolveCardVariables(
    onboarding({
      cardVariables: [{ id: "x", variableName: "leftover", question: "?", options: [option("o", "{{nope}}")] }],
    }),
    answers({ leftover: { optionIds: ["o"] } }),
  ),
  {},
  "an answer that does not resolve is dropped, never stored as a raw tag",
);

// The server rejects a whole `macroVariables` patch over one bad name, which
// would lose every answer in it, so unusable names are skipped here instead.
assert.deepEqual(
  resolveCardVariables(
    onboarding({
      cardVariables: [
        { id: "bad", variableName: "if", question: "?" },
        { id: "dashes", variableName: "a-b", question: "?" },
        { id: "good", variableName: "kept", question: "?" },
      ],
    }),
    answers({ if: { text: "x" }, "a-b": { text: "y" }, kept: { text: "z" } }),
  ),
  { kept: "z" },
  "a reserved name and a name a bare {{tag}} cannot address are skipped, not stored",
);

// Own properties only: a question named after a prototype member must be inert.
assert.deepEqual(
  resolveCardVariables(
    onboarding({ cardVariables: [{ id: "p", variableName: "constructor", question: "?" }] }),
    Object.assign(Object.create(null) as OnboardingAnswers, { constructor: { text: "boom" } }),
  ),
  {},
  "a prototype-member name is refused rather than resolving to Object.prototype",
);

// ── Relevance: which card questions get asked ──
assert.deepEqual(
  names(getRelevantCardVariables(card, CARD_FIELDS, answers({}))),
  ["relationshipToUser", "tone"],
  "only the card variables the card's own fields read are asked",
);
assert.deepEqual(
  names(getRelevantCardVariables(card, CARD_FIELDS, answers({ relationshipToUser: { optionIds: ["friend"] } }))),
  ["relationshipToUser", "tone"],
  "an unanswered question's option values are not read yet, so `formality` waits",
);
assert.deepEqual(
  names(
    getRelevantCardVariables(
      card,
      CARD_FIELDS,
      answers({ relationshipToUser: { optionIds: ["friend"] }, tone: { optionIds: ["warm"] } }),
    ),
  ),
  ["relationshipToUser", "tone", "formality"],
  "a question reached from a CHOSEN option value becomes relevant once that answer exists",
);
assert.equal(
  names(getRelevantCardVariables(card, CARD_FIELDS, answers({}))).includes("mood"),
  false,
  "a card variable no field references is never asked",
);
assert.equal(
  names(getRelevantCardVariables(card, CARD_FIELDS, answers({}))).includes("formality"),
  false,
  "a question whose only reference is an option value is not asked before that answer",
);
// A name reachable only from a condition still counts.
assert.deepEqual(
  names(
    getRelevantCardVariables(
      onboarding({ cardVariables: [{ id: "k", variableName: "knowsHer", question: "Do you know her?" }] }),
      { description: "{{#if knowsHer}}You grew up together.{{/if}}" },
      answers({}),
    ),
  ),
  ["knowsHer"],
  "a variable used only inside a condition is still asked",
);
assert.equal(
  getNextCardVariable(card, CARD_FIELDS, answers({}))?.variableName,
  "relationshipToUser",
  "the first unanswered relevant question is next",
);
assert.equal(
  getNextCardVariable(
    card,
    CARD_FIELDS,
    answers({ relationshipToUser: { optionIds: ["friend"] }, tone: { optionIds: ["warm"] }, formality: { text: "x" } }),
  ),
  null,
  "no question is pending once every relevant one is answered",
);
assert.deepEqual(
  names(getRelevantCardVariables(onboarding({}), CARD_FIELDS, answers({}))),
  [],
  "a card with no card questions asks nothing",
);

// ── The guard for an enabled-but-empty block ──
assert.equal(hasOnboardingContent(onboarding()), false, "enabled but completely empty is nothing to offer");
assert.equal(
  hasOnboardingContent(onboarding({ description: "A wandering scholar." })),
  true,
  "field text with no questions is a valid ready-made persona, not empty",
);
assert.equal(
  hasOnboardingContent(onboarding({ cardVariables: [{ id: "a", variableName: "mood", question: "?" }] })),
  true,
  "a card question alone counts as content",
);
assert.equal(
  hasOnboardingContent(onboarding({ cardVariables: [{ id: "a", variableName: "", question: "?" }] })),
  false,
  "a question without a name is not content",
);

// ── Ids and the cap cover the card list too ──
const dupes = withUniqueOnboardingIds(
  onboarding({
    variables: [{ id: "same", variableName: "a", question: "?" }],
    cardVariables: [
      { id: "same", variableName: "b", question: "?" },
      { id: "same", variableName: "c", question: "?" },
    ],
  }),
);
assert.deepEqual(
  dupes.cardVariables.map((variable) => variable.id),
  ["same", "same_2"],
  "repeated ids get unique ones inside the card list",
);
assert.equal(dupes.variables[0]!.id, "same", "an id may repeat ACROSS the lists: they are never shown together");
assert.equal(dupes.cardVariables[0]!.variableName, "b", "the first use of an id keeps it");

const overCap = dropUnreadableOnboarding({
  onboarding: {
    enabled: true,
    cardVariables: Array.from({ length: ONBOARDING_MAX_QUESTIONS + 5 }, (_, index) => ({
      id: `q${index}`,
      variableName: `v${index}`,
    })),
  },
});
assert.equal(overCap.truncated, true, "an over-cap card list reports truncation");
assert.equal(
  (overCap.extensions.onboarding as CharacterOnboarding).cardVariables.length,
  ONBOARDING_MAX_QUESTIONS,
  "imports keep only the first questions of the card list too",
);
const intact = dropUnreadableOnboarding({
  onboarding: { enabled: true, description: "{{a}}", cardVariables: [{ id: "a", variableName: "a" }] },
});
assert.equal(intact.truncated, false, "a card list within the cap is not reported as truncated");

// ── The validator's card path ──
const issuesFor = (input: Record<string, unknown>, fields?: Record<string, string>) =>
  validateOnboarding(onboarding(input), fields);
assert.deepEqual(
  issuesFor({ cardVariables: [{ id: "a", variableName: "used", question: "?" }] }, { description: "{{used}}" }),
  [],
  "a card question its field uses is clean",
);
assert.deepEqual(
  issuesFor(
    { cardVariables: [{ id: "a", variableName: "never", question: "?" }] },
    { description: "no tags here" },
  ).map((issue) => issue.code),
  ["unused"],
  "a card question no card field uses is flagged as unused",
);
assert.deepEqual(
  issuesFor({ cardVariables: [{ id: "a", variableName: "if", question: "?" }] }, { description: "{{if}}" }).map(
    (issue) => issue.code,
  ),
  ["reservedName"],
  "a built-in macro name is refused for a card question too",
);
assert.deepEqual(
  issuesFor({ cardVariables: [{ id: "a", variableName: "a-b", question: "?" }] }, { description: "no tags" }).map(
    (issue) => issue.code,
  ),
  ["invalidName"],
  "a name a bare {{tag}} cannot address is flagged for a card question",
);
assert.equal(
  issuesFor({
    variables: [{ id: "a", variableName: "dup", question: "?" }],
    cardVariables: [{ id: "b", variableName: "dup", question: "?" }],
  }).filter((issue) => issue.code === "duplicateName").length > 0,
  true,
  "a name used in both lists is a duplicate: it would be one chat variable with two answers",
);
assert.deepEqual(
  issuesFor({ cardVariables: [{ id: "a", variableName: "player", question: "?" }] }, { description: "{{player}}" }),
  [],
  "`player` is only special for the persona list; as a card variable it is an ordinary name",
);
// The reported issue carries no list tag: the editor knows which list it is
// rendering, so the shared shape stays exactly as it was before this feature.
assert.deepEqual(
  issuesFor({ cardVariables: [{ id: "a", variableName: "never", question: "?" }] }, { description: "" }),
  [{ code: "unused", variableId: "a", name: "never" }],
  "a card issue has the same shape as a persona issue",
);
// Without the card's text there is nothing to match against, so `unused` is not
// reported: the editor always passes it, an import-time check may not.
assert.equal(
  validateOnboarding(onboarding({ cardVariables: [{ id: "a", variableName: "used", question: "?" }] })).some(
    (issue) => issue.code === "unused",
  ),
  false,
  "without card fields, card questions are not called unused",
);
// An id may repeat across the two lists (only within a list must it be unique),
// and `withUniqueOnboardingIds` leaves such a pair alone.
const sharedId = withUniqueOnboardingIds(
  onboarding({
    variables: [{ id: "a", variableName: "personaOnly", question: "?" }],
    cardVariables: [{ id: "a", variableName: "cardOnly", question: "?" }],
  }),
);
assert.equal(
  sharedId.variables[0]!.id === "a" && sharedId.cardVariables![0]!.id === "a",
  true,
  "an id repeated across the two lists is not renamed: they are never rendered together",
);
// So an issue carries `variableId` and `name` but no list tag — an identical id
// in both lists yields two issues that only the name tells apart. The editor
// routes by that pair; a future `list` field would replace the pairing.
assert.deepEqual(
  validateOnboarding(sharedId, { description: "", personality: "", backstory: "", appearance: "", scenario: "" }).map(
    (issue) => [issue.code, issue.variableId, issue.name],
  ),
  [
    ["unused", "a", "personaOnly"],
    ["unused", "a", "cardOnly"],
  ],
  "a shared id yields one issue per list, distinguishable by name alone",
);

// ── Which names each side knows ──
// A persona field keeps its `{{name}}` through persona creation, and a card
// answer is a chat variable, so the prompt resolves a card name written into a
// persona field (measured 2026-10-11). No warning there — it does work.
assert.deepEqual(
  issuesFor(
    {
      description: "She greets {{cardOnly}}.",
      variables: [{ id: "p", variableName: "personaOnly" }],
      cardVariables: [{ id: "c", variableName: "cardOnly" }],
    },
    CARD_FIELDS,
  ).filter((issue) => issue.code === "unknownName"),
  [],
  "a card name in a persona field is known: the chat's own answer resolves it there",
);
// The card's own text is deliberately not scanned for unknown names: a card
// field is the author's prose and only ever reaches the model, whereas
// `unknownName` reports a tag typed into one of the PERSONA question fields,
// where a leftover would be written into the persona the player gets.
// An option value belongs to its own list either way. A persona option value
// keeps its `{{cardName}}` through persona creation exactly like field text does,
// so the chat resolves it later — known, no warning.
assert.deepEqual(
  issuesFor({
    variables: [{ id: "p", variableName: "personaOnly", options: [option("a", "{{cardOnly}}")] }],
    cardVariables: [{ id: "c", variableName: "cardOnly" }],
  })
    .filter((issue) => issue.code === "unknownOptionName")
    .map((issue) => issue.name),
  [],
  "a card name in a persona option value is known: it survives into the persona and the chat resolves it",
);
// A card option value is different: it is resolved while the persona is built,
// from the card's own answers alone, so it knows card names only.
assert.deepEqual(
  issuesFor({
    cardVariables: [
      { id: "c", variableName: "cardOnly", options: [option("a", "{{cardLater}}")] },
      { id: "d", variableName: "cardLater" },
    ],
    variables: [{ id: "p", variableName: "personaOnly" }],
  })
    .filter((issue) => issue.code === "unknownOptionName")
    .map((issue) => issue.name),
  [],
  "a card option value may name another card question",
);
assert.deepEqual(
  issuesFor({
    cardVariables: [{ id: "c", variableName: "cardOnly", options: [option("a", "{{personaOnly}}")] }],
    variables: [{ id: "p", variableName: "personaOnly" }],
  })
    .filter((issue) => issue.code === "unknownOptionName")
    .map((issue) => issue.name),
  ["personaOnly"],
  "a persona name in a card option value is unknown: the card's own answers cannot fill it",
);
// The split decides `unused` the same way: only the field a question feeds
// counts as reading it.
const crossRead = {
  variables: [{ id: "p", variableName: "personaOnly" }],
  cardVariables: [
    { id: "c", variableName: "cardOnly" },
    { id: "d", variableName: "cardUnread" },
  ],
};
assert.deepEqual(
  issuesFor(crossRead, { description: "She greets {{cardOnly}} and {{personaOnly}}." })
    .filter((issue) => issue.code === "unused")
    .map((issue) => issue.name)
    .sort(),
  ["cardUnread", "personaOnly"],
  "a card field does not read a persona question, and reading one card name leaves the other card question unused",
);
assert.deepEqual(
  issuesFor(
    { ...crossRead, description: "{{cardOnly}}", personality: "Reads {{personaOnly}}." },
    { description: "nothing here" },
  )
    .filter((issue) => issue.code === "unused")
    .map((issue) => issue.name)
    .sort(),
  ["cardOnly", "cardUnread"],
  "a persona field does not read a card question, so neither card question is used",
);

// ── The deferred greeting limitation is detectable ──
// A greeting is shown from the client's own macro context, which does not read
// chat variables, so a card variable there renders literally for now (see PR).
assert.deepEqual(
  [...findUnresolvedCardVariableUses(card, ["Hello, {{relationshipToUser}}.", "No tags here."])],
  ["relationshipToUser"],
  "a card variable used in a greeting is found, so the author can be warned",
);
assert.deepEqual(
  [...findUnresolvedCardVariableUses(card, ["{{somethingElse}}", "{{mood}}"])],
  ["mood"],
  "only names that are actually card variables are reported",
);
assert.deepEqual(
  [...findUnresolvedCardVariableUses(onboarding({}), ["{{anything}}"])],
  [],
  "no card questions, nothing to report",
);

console.info("onboarding s3 (card variables) regressions passed.");
