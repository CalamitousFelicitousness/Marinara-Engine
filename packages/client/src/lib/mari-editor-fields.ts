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
  about_me: "extensions.aboutMe",
  "about-me": "extensions.aboutMe",
};
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
  "extensions.aboutMe",
]);

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
  if (name !== "app_data" || args?.action !== "character.update") return null;
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
