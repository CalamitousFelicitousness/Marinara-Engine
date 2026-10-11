// ──────────────────────────────────────────────
// Interactive onboarding ("skeleton persona")
//
// A card's `extensions.onboarding` holds the five persona Card fields as prose
// that may use `{{variable}}` and `{{#if}}`, plus the variables the player
// answers. Everything here leans on the macro engine — there is no onboarding
// parser: which questions are relevant is whatever the engine actually reads
// while resolving the fields with the answers given so far.
// ──────────────────────────────────────────────
import { characterOnboardingSchema } from "../schemas/character.schema.js";
import type { CharacterOnboarding, CharacterOnboardingVariable } from "../types/character.js";
import { CHAT_VARIABLE_NAME_RE, isReservedMacroName } from "./chat-variables.js";
import { resolveMacros } from "./macro-engine.js";

/**
 * Questions a card may carry. The editor stops adding at this count and imports
 * keep only the first ones: every question is an editor card, so thousands of
 * them freeze the Character Editor (#7308 review).
 */
export const ONBOARDING_MAX_QUESTIONS = 100;

/**
 * Imports drop an onboarding block that can't be read instead of refusing the
 * card (native import) or storing data a later card save would reject (V2/PNG),
 * and keep only the first {@link ONBOARDING_MAX_QUESTIONS} questions.
 */
export function dropUnreadableOnboarding<T extends Record<string, unknown>>(
  extensions: T,
): { extensions: T; dropped: boolean; truncated: boolean } {
  if (!("onboarding" in extensions)) return { extensions, dropped: false, truncated: false };
  const parsed = characterOnboardingSchema.safeParse(extensions.onboarding);
  if (!parsed.success) {
    const { onboarding: _dropped, ...rest } = extensions;
    return { extensions: rest as T, dropped: true, truncated: false };
  }
  const overCap = (variables: typeof parsed.data.variables) => variables.length > ONBOARDING_MAX_QUESTIONS;
  const truncated = overCap(parsed.data.variables) || overCap(parsed.data.cardVariables);
  const cap = (variables: typeof parsed.data.variables) => variables.slice(0, ONBOARDING_MAX_QUESTIONS);
  const capped = truncated
    ? { ...parsed.data, variables: cap(parsed.data.variables), cardVariables: cap(parsed.data.cardVariables) }
    : parsed.data;
  const onboarding = withUniqueOnboardingIds(capped);
  if (onboarding === parsed.data) return { extensions, dropped: false, truncated: false };
  return { extensions: { ...extensions, onboarding }, dropped: false, truncated };
}

/**
 * Card data with an onboarding block the schema can't read left out, for
 * read-only checks (chat identity, persona-as-character). Cards stored before
 * onboarding existed may carry a foreign `onboarding` key; that must not make
 * the whole character invalid there. The editor still shows it as unreadable.
 */
export function withoutUnreadableOnboarding(data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const record = data as Record<string, unknown>;
  const raw = record.extensions;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return data;
  const { extensions } = dropUnreadableOnboarding(raw as Record<string, unknown>);
  return extensions === raw ? data : { ...record, extensions };
}

/**
 * Gives every question, and every option within a question, its own non-empty
 * id. The editor edits, deletes and reorders by id, so a hand-edited card with
 * repeated ids would change both twins at once, or let a reorder multiply them
 * past the cap (#7308 review). Deterministic, so re-reading a card yields the
 * same ids; returns the same object when nothing needed fixing.
 */
