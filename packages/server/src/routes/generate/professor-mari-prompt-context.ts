import { PROFESSOR_MARI_ID } from "@marinara-engine/shared";

import { MARI_ASSISTANT_PROMPT } from "../../db/seed-mari.js";

type ProfessorMariCharactersStore = {
  list(): Promise<Array<{ id?: string | null; data?: unknown }>>;
  listPersonas(): Promise<Array<{ name?: unknown }>>;
};

type NamedListStore = {
  list(): Promise<unknown[]>;
};

// Per-category cap on the <available_names> reference lists. Bounds the token
// noise on large libraries and — together with the deterministic sort below —
// keeps the block byte-stable across turns so it no longer churns the prompt
// prefix (and, with caching enabled, the cache). A code constant, mirroring
// MAX_MARI_FETCHED_PRESET_CONTEXT_CHARS; not a user setting. Fetching still
// works for any exact name even when it is beyond the cap (see <data_access>).
export const MAX_MARI_AVAILABLE_NAMES_PER_TYPE = 100;

// Lexicographic UTF-16 code-unit order (JS string relational comparison), not
// localeCompare: spec-defined and ICU-independent, so the emitted block is
// byte-identical across Node builds (small-icu vs full-icu). That determinism
// is the whole point — it keeps the block stable and the regression pin
// reliable — and it does not depend on true codepoint ordering.
function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asName(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Dedupe → sort (deterministic) → cap. Only the set of distinct names and the
// rename of one changes the output; merely touching an item (updatedAt bump)
// no longer reorders it, because we sort by name rather than trust store order.
function buildNameSection(type: string, rawNames: Array<string | null>): string | null {
  const unique = Array.from(new Set(rawNames.filter((name): name is string => name !== null)));
  if (unique.length === 0) return null;
  unique.sort(compareCodeUnit);

  const shown = unique.slice(0, MAX_MARI_AVAILABLE_NAMES_PER_TYPE);
  const overflow = unique.length - shown.length;
  const lines = [shown.join(", ")];
  if (overflow > 0) {
    lines.push(
      `…and ${overflow} more not listed — you can still fetch any of them by exact name if the user names one.`,
    );
  }
  return `<available_names type="${type}">\n${lines.join("\n")}\n</available_names>`;
}

/**
 * Builds Professor Mari's Home-assistant prompt context, split into two halves:
 *
 * - `stablePrompt`: the invariant instruction block (MARI_ASSISTANT_PROMPT).
 *   The caller appends this to the system message.
 * - `volatileContext`: the `<available_names>` reference lists plus any
 *   `<loaded_context>` fetched data. The caller injects this as a tail
 *   user-role message (contextKind "injection") so a change to the library or
 *   a `[fetch:]` no longer invalidates the static system prefix.
 */
export async function resolveProfessorMariPromptContext(args: {
  chatMeta: Record<string, unknown>;
  chars: ProfessorMariCharactersStore;
  lorebooksStore: NamedListStore;
  chats: NamedListStore;
  presets: NamedListStore;
}): Promise<{ stablePrompt: string; volatileContext: string }> {
  const volatileSections: string[] = [];

  try {
    const allChars = await args.chars.list();
    const allPersonasList = await args.chars.listPersonas();
    const allLorebooks = await args.lorebooksStore.list();
    const allChats = await args.chats.list();
    const allPresets = await args.presets.list();

    const charNames = allChars
      .filter((c) => c.id !== PROFESSOR_MARI_ID)
      .map((c) => {
        try {
          const d = typeof c.data === "string" ? JSON.parse(c.data) : c.data;
          return asName(d?.name);
        } catch {
          return null;
        }
      });

    const personaNames = allPersonasList.map((p) => asName(p.name));
    const lorebookNames = allLorebooks.map((row) => asName((row as { name?: unknown })?.name));
    const chatNames = allChats.map((row) => asName((row as { name?: unknown })?.name));
    const presetNames = allPresets.map((row) => asName((row as { name?: unknown })?.name));

    const namesSections = [
      buildNameSection("character", charNames),
      buildNameSection("persona", personaNames),
      buildNameSection("lorebook", lorebookNames),
      buildNameSection("chat", chatNames),
      buildNameSection("preset", presetNames),
    ].filter((section): section is string => section !== null);

    if (namesSections.length > 0) volatileSections.push(namesSections.join("\n\n"));
  } catch {
    // Non-critical: continue without name lists.
  }

  const mariContext = args.chatMeta.mariContext as Record<string, string> | undefined;
  if (mariContext && Object.keys(mariContext).length > 0) {
    const contextSections: string[] = [];
    for (const [key, value] of Object.entries(mariContext)) {
      contextSections.push(`<fetched_data key="${key}">\n${value}\n</fetched_data>`);
    }
    volatileSections.push(
      "<loaded_context>\nThe following items were previously fetched and are available for reference:\n\n" +
        contextSections.join("\n\n") +
        "\n</loaded_context>",
    );
  }

  return {
    stablePrompt: MARI_ASSISTANT_PROMPT,
    volatileContext: volatileSections.join("\n\n"),
  };
}
