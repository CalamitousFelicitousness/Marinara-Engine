// ──────────────────────────────────────────────
// The model writing a setting kit from the player's own setting (worldgen W0). It starts from the
// kit the player has chosen (a starter kit, or one they have already changed), and what it writes
// is read as a kit or refused with the reasons, which are sent back once so it can correct them.
// ──────────────────────────────────────────────
import { WORLD_STARTER_KITS, parseWorldKit, type WorldKit, type WorldKitInput } from "@marinara-engine/shared";

export interface WorldKitWritingInput {
  genre: string;
  setting: string;
  tone: string;
  /** The kit to start from; the first starter kit when absent. */
  start?: WorldKitInput;
  language?: string;
}

export function buildWorldKitWritingPrompt(input: WorldKitWritingInput): { system: string; user: string } {
  const language = input.language?.trim();
  const system = [
    `You write a setting kit for a role-playing game: the words and scales a world of this kind is written in. A world is generated later in these words, so every label must be what the setting itself calls the thing.`,
    `Return one JSON object only, with exactly the keys and shape of the kit you start from. No prose, no code fences.`,
    `Rules:`,
    `- Ids are lowercase letters, digits and underscores, starting with a letter, and never repeat within one list.`,
    `- "layers" are the levels of place, outermost first. Exactly one layer has "settlements": true: the one whose places are towns, stations or camps that have a size and a market.`,
    `- "sizes" is that layer's size ladder, smallest first. "groupKinds" include everyday groups (households, shops, crews) as well as powers.`,
    `- "change.kinds" has exactly the eight keys of the kit you start from. Each label says what that kind of change looks like in this setting. Set "on" to false for a kind this setting should never have (a cozy slice of life has no crime, conflict or catastrophe). "pace" is one of still, slow, steady, quick.`,
    `- "cultures" say how people are named, never the names themselves. Write real cultures with respect, never as caricature. An invented setting invents its own naming customs; never fall back on English or European names for a culture that is neither.`,
    `- No text may contain line breaks, square brackets or angle brackets. "summary" is at most 400 characters, each naming note at most 600.`,
    ...(language && language.toLowerCase() !== "english"
      ? [
          `- Write every label, summary and naming note in ${language}. Keep keys, ids and the pace and scale values in English.`,
        ]
      : []),
  ].join("\n");
  const user = [
    `Genre: ${input.genre}`,
    `Setting: ${input.setting}`,
    `Tone: ${input.tone}`,
    ``,
    `The kit to start from. Follow its shape and change its words to fit this setting:`,
    JSON.stringify(input.start ?? WORLD_STARTER_KITS[0]!, null, 2),
  ].join("\n");
  return { system, user };
}

/** The id every written kit has: it is the player's own, never one of the starter kits it began from. */
export const WRITTEN_WORLD_KIT_ID = "written";

/** Reads what the model wrote as a kit. The schema version and the id are the Engine's to set, never
 *  the model's: a written kit that kept a starter's id would read as that starter, unchanged. */
export function readWrittenWorldKit(data: unknown): { ok: true; kit: WorldKit } | { ok: false; issues: string[] } {
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { ok: false, issues: ["kit: Not a JSON object"] };
  return parseWorldKit({ ...(data as Record<string, unknown>), schemaVersion: 1, id: WRITTEN_WORLD_KIT_ID });
}

/** The second turn after a refusal: the reasons, so the model can correct them. */
export function worldKitRepairPrompt(issues: string[]): string {
  return [
    `That kit was refused for these reasons:`,
    ...issues.slice(0, 20).map((issue) => `- ${issue}`),
    `Return the whole corrected kit as one JSON object.`,
  ].join("\n");
}