export function withUniqueOnboardingIds<T extends CharacterOnboarding>(onboarding: T): T {
  /**
   * Keeps the first use of each id; a repeat or empty one gets `<id>_2`, `_3`…
   * unused anywhere in the list. Each base remembers where its search stopped
   * (`taken` only grows and `all` is fixed, so a skipped suffix never frees up):
   * restarting at `_2` for every repeat was quadratic, and an imported card with
   * thousands of repeated option ids blocked the server for minutes (#7308 review).
   */
  const uniquer = (ids: string[], fallback: string) => {
    const all = new Set(ids);
    const taken = new Set<string>();
    const nextSuffix = new Map<string, number>();
    return (id: string) => {
      let next = id;
      if (!next || taken.has(next)) {
        const base = id || fallback;
        let n = nextSuffix.get(base) ?? 2;
        do next = `${base}_${n++}`;
        while (taken.has(next) || all.has(next));
        nextSuffix.set(base, n);
      }
      taken.add(next);
      return next;
    };
  };
  const unique = (variables: CharacterOnboardingVariable[], prefix: string) => {
    const questionId = uniquer(
      variables.map((variable) => variable.id),
      `${prefix}question`,
    );
    return variables.map((variable) => {
      const optionId = uniquer(
        variable.options.map((option) => option.id),
        `${prefix}option`,
      );
      const options = variable.options.map((option) => {
        const id = optionId(option.id);
        return id === option.id ? option : { ...option, id };
      });
      const id = questionId(variable.id);
      const same = id === variable.id && options.every((option, index) => option === variable.options[index]);
      return same ? variable : { ...variable, id, options };
    });
  };
  const variables = onboarding.variables ?? [];
  const cardVariables = onboarding.cardVariables ?? [];
  // The two lists are separate: an id may repeat across them, because they are
  // never rendered or answered together. Within a list ids must be unique.
  const fixed = unique(variables, "");
  const fixedCard = unique(cardVariables, "card");
  const changed =
    fixed.some((variable, index) => variable !== variables[index]) ||
    fixedCard.some((variable, index) => variable !== cardVariables[index]);
  return changed ? { ...onboarding, variables: fixed, cardVariables: fixedCard } : onboarding;
}

/** A variable with this name supplies the created persona's name. */
export const ONBOARDING_PLAYER_VARIABLE = "player";

export const ONBOARDING_PERSONA_FIELDS = ["description", "personality", "backstory", "appearance", "scenario"] as const;
export type OnboardingPersonaField = (typeof ONBOARDING_PERSONA_FIELDS)[number];

/** Chosen option ids for a choice, or the player's own text (free text / "write your own"). */
export type OnboardingAnswer = { optionIds: string[] } | { text: string };
export type OnboardingAnswers = Record<string, OnboardingAnswer>;

export type ResolvedOnboardingPersona = { name: string } & Record<OnboardingPersonaField, string>;

/**
 * The card's variables, with a free-text `player` question first when the
 * author did not define one — a persona always needs a name. Its question is
 * empty so the UI shows its own localized "What is your name?".
 */
export function getOnboardingVariables(onboarding: CharacterOnboarding): CharacterOnboardingVariable[] {
  const variables = onboarding.variables ?? [];
  if (variables.some((variable) => variable.variableName === ONBOARDING_PLAYER_VARIABLE)) return variables;
  return [
    {
      id: `__${ONBOARDING_PLAYER_VARIABLE}`,
      variableName: ONBOARDING_PLAYER_VARIABLE,
      question: "",
      options: [],
      allowCustom: false,
      multiSelect: false,
      separator: ", ",
      displayMode: "auto",
      optionSort: "manual",
    },
    ...variables,
  ];
}

/**
 * The answer stored under `name`, own properties only: a question named
 * `toString` or `constructor` must not find `Object.prototype`'s (#7308 review).
 */
function ownAnswer(answers: OnboardingAnswers, name: string): OnboardingAnswer | undefined {
  return Object.prototype.hasOwnProperty.call(answers, name) ? answers[name] : undefined;
}

/** Own text must be non-blank; any choice counts, so "none of these" (an empty multi-select) is an answer. */
function isAnswered(answer: OnboardingAnswer | undefined): boolean {
  if (!answer) return false;
  return "text" in answer ? answer.text.trim() !== "" : true;
}

/**
 * Resolve the five fields once. `read` (optional) is told every variable the
 * engine reads, which only happens for text and conditions it actually reaches.
 */
function resolveFields(
  onboarding: CharacterOnboarding,
  answers: OnboardingAnswers,
  read?: (name: string) => void,
): ResolvedOnboardingPersona {
  // `{{user}}`/`{{char}}` resolve to themselves, so the saved persona keeps them
  // live like any hand-written persona instead of baking in today's names.
  const ctx = answerContext(onboarding, answers, { user: "{{user}}", char: "{{char}}" }, read);

  // The name goes through the same map, so a picked option, the player's own
  // text, or macros inside an option value all work alike.
  const out = { name: ctx.variables[ONBOARDING_PLAYER_VARIABLE] ?? "" } as ResolvedOnboardingPersona;
  for (const field of ONBOARDING_PERSONA_FIELDS) {
    out[field] = resolveMacros(onboarding[field] ?? "", ctx, { trimResult: false });
  }
  return out;
}

