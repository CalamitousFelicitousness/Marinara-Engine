// #4931: synthetic "Peek Prompt" render of a Professor Mari workspace edit. A workspace edit is not
// attached to a chat, so there is no persona / history / chosen-character context to assemble in.
// Instead we assemble the affected entity ON ITS OWN — the default preset for a character edit (or
// the edited preset itself), no persona, no chat history, previewOnly — and return the before/after
// assembled messages so the client can diff them. It is a labeled preview, not a real chat prompt.
//
// Mari has ALREADY applied the change by the time it is reviewed, so the live row is the AFTER state.
// We therefore render BOTH sides from the change's raw snapshots (beforeRaw / afterRaw) rather than
// trusting the live row, so the preview shows exactly what Mari proposed regardless of later drift.
import type { DB } from "../../db/connection.js";
import { characters } from "../../db/schema/index.js";
import { assemblePrompt, type AssemblerInput } from "../prompt/assembler.js";
import { createPromptsStorage } from "../storage/prompts.storage.js";
import { logger } from "../../lib/logger.js";

type RawRow = Record<string, unknown>;

export interface MariEditPromptSide {
  messages: Array<{ role: string; content: string }>;
}

export interface MariEditPromptRender {
  before: MariEditPromptSide | null;
  after: MariEditPromptSide | null;
}

export interface MariEditRenderTarget {
  table: string;
  id: string;
  action: "insert" | "update" | "replace" | "delete";
  beforeRaw: RawRow | null;
  afterRaw: RawRow | null;
}

const PRESET_TABLES = new Set(["prompt_presets", "prompt_sections", "prompt_groups", "choice_blocks"]);
// Marinara's Universal Preset, seeded with isDefault=true (db/default-preset.json). Fallback when no
// row is currently flagged default.
const BUILTIN_DEFAULT_PRESET_ID = "7huDl_SOx3a5EZtMeKqSR";

type LoadedPreset = {
  preset: RawRow;
  sections: RawRow[];
  groups: RawRow[];
  choiceBlocks: RawRow[];
};

