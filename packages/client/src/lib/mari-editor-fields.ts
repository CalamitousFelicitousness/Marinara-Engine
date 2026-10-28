// Links Prof. Mari to real editor fields. An editor field carries `data-mari-field="<id>"`, where the
// id is the key `fieldLabel` takes (`description`, `first_mes`, `extensions.backstory`) and the server's
// quick edit reads as `fieldId`. A change-card path is the same id under the row's `data.` column.

/** `data.extensions.backstory` -> `extensions.backstory`. */
export function editorFieldId(path: string): string {
  return path.replace(/^data\./, "");
}

/** The field for an id, or its closest anchored parent (`extensions.depth_prompt.role` -> the depth prompt). */
export function findMariField(root: ParentNode, path: string): HTMLElement | null {
  const parts = editorFieldId(path).split(".");
  for (let end = parts.length; end > 0; end--) {
    const id = parts.slice(0, end).join(".");
    const field = root.querySelector<HTMLElement>(`[data-mari-field="${CSS.escape(id)}"]`);
    if (field) return field;
  }
  return null;
}

// `character.update` patch keys the server accepts (normalizeCharacterActionData) that are not plain card keys.
const CHARACTER_PATCH_ALIASES: Record<string, string> = {
  first_message: "first_mes",
  greeting: "first_mes",
  backstory: "extensions.backstory",
  appearance: "extensions.appearance",
};
// The Character editor's `data-mari-field` ids.
const CHARACTER_FIELD_IDS = new Set([
  "name",
  "summary",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator_notes",
  "system_prompt",
  "post_history_instructions",
  "character_version",
  "alternate_greetings",
  "tags",
  "creator",
  "extensions.backstory",
  "extensions.appearance",
  "extensions.depth_prompt",
]);

/** A change-card path whose field the Character editor anchors (itself or its parent field). */
export function hasMariField(path: string): boolean {
  const parts = editorFieldId(path).split(".");
  return parts.some((_, end) => CHARACTER_FIELD_IDS.has(parts.slice(0, end + 1).join(".")));
}

/** The server's app_data action aliases (normalizeAppDataActionName): `Characters_Update` -> `character.update`. */
function appDataAction(action: unknown): string {
  if (typeof action !== "string") return "";
  return action
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, "")
    .replace(/^characters\./, "character.");
}

/** A `character.update` patch key (`firstMes`, `backstory`) as its editor field id, or null for other keys. */
export function characterPatchFieldId(key: string): string | null {
  const snake = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  const id = CHARACTER_PATCH_ALIASES[snake] ?? snake;
  return CHARACTER_FIELD_IDS.has(id) ? id : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The character field a running `app_data` step writes, from its tool input. */
export function mariWorkingFieldFromTool(name: string, input: unknown): { characterId: string; path: string } | null {
  const args = asRecord(input);
  if (!args || name !== "app_data" || appDataAction(args.action) !== "character.update") return null;
  const characterId = args.characterId ?? args.id;
  if (typeof characterId !== "string" || !characterId) return null;
  // The server reads fields top-level or inside one of these wrappers.
  const fields = {
    ...args,
    ...asRecord(args.character),
    ...asRecord(args.card),
    ...asRecord(args.data),
    ...asRecord(args.patch),
  };
  for (const key of Object.keys(fields)) {
    const path = characterPatchFieldId(key);
    if (path) return { characterId, path };
  }
  return null;
}