/** A macro context whose variables are the answers to `variables` so far. */
function answerContextFor(
  variables: CharacterOnboardingVariable[],
  answers: OnboardingAnswers,
  names: { user: string; char: string },
  read?: (name: string) => void,
) {
  const values: Record<string, string> = {};
  const ctx = { ...names, characters: [], variables: values, localVariables: {} };

  // Getters on own properties: the engine reads variables via hasOwnProperty +
  // a string check, so an unanswered variable (getter returns undefined) acts
  // exactly like a missing one: verbatim in text, and in a bare `{{#if name}}`
  // the engine reads the leftover name as a truthy literal. That only shows a
  // follow-up early; Create stays disabled until it is answered anyway.
  for (const variable of variables) {
    const name = variable.variableName;
    if (!name || Object.prototype.hasOwnProperty.call(values, name)) continue;
    let cached: string | undefined;
    let computed = false;
    Object.defineProperty(values, name, {
      enumerable: true,
      get() {
        read?.(name);
        if (computed) return cached;
        computed = true;
        const answer = ownAnswer(answers, name);
        if (!isAnswered(answer)) return (cached = undefined);
        if ("text" in answer!) return (cached = answer.text.trim());
        // Option values are author content and may hold macros of their own
        // (e.g. `custom` → `{{customClass}}`); the engine inserts variable values
        // without re-resolving them, so resolve the chosen values here.
        const chosen = variable.options.filter((option) => answer!.optionIds.includes(option.id));
        // A blank value means "same as the label", so authors don't type `Male` twice.
        const joined = chosen
          .map((option) => (option.value.trim() ? option.value : option.label))
          .join(variable.multiSelect ? variable.separator : "");
        return (cached = resolveMacros(joined, ctx, { trimResult: false }));
      },
    });
  }
  return ctx;
}

/** The persona answers, including the synthesized `player` question. */
function answerContext(
  onboarding: CharacterOnboarding,
  answers: OnboardingAnswers,
  names: { user: string; char: string },
  read?: (name: string) => void,
) {
  return answerContextFor(getOnboardingVariables(onboarding), answers, names, read);
}

/** Replace any onboarding variable still left as `{{name}}` with `fill`. */
function blankOnboardingNames(names: Set<string>, text: string, fill = ""): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, name: string) => (names.has(name) ? fill : match));
}

function onboardingNames(onboarding: CharacterOnboarding): Set<string> {
  return new Set(getOnboardingVariables(onboarding).map((variable) => variable.variableName));
}

/**
 * Every question as the player sees it, by variable id: answers so far fill its
 * `{{variables}}`, `{{char}}` is the card's name, `{{user}}` the player's name,
 * and anything not answered yet shows as "…". Questions without text are left
 * out. One shared context for all of them, so a card with thousands of
 * questions stays linear (#7308 review).
 */
export function resolveOnboardingQuestions(
  onboarding: CharacterOnboarding,
  answers: OnboardingAnswers,
  characterName: string,
): Map<string, string> {
  const ctx = answerContext(onboarding, answers, { user: "{{user}}", char: characterName });
  ctx.user = ctx.variables[ONBOARDING_PLAYER_VARIABLE] || "…";
  const names = onboardingNames(onboarding);
  const questions = new Map<string, string>();
  for (const { id, question } of getOnboardingVariables(onboarding)) {
    if (!question) continue;
    questions.set(id, blankOnboardingNames(names, resolveMacros(question, ctx, { trimResult: false }), "…").trim());
  }
  return questions;
}

/**
 * Variables the current answers make relevant, in card order: `player`, plus
 * every variable the engine reads while resolving the fields — in reachable text
 * or in a `{{#if}}` it evaluates. A question inside a branch that the answers
 * so far rule out is not listed.
 */
export function getRelevantOnboardingVariables(
  onboarding: CharacterOnboarding,
  answers: OnboardingAnswers,
): CharacterOnboardingVariable[] {
  const used = new Set<string>([ONBOARDING_PLAYER_VARIABLE]);
  resolveFields(onboarding, answers, (name) => used.add(name));
  return getOnboardingVariables(onboarding).filter((variable) => used.has(variable.variableName));
}