// Read-only DB proxy that substitutes (or drops) the target character row so the assembler reads a
// snapshot instead of the live row. It only maps rows the underlying query RETURNS — it never injects
// the target into an unrelated query — which is safe because the synthetic render passes
// characterIds = [targetId], so the only character read is the target's own lookup. Exported for the
// open-issues regression, which validates the substitution/pass-through through the storage path.
export function characterOverrideDb(db: DB, targetId: string, substitute: RawRow | null): DB {
  const mapRows = (rows: RawRow[]): RawRow[] =>
    rows.flatMap((row) => {
      if (!row || (row as { id?: unknown }).id !== targetId) return [row];
      return substitute === null ? [] : [substitute];
    });
  const wrapQuery = (query: Record<string, any>): unknown => {
    const proxy: unknown = new Proxy(query, {
      get(target, prop) {
        if (prop === "run") return () => target.run().then(mapRows);
        if (prop === "then") return (onF: unknown, onR: unknown) => target.run().then(mapRows).then(onF, onR);
        if (prop === "where" || prop === "orderBy" || prop === "limit" || prop === "offset" || prop === "innerJoin") {
          return (...args: unknown[]) => {
            target[prop as string](...args);
            // Keep the wrapper across the fluent chain so the mapped then/run survive .where().etc().
            return proxy;
          };
        }
        const value = target[prop as string];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return proxy;
  };
  return new Proxy(db, {
    get(target, prop, recv) {
      if (prop === "select") {
        return (projection?: unknown) => {
          const builder = (target.select as (p?: unknown) => { from: (t: unknown) => unknown })(projection);
          return {
            from: (table: unknown) => (table === characters ? wrapQuery(builder.from(table) as Record<string, any>) : builder.from(table)),
          };
        };
      }
      const value = Reflect.get(target, prop, recv);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as DB;
}

async function loadPreset(db: DB, presetId: string): Promise<LoadedPreset | null> {
  const presets = createPromptsStorage(db);
  const preset = (await presets.getById(presetId)) as RawRow | null;
  if (!preset) return null;
  const [sections, groups, choiceBlocks] = await Promise.all([
    presets.listSections(presetId) as Promise<RawRow[]>,
    presets.listGroups(presetId) as Promise<RawRow[]>,
    presets.listChoiceBlocksForPreset(presetId) as Promise<RawRow[]>,
  ]);
  return { preset, sections, groups, choiceBlocks };
}

async function defaultPresetId(db: DB): Promise<string | null> {
  const presets = createPromptsStorage(db);
  const chosen = ((await presets.getDefault()) as RawRow | null) ?? ((await presets.getById(BUILTIN_DEFAULT_PRESET_ID)) as RawRow | null);
  return chosen ? String(chosen.id) : null;
}

// The smallest valid AssemblerInput: default preset structure, no persona, no history, previewOnly so
// lorebook timing/ephemeral state is never consumed. `chatChoices` is a Record (use {}, not []).
function baseInput(db: DB, loaded: LoadedPreset, characterIds: string[]): AssemblerInput {
  return {
    db,
    preset: loaded.preset as never,
    sections: loaded.sections as never,
    groups: loaded.groups as never,
    choiceBlocks: loaded.choiceBlocks as never,
    chatChoices: {},
    chatId: "mari-preview",
    characterIds,
    personaName: "",
    personaDescription: "",
    chatMessages: [],
    previewOnly: true,
  };
}

async function assembleSide(input: AssemblerInput): Promise<MariEditPromptSide | null> {
  try {
    const assembled = await assemblePrompt(input);
    return { messages: assembled.messages.map((message) => ({ role: message.role, content: message.content })) };
  } catch (err) {
    // A synthetic render must never 500 a review; a failed side just renders as unavailable.
    logger.warn(err, "[mari-edit-render] failed to assemble a synthetic prompt side");
    return null;
  }
}

// Splice one preset-family row into a loaded preset for a given side (before/after). Raw snapshots
// keep JSON columns as strings, which is exactly what the assembler expects, so no transformation.
function splicePreset(loaded: LoadedPreset, target: MariEditRenderTarget, raw: RawRow | null): LoadedPreset {
  const spliceArray = (rows: RawRow[]): RawRow[] => {
    if (raw === null) return rows.filter((row) => row.id !== target.id); // absent on this side
    const index = rows.findIndex((row) => row.id === target.id);
    if (index < 0) return [...rows, raw]; // added on this side
    const copy = [...rows];
    copy[index] = raw;
    return copy;
  };
  if (target.table === "prompt_presets") {
    return { ...loaded, preset: raw ?? loaded.preset };
  }
  if (target.table === "prompt_sections") return { ...loaded, sections: spliceArray(loaded.sections) };
  if (target.table === "prompt_groups") return { ...loaded, groups: spliceArray(loaded.groups) };
  if (target.table === "choice_blocks") return { ...loaded, choiceBlocks: spliceArray(loaded.choiceBlocks) };
  return loaded;
}

export async function renderMariEditPrompt(db: DB, target: MariEditRenderTarget): Promise<MariEditPromptRender | null> {
  if (target.table === "characters") {
    const presetId = await defaultPresetId(db);
    if (!presetId) return null;
    const loaded = await loadPreset(db, presetId);
    if (!loaded) return null;
    // A character delete has no live row to override on the before side, so the client does not offer
    // render there; here we simply render whichever side has a snapshot.
    const before = target.beforeRaw
      ? await assembleSide(baseInput(characterOverrideDb(db, target.id, target.beforeRaw), loaded, [target.id]))
      : null;
    const after = target.afterRaw
      ? await assembleSide(baseInput(characterOverrideDb(db, target.id, target.afterRaw), loaded, [target.id]))
      : null;
    return { before, after };
  }

  if (PRESET_TABLES.has(target.table)) {
    // A section/group/choice edit belongs to a specific preset; render that preset (not the default),
    // with the edited row spliced in. A prompt_presets edit renders the preset row itself.
    const presetId =
      target.table === "prompt_presets"
        ? target.id
        : String((target.afterRaw ?? target.beforeRaw)?.presetId ?? "");
    if (!presetId) return null;
    const loaded = await loadPreset(db, presetId);
    if (!loaded) return null;
    // Structural preview: no character fills the markers, so character blocks are empty and the diff
    // reflects the section/order/parameter change itself.
    const before = await assembleSide(baseInput(db, splicePreset(loaded, target, target.beforeRaw), []));
    const after = await assembleSide(baseInput(db, splicePreset(loaded, target, target.afterRaw), []));
    return { before, after };
  }

  return null;
}
