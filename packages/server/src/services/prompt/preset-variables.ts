// ──────────────────────────────────────────────
// Preset Variables
// ──────────────────────────────────────────────
// Resolves the {{variableName}} namespace a preset exposes: its stored
// variable-group values plus the chat's choice-block selections. Kept out of
// the assembler because game mode, conversation mode, agent prompts, and the
// retry-agents route need the same values without assembling a preset.
// ──────────────────────────────────────────────

import { parseChoiceOptions, resolveChoiceVariableValue } from "@marinara-engine/shared";
export { resolveChoiceVariableValue, type ChoiceOptionValue } from "@marinara-engine/shared";

/** Choice-block columns this module reads. Rows store every flag as text. */
export interface PresetChoiceBlockRow {
  variableName: unknown;
  options: unknown;
  multiSelect: unknown;
  randomPick: unknown;
  separator?: unknown;
}

export interface PresetChoiceBlockReader {
  listChoiceBlocksForPreset: (presetId: string) => Promise<unknown[]>;
}

export type PresetVariableChoices = Record<string, string | string[]>;

function parseVariableValues(value: unknown): Record<string, string> {
  const source =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const resolved: Record<string, string> = {};
  for (const [name, entry] of Object.entries(source as Record<string, unknown>)) {
    if (typeof entry === "string") resolved[name] = entry;
  }
  return resolved;
}

function asChoiceBlockRow(row: unknown): PresetChoiceBlockRow | null {
  if (!row || typeof row !== "object") return null;
  const candidate = row as PresetChoiceBlockRow;
  return typeof candidate.variableName === "string" && candidate.variableName ? candidate : null;
}

export interface BuildPresetVariablesInput {
  /** Preset `variableValues`, as the stored JSON string or an already-parsed record. */
  variableValues: unknown;
  choiceBlocks: readonly unknown[];
  chatChoices: PresetVariableChoices;
  /** Injectable for tests; a Random Pick block otherwise rolls Math.random. */
  random?: () => number;
}

/** Resolve a preset's variable namespace. A choice block overrides a stored value of the same name. */
export function buildPresetVariables(input: BuildPresetVariablesInput): Record<string, string> {
  const variables = parseVariableValues(input.variableValues);
  for (const row of input.choiceBlocks) {
    const block = asChoiceBlockRow(row);
    if (!block) continue;
    variables[block.variableName as string] = resolveChoiceVariableValue({
      selected: input.chatChoices[block.variableName as string],
      options: parseChoiceOptions(block.options),
      multiSelect: block.multiSelect,
      randomPick: block.randomPick,
      separator: typeof block.separator === "string" ? block.separator : null,
      ...(input.random ? { random: input.random } : {}),
    });
  }
  return variables;
}

export interface LoadPresetVariablesInput {
  presets: PresetChoiceBlockReader;
  presetId: string | null | undefined;
  variableValues: unknown;
  chatChoices: PresetVariableChoices;
  random?: () => number;
}

/** Fetch a preset's choice blocks and resolve its variable namespace. */
export async function loadPresetVariables(input: LoadPresetVariablesInput): Promise<Record<string, string>> {
  if (!input.presetId) return parseVariableValues(input.variableValues);
  return buildPresetVariables({
    variableValues: input.variableValues,
    choiceBlocks: await input.presets.listChoiceBlocksForPreset(input.presetId),
    chatChoices: input.chatChoices,
    ...(input.random ? { random: input.random } : {}),
  });
}
