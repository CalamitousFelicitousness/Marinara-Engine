// ──────────────────────────────────────────────
// Preset Variables
// ──────────────────────────────────────────────
// Resolves the {{variableName}} namespace a preset exposes: its stored
// variable-group values plus the chat's choice-block selections. Kept out of
// the assembler because game mode, conversation mode, agent prompts, and the
// retry-agents route need the same values without assembling a preset.
// ──────────────────────────────────────────────

export interface ChoiceOptionValue {
  value: string;
}

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

function parseChoiceOptions(options: unknown): ChoiceOptionValue[] {
  if (typeof options !== "string") return [];
  try {
    const parsed = JSON.parse(options) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((option) =>
      option && typeof option === "object" && typeof (option as { value?: unknown }).value === "string"
        ? [{ value: (option as { value: string }).value }]
        : [],
    );
  } catch {
    return [];
  }
}

function sanitizeChoiceSelection(
  selected: string | string[] | undefined,
  options: ChoiceOptionValue[],
  isMulti: boolean,
): string | string[] | undefined {
  if (selected === undefined) return undefined;
  const validValues = new Set(options.map((option) => option.value));
  const candidates = Array.isArray(selected) ? selected : [selected];

  if (isMulti) {
    return candidates.filter((value, index) => validValues.has(value) && candidates.indexOf(value) === index);
  }

  return candidates.find((value) => validValues.has(value));
}

function readChoiceFlag(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

export function resolveChoiceVariableValue(input: {
  selected: string | string[] | undefined;
  options: ChoiceOptionValue[];
  multiSelect: unknown;
  randomPick: unknown;
  separator?: string | null;
  random?: () => number;
}): string {
  const isRandom = readChoiceFlag(input.randomPick);
  // Imported or legacy presets can carry Boolean/number flags, and a Random
  // Pick selection is necessarily multi-valued even if its companion flag was
  // normalized incorrectly during an older migration.
  const isMulti = readChoiceFlag(input.multiSelect) || (isRandom && Array.isArray(input.selected));

  // An explicit empty selection is the user's OFF value. Only a missing value
  // should fall back to the first option for legacy presets.
  if (input.selected === "" || (Array.isArray(input.selected) && input.selected.length === 0)) return "";

  const selected = sanitizeChoiceSelection(input.selected, input.options, isMulti);

  if (isMulti && Array.isArray(selected)) {
    if (selected.length === 0) return "";
    if (isRandom) {
      const random = input.random ?? Math.random;
      const roll = random();
      const unit = Number.isFinite(roll) ? Math.min(1, Math.max(0, roll)) : 0;
      const index = Math.min(selected.length - 1, Math.floor(unit * selected.length));
      return selected[index] ?? "";
    }
    return selected.join(input.separator || ", ");
  }

  if (selected !== undefined) {
    return Array.isArray(selected) ? (selected[0] ?? "") : selected;
  }
  return input.options[0]?.value ?? "";
}

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