/**
 * The next relevant question without an answer, or null when onboarding is
 * complete. A persona needs a name, so `player` also counts as unanswered while
 * it resolves to nothing (e.g. a multi-select with nothing ticked).
 */
export function getNextOnboardingVariable(
  onboarding: CharacterOnboarding,
  answers: OnboardingAnswers,
): CharacterOnboardingVariable | null {
  const relevant = getRelevantOnboardingVariables(onboarding, answers);
  const next = relevant.find((variable) => !isAnswered(ownAnswer(answers, variable.variableName)));
  if (next) return next;
  if (resolveOnboardingPersona(onboarding, answers).name) return null;
  return relevant.find((variable) => variable.variableName === ONBOARDING_PLAYER_VARIABLE) ?? null;
}

/**
 * The persona the answers produce, as plain text. Any onboarding variable left
 * unanswered is blanked rather than shown as a raw `{{name}}`.
 */
export function resolveOnboardingPersona(
  onboarding: CharacterOnboarding,
  answers: OnboardingAnswers,
): ResolvedOnboardingPersona {
  const fields = resolveFields(onboarding, answers);
  const names = onboardingNames(onboarding);
  const blank = (text: string) => blankOnboardingNames(names, text);
  const result = { name: blank(fields.name).trim() } as ResolvedOnboardingPersona;
  for (const field of ONBOARDING_PERSONA_FIELDS) result[field] = blank(fields[field]).trim();
  return result;
}

// ──────────────────────────────────────────────
// Card variables (#7434)
//
// A second list of questions whose answers become CHAT variables instead of
// persona text. A card field can then carry a permanent `{{relationshipToUser}}`
// that each chat fills in during setup, so the card stays modular and is never
// modified. The prompt path needs nothing new: a card field already resolves a
// chat variable (measured 2026-10-11).
// ──────────────────────────────────────────────

/** True when the block has any question or field text to work from. */
function hasQuestion(variables: CharacterOnboardingVariable[] | undefined): boolean {
  return (variables ?? []).some((variable) => variable.variableName.trim() !== "");
}

/**
 * The card text a `{{name}}` can reach, for deciding which card questions are
 * worth asking. The prompt resolves these fields from the card (see the
 * character marker in the server), so text here is what the model would read.
 */
export interface OnboardingCardFields {
  description?: string;
  personality?: string;
  backstory?: string;
  appearance?: string;
  scenario?: string;
}

/**
 * The fields the prompt actually macro-resolves for a character. Kept in step
 * with the Character Info marker's default field list; a name used only outside
 * these (a greeting, say) is not offered as a question, because the prompt would
 * never resolve it.
 */
export const ONBOARDING_CARD_FIELDS = [
  "description",
  "personality",
  "backstory",
  "appearance",
  "scenario",
] as const satisfies readonly (keyof OnboardingCardFields)[];

function onboardingCardFieldTexts(card: OnboardingCardFields | null | undefined): string[] {
  if (!card) return [];
  return ONBOARDING_CARD_FIELDS.map((field) => card[field] ?? "");
}

/**
 * Card texts that reference a card variable but would NOT be resolved in the
 * prompt, so an author can be told. The greeting is the notable one: it is
 * displayed from the client's own macro context, which does not read chat
 * variables, so a `{{name}}` there shows literally (deferred, see the PR).
 * ponytail: a text scan, not the engine — these fields are never macro-resolved
 * on the cards path, so there is nothing to measure against.
 */
export function findUnresolvedCardVariableUses(
  onboarding: CharacterOnboarding,
  greetings: readonly string[] = [],
): Set<string> {
  const names = new Set((onboarding.cardVariables ?? []).map((variable) => variable.variableName));
  const found = new Set<string>();
  if (names.size === 0) return found;
  for (const text of greetings) {
    for (const match of text.matchAll(/\{\{([A-Za-z_]\w*)\}\}/g)) {
      if (names.has(match[1]!)) found.add(match[1]!);
    }
  }
  return found;
}

/**
 * Whether this card's onboarding offers the player anything, used to suppress
 * the wizard's marker and trigger for an enabled-but-empty block. A card with no
 * questions is still meaningful when its fields carry text: it ships a
 * ready-made persona, exactly like the answer path produces ("empty" must not
 * mean "no questions" alone).
 */
