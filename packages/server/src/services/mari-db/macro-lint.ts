// Macro linting for Professor Mari's structured writes (#7995).
//
// Models writing card text or lorebook entries can drop a brace, and an unclosed `{{` silently
// reaches the prompt as literal text: the model then "explains" the broken preview instead of
// fixing it. The check is deliberately narrow: it only refuses text whose braces cannot be
// balanced at all, because `{{` always starts a macro in Marinara and a stray `}}` always
// closes nothing. Anything ambiguous (an unknown macro name, a literal brace pair) passes.

export type MacroProblem = { field: string; message: string };

/** `null` when the braces pair up, otherwise a sentence naming the first broken spot. */
export function macroBalanceProblem(text: string): string | null {
  const opens: number[] = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    const first = text[index];
    const second = text[index + 1];
    const pair = first && second ? first + second : "";
    if (pair === "{{") {
      opens.push(index);
      index += 1;
    } else if (pair === "}}") {
      if (opens.length === 0) {
        return `has a stray "}}" at character ${index} that closes nothing`;
      }
      opens.pop();
      index += 1;
    }
  }
  if (opens.length > 0) {
    return `opens "{{" at character ${opens[0]} and never closes it with "}}"`;
  }
  return null;
}

const CARD_MACRO_FIELDS = [
  "description",
  "personality",
  "scenario",
  "summary",
  "first_mes",
  "firstMes",
  "mes_example",
  "creator_notes",
  "creatorNotes",
  "backstory",
  "appearance",
  "aboutMe",
  "about_me",
  "about-me",
];

const ONBOARDING_MACRO_FIELDS = ["description", "personality", "backstory", "appearance", "scenario"];

function problemsIn(record: Record<string, unknown>, fields: string[]): MacroProblem[] {
  const problems: MacroProblem[] = [];
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== "string") continue;
    const message = macroBalanceProblem(value);
    if (message) problems.push({ field, message });
  }
  return problems;
}

function refuse(action: string, problems: MacroProblem[]): never {
  const detail = problems.map((problem) => `${problem.field} ${problem.message}`).join("; ");
  throw new Error(
    `${action} refused by the macro linter: ${detail}. A macro opens with "{{" and closes with "}}"; fix the brace and send the same value again (send it without the braces if you meant literal text).`,
  );
}

/** Card text on `character.create` / `character.update` (top level or inside data/patch/card). */
export function assertCardMacros(record: Record<string, unknown>, action: string): void {
  const records: Record<string, unknown>[] = [record];
  for (const key of ["data", "patch", "card", "character"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) records.push(nested as Record<string, unknown>);
  }
  const problems = records.flatMap((candidate) => problemsIn(candidate, CARD_MACRO_FIELDS));
  if (problems.length > 0) refuse(action, problems);
}

/**
 * The other half of #7995: fields that never interpolate macros. A `{{...}}` in a name, tag or key
 * would be stored and then shown literally forever, so name the field instead of saving the bug.
 */
function literalProblems(record: Record<string, unknown>, fields: string[]): MacroProblem[] {
  const problems: MacroProblem[] = [];
  for (const field of fields) {
    const value = record[field];
    const text = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string").join("\n")
      : typeof value === "string"
        ? value
        : null;
    if (!text || !text.includes("{{")) continue;
    problems.push({ field, message: 'contains "{{" but this field never resolves macros' });
  }
  return problems;
}

function refuseLiteral(action: string, problems: MacroProblem[]): never {
  const detail = problems.map((problem) => `${problem.field} ${problem.message}`).join("; ");
  throw new Error(
    `${action} refused by the macro linter: ${detail}. Names, tags and keys are matched and shown as written; move the macro into a text field (description, personality, scenario, first mes) or send this one without "{{".`,
  );
}

export function assertLiteralCardFields(record: Record<string, unknown>, action: string): void {
  const records: Record<string, unknown>[] = [record];
  for (const key of ["data", "patch", "card", "character"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) records.push(nested as Record<string, unknown>);
  }
  const problems = records.flatMap((candidate) => literalProblems(candidate, ["name", "tags"]));
  if (problems.length > 0) refuseLiteral(action, problems);
}

export function assertLiteralEntryFields(record: Record<string, unknown>, action: string): void {
  const records: Record<string, unknown>[] = [record];
  for (const key of ["data", "patch", "entry", "row"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) records.push(nested as Record<string, unknown>);
  }
  const problems = records.flatMap((candidate) => literalProblems(candidate, ["name", "keys", "secondaryKeys"]));
  if (problems.length > 0) refuseLiteral(action, problems);
}

/** Entry text on `lorebook.addEntry|createEntry|updateEntry` (top level or inside data/entry). */
export function assertEntryMacros(record: Record<string, unknown>, action: string): void {
  const records: Record<string, unknown>[] = [record];
  for (const key of ["data", "patch", "entry", "row"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) records.push(nested as Record<string, unknown>);
  }
  const problems = records.flatMap((candidate) => problemsIn(candidate, ["content"]));
  if (problems.length > 0) refuse(action, problems);
}

/** Onboarding text on `character.onboarding.update`. */
export function assertOnboardingMacros(record: Record<string, unknown>): void {
  const problems = problemsIn(record, ONBOARDING_MACRO_FIELDS);
  if (problems.length > 0) refuse("character.onboarding.update", problems);
}