export function hasOnboardingContent(onboarding: CharacterOnboarding): boolean {
  if (ONBOARDING_PERSONA_FIELDS.some((field) => (onboarding[field] ?? "").trim() !== "")) return true;
  return hasQuestion(onboarding.variables) || hasQuestion(onboarding.cardVariables);
}

/** The card questions the answers make relevant, in card order. */
export function getRelevantCardVariables(
  onboarding: CharacterOnboarding,
  card: OnboardingCardFields,
  answers: OnboardingAnswers,
): CharacterOnboardingVariable[] {
  const variables = onboarding.cardVariables ?? [];
  if (variables.length === 0) return [];
  const used = new Set<string>();
  // Resolve the card's own fields with the answers so far, exactly like the
  // persona path: whatever the engine reads is what gets asked.
  const ctx = answerContextFor(variables, answers, { user: "{{user}}", char: "{{char}}" }, (name) => used.add(name));
  for (const text of onboardingCardFieldTexts(card)) resolveMacros(text, ctx, { trimResult: false });
  return variables.filter((variable) => used.has(variable.variableName));
}

/** The next card question without an answer, or null when they are all answered. */
export function getNextCardVariable(
  onboarding: CharacterOnboarding,
  card: OnboardingCardFields,
  answers: OnboardingAnswers,
): CharacterOnboardingVariable | null {
  return (
    getRelevantCardVariables(onboarding, card, answers).find(
      (variable) => !isAnswered(ownAnswer(answers, variable.variableName)),
    ) ?? null
  );
}

/**
 * How many card variables one chat may receive from onboarding. Far below the
 * server's own `MAX_CHAT_VARIABLES` (500), because these are written as one
 * patch and a chat also holds whatever the player and `{{setvar}}` put there.
 */
export const MAX_CARD_VARIABLES = 100;

/**
 * A name the chat route will accept for a NEW chat variable. The stored-name
 * pattern is broader on purpose (it also carries `{{setvar}}` names), but a
 * name created here has to be addressable as a bare `{{name}}`.
 */
function isStorableCardVariableName(name: string): boolean {
  return CHAT_VARIABLE_NAME_RE.test(name) && !isReservedMacroName(name);
}

/**
 * The chat variables the card questions resolve to: `name` → value, ready to be
 * written into the chat's `macroVariables`.
 *
 * Only answered questions are included, and a value that still holds a bare
 * `{{name}}` is dropped rather than stored, so a half-finished answer can never
 * write a raw tag into the prompt. Names the server would refuse are skipped for
 * the same reason: `PATCH /chats/:id/metadata` rejects the whole `macroVariables`
 * patch on one invalid name, which would lose every answer in it.
 */
export function resolveCardVariables(
  onboarding: CharacterOnboarding,
  answers: OnboardingAnswers,
): Record<string, string> {
  const variables = onboarding.cardVariables ?? [];
  if (variables.length === 0) return {};
  const ctx = answerContextFor(variables, answers, { user: "{{user}}", char: "{{char}}" });
  const names = new Set(variables.map((variable) => variable.variableName));
  const entries: Array<[string, string]> = [];
  const taken = new Set<string>();
  let stored = 0;
  for (const variable of variables) {
    const name = variable.variableName;
    if (!name || taken.has(name) || !isStorableCardVariableName(name)) continue;
    if (stored >= MAX_CARD_VARIABLES) break;
    if (!isAnswered(ownAnswer(answers, name))) continue;
    taken.add(name);
    const value = blankOnboardingNames(names, ctx.variables[name] ?? "").trim();
    // An unresolved leftover means the answer is not usable yet; writing it
    // would put a literal `{{tag}}` in the prompt.
    if (!value || /\{\{\w+\}\}/.test(value)) continue;
    entries.push([name, value]);
    stored += 1;
  }
  // Built by entries, not assignment: a "__proto__" name must stay an own key.
  return Object.fromEntries(entries);
}

export type OnboardingIssue =
  | {
      code: "emptyName" | "invalidName" | "reservedName" | "duplicateName" | "unused" | "unknownOptionName";
      variableId: string;
      name: string;
    }
  | { code: "plainIf"; field: OnboardingPersonaField }
  | { code: "unknownName"; field: OnboardingPersonaField; name: string };

/**
 * Names a text reads: bare `{{name}}` tags and the left operand of each
 * `{{#if}}` / `{{else if}}` clause. Words in prose don't count.
 * ponytail: right-hand operands are skipped — the engine resolves both sides,
 * so a name there is indistinguishable from a literal like `custom`.
 */
function readNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/\{\{([A-Za-z_]\w*)\}\}/g)) names.add(match[1]!);
  // Card text is untrusted (CodeQL js/polynomial-redos): one `\s` so no two parts
  // match the same whitespace, and no `{` or `}` inside, so a scan never runs
  // past the next `{{` — linear even with thousands of `{{#if` starts.
  for (const condition of text.matchAll(/\{\{\s*(?:#if|else\s+if)\s([^{}]*)\}\}/gi)) {
    for (const operand of condition[1]!.matchAll(/(?:^|&&|\|\||\(|!)\s*([A-Za-z_]\w*)(?![.:\w])/g)) {
      names.add(operand[1]!);
    }
  }
  return names;
}

/**
 * Problems an author should fix. `unused` is a warning; the rest stop a
 * question from working. Names follow chat variables: a letter or `_`, then
 * letters, digits or `_` (the field scan only reads names shaped like that).
 *
 * `card` is the card's own text, so card questions are checked against the
 * fields they actually feed. Without it, card questions are checked only for
 * naming rules (an unused question is not reported).
 */
export function validateOnboarding(onboarding: CharacterOnboarding, card?: OnboardingCardFields): OnboardingIssue[] {
  const issues: OnboardingIssue[] = [];
  // A question is used when a field or another question's option value reads it
  // (an option value like `{{customClass}}` asks that follow-up too).
  const used = readNames(
    [
      ...ONBOARDING_PERSONA_FIELDS.map((field) => onboarding[field] ?? ""),
      ...(onboarding.variables ?? []).flatMap((variable) => variable.options.map((option) => option.value)),
    ].join("\n"),
  );
  // `seen` is shared across both lists: the two are answered in one window, so
  // the same name twice would show `{{name}}` on two questions at once.
  const seen = new Set<string>();
  /** `usedNames` null = the caller gave no card text, so `unused` cannot be judged. */
  const checkNames = (variables: CharacterOnboardingVariable[], usedNames: Set<string> | null) => {
    for (const variable of variables) {
      const { id: variableId, variableName: name } = variable;
      if (!name) issues.push({ code: "emptyName", variableId, name });
      else if (!/^[A-Za-z_]\w*$/.test(name)) issues.push({ code: "invalidName", variableId, name });
      else if (seen.has(name)) issues.push({ code: "duplicateName", variableId, name });
      else if (name !== ONBOARDING_PLAYER_VARIABLE && isReservedMacroName(name))
        issues.push({ code: "reservedName", variableId, name });
      else if (name !== ONBOARDING_PLAYER_VARIABLE && usedNames && !usedNames.has(name))
        issues.push({ code: "unused", variableId, name });
      if (name) seen.add(name);
    }
  };
  checkNames(onboarding.variables ?? [], used);
  // `player` names the persona, so it is only meaningful for the persona list;
  // as a card variable it is an ordinary chat-variable name.
  checkNames(
    onboarding.cardVariables ?? [],
    card === undefined ? null : readNames(onboardingCardFieldTexts(card).join("\n")),
  );
  const known = new Set([ONBOARDING_PLAYER_VARIABLE, ...seen]);
  const isUnknown = (name: string) => !known.has(name) && !isReservedMacroName(name);
  // An option value like `{{hometown}}` with no such question would reach the persona raw.
  for (const { id: variableId, options } of [...(onboarding.variables ?? []), ...(onboarding.cardVariables ?? [])]) {
    for (const name of readNames(options.map((option) => option.value).join("\n"))) {
      if (isUnknown(name)) issues.push({ code: "unknownOptionName", variableId, name });
    }
  }
  for (const field of ONBOARDING_PERSONA_FIELDS) {
    const fieldText = onboarding[field] ?? "";
    // `{{if}}` / `{{If}}` without `#` is not a conditional: it reaches the persona
    // verbatim. (`{{else if}}` is correct as is — the engine's else-if has no `#`.)
    if (/\{\{\s*if\b/i.test(fieldText)) issues.push({ code: "plainIf", field });
    for (const name of readNames(fieldText)) {
      if (isUnknown(name)) issues.push({ code: "unknownName", field, name });
    }
  }
  return issues;
}
