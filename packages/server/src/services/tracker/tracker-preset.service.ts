// ──────────────────────────────────────────────
// Tracker preset application
// ──────────────────────────────────────────────
// Layers the active tracker preset onto a Roleplay chat's tracker state.
//
// Runs as a second pass after the card-owned seeding in
// `chats.routes.ts#seedNewRoleplayChatTrackerDefaults`, and again on demand
// from `POST /api/tracker-presets/apply`. Kept out of `chats.routes.ts` so an
// upstream merge cannot silently revert it: that file is upstream-owned and
// actively edited, and the only fork lines in it are the two call sites.
//
// Why seeding at all: `trackerCustomFieldDefaults` is never declared to the
// tracker agent as configuration -- `buildLoreBlock` emits "Configured RPG
// pools" but has no custom-field equivalent. The agent learns a field exists
// only by seeing it in the current tracker state, so writing state is the
// whole mechanism.
import type { FastifyInstance } from "fastify";
import {
  characterTrackerCustomFieldDefaultsToRecord,
  mergeTrackerNamedEntries,
  normalizePersonaStats,
  normalizeCharacterTrackerCustomFieldDefaults,
  normalizeRpgStatPools,
  type CharacterData,
  type CharacterStat,
  type CustomTrackerField,
  type PlayerStats,
  type PresentCharacter,
  type RPGStatsConfig,
  type TrackerPreset,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createGameStateStorage } from "../storage/game-state.storage.js";
import { createTrackerPresetsStorage } from "../storage/tracker-presets.storage.js";
import { resolveActivePersonaCandidate } from "../../routes/generate/generate-route-utils.js";

export interface TrackerPresetApplyResult {
  applied: boolean;
  presetId: string | null;
  presetName: string | null;
  /** How many present characters gained at least one preset row. */
  characters: number;
  persona: boolean;
}

const EMPTY_RESULT: TrackerPresetApplyResult = {
  applied: false,
  presetId: null,
  presetName: null,
  characters: 0,
  persona: false,
};

function parseSnapshotList<T>(value: unknown, fallback: T[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Read a chat's tracker-preset override out of its stored metadata.
 *
 * Three-state on purpose: `undefined` inherits the global selection, `null` is
 * a deliberate opt-out. Chat rows carry `metadata` as a JSON string in storage
 * and as an object once normalized for a response, so both are accepted.
 */
export function readChatTrackerPresetId(metadata: unknown): string | null | undefined {
  let record: Record<string, unknown> | null = null;
  if (typeof metadata === "string" && metadata.trim()) {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) record = parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  } else if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    record = metadata as Record<string, unknown>;
  }
  if (!record || !("trackerPresetId" in record)) return undefined;
  const value = record.trackerPresetId;
  if (value === null) return null;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Chat rows store `characterIds` as a JSON string; responses carry an array. */
export function readChatCharacterIds(value: unknown): string[] {
  const list = parseSnapshotList<unknown>(value, []);
  return list.filter((id): id is string => typeof id === "string" && !!id.trim());
}

function parseSnapshotRecord<T>(value: unknown): T | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as T;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function presetStatsAsTrackerStats(preset: TrackerPreset, key: "characterStats" | "personaStats"): CharacterStat[] {
  const rows = Array.isArray(preset[key]) ? preset[key] : [];
  return rows
    .filter((row) => typeof row?.name === "string" && row.name.trim())
    .map((row) => ({
      name: row.name.trim(),
      value: Number.isFinite(row.value) ? Math.max(0, Math.min(Math.max(1, row.max), row.value)) : 0,
      max: Number.isFinite(row.max) ? Math.max(1, row.max) : 100,
      color: typeof row.color === "string" && /^#[0-9a-f]{6}$/i.test(row.color) ? row.color : "#a78bfa",
    }));
}

function presetFieldsAsRecord(preset: TrackerPreset, key: "characterFields" | "personaFields"): Record<string, string> {
  return characterTrackerCustomFieldDefaultsToRecord(preset[key]);
}

function presetFieldsAsTrackerFields(preset: TrackerPreset, key: "characterFields" | "personaFields") {
  return normalizeCharacterTrackerCustomFieldDefaults(preset[key]).map((field) => ({
    name: field.name,
    value: field.value,
  })) satisfies CustomTrackerField[];
}

interface CardTrackerDefaults {
  /** `extensions.trackerCustomFieldDefaults`, the card's own text rows. */
  fields: Record<string, string>;
  /** `extensions.rpgStats.pools`, empty unless the card enables RPG Stats. */
  stats: CharacterStat[];
  /** Ready-made tracker entry for a card this chat has not seen yet. */
  entry: PresentCharacter;
}

/**
 * Read one card's tracker defaults: the middle layer between the preset and
 * whatever the chat already tracks.
 *
 * The card's own `rpgStats.enabled` toggle gates its own stats, matching
 * upstream's seeding pass. Preset stats deliberately ignore that toggle; see
 * `applyTrackerPresetToChat`.
 */
async function readCardTrackerDefaults(app: FastifyInstance, characterId: string): Promise<CardTrackerDefaults | null> {
  const row = await createCharactersStorage(app.db).getById(characterId);
  if (!row) return null;
  let data: CharacterData;
  try {
    data = (typeof row.data === "string" ? JSON.parse(row.data) : row.data) as CharacterData;
  } catch {
    return null;
  }
  const extensions = (data.extensions ?? {}) as Record<string, unknown>;
  const rpgStats = extensions.rpgStats as RPGStatsConfig | undefined;
  return {
    fields: characterTrackerCustomFieldDefaultsToRecord(extensions.trackerCustomFieldDefaults),
    stats: rpgStats?.enabled
      ? normalizeRpgStatPools(rpgStats).map((pool) => ({
          name: pool.name,
          value: pool.value,
          max: pool.max,
          color: pool.color,
        }))
      : [],
    entry: {
      characterId,
      name: data.name || "Character",
      emoji: "👤",
      mood: "",
      appearance: typeof extensions.appearance === "string" ? extensions.appearance : null,
      outfit: null,
      avatarPath: row.avatarPath ?? null,
      avatarCrop: extensions.avatarCrop ?? null,
      customFields: {},
      stats: [],
      thoughts: null,
    },
  };
}

/**
 * Apply a tracker preset to one Roleplay chat.
 *
 * One chain, run identically for characters and the persona:
 *
 *     preset  ->  card  ->  live tracker state
 *
 * Later layers win a name collision, so card values beat preset values and a
 * value the chat already tracks beats both. Applying is therefore additive and
 * idempotent: it never resets a tracked value, and rows the chat lacks are
 * appended in preset order so every card lays out the same way.
 *
 * The card layer is read here rather than inherited from
 * `chats.routes.ts#seedNewRoleplayChatTrackerDefaults`, which runs only at chat
 * creation and character-add. Without it, Apply on an existing chat picked up
 * persona card edits but not character card edits.
 *
 * Preset stats apply regardless of a card's `rpgStats.enabled` toggle, the one
 * deliberate break in the symmetry. That toggle defaults to off and is
 * untouched on most libraries, so gating on it would make preset stats a no-op
 * exactly where the preset is most wanted. The card's own stats still respect
 * it. Opt out by leaving stats out of the preset, or setting the chat override
 * to none.
 */
export async function applyTrackerPresetToChat(
  app: FastifyInstance,
  options: {
    chatId: string;
    mode?: string | null;
    characterIds: readonly string[];
    personaId?: string | null;
    /** `null` = chat opted out, `undefined` = inherit the global selection. */
    chatPresetId?: string | null;
    /** Bypass resolution, e.g. when the caller applies a specific preset by id. */
    preset?: TrackerPreset | null;
    includeCharacters?: boolean;
    includePersona?: boolean;
  },
): Promise<TrackerPresetApplyResult> {
  if (options.mode !== undefined && options.mode !== "roleplay") return EMPTY_RESULT;

  const presetsStore = createTrackerPresetsStorage(app.db);
  const preset =
    options.preset !== undefined ? options.preset : (await presetsStore.resolveForChat(options.chatPresetId)).preset;
  if (!preset) return EMPTY_RESULT;

  const includeCharacters = options.includeCharacters !== false;
  const includePersona = options.includePersona !== false;

  const gameStateStore = createGameStateStorage(app.db);
  const latest = await gameStateStore.getLatest(options.chatId);

  const presentCharacters = latest
    ? parseSnapshotList<PresentCharacter>(latest.presentCharacters, [])
    : ([] as PresentCharacter[]);
  const personaStats = latest ? parseSnapshotList<CharacterStat>(latest.personaStats, []) : ([] as CharacterStat[]);
  const playerStats = latest ? parseSnapshotRecord<PlayerStats>(latest.playerStats) : null;

  // ── Characters ──
  const presetFieldRecord = presetFieldsAsRecord(preset, "characterFields");
  const presetCharacterStats = presetStatsAsTrackerStats(preset, "characterStats");
  const hasCharacterPayload = Object.keys(presetFieldRecord).length > 0 || presetCharacterStats.length > 0;

  let nextCharacters = presentCharacters;
  let touchedCharacters = 0;

  if (includeCharacters && hasCharacterPayload) {
    const byId = new Map<string, number>();
    nextCharacters = presentCharacters.map((character, index) => {
      if (typeof character?.characterId === "string" && character.characterId.trim()) {
        byId.set(character.characterId, index);
      }
      return { ...character };
    });

    // One read per card, reused for both the missing-entry case and the merge.
    const cardIds = new Set<string>(options.characterIds);
    for (const character of nextCharacters) {
      if (typeof character?.characterId === "string" && character.characterId.trim()) {
        cardIds.add(character.characterId);
      }
    }
    const cardDefaults = new Map<string, CardTrackerDefaults>();
    for (const characterId of cardIds) {
      const defaults = await readCardTrackerDefaults(app, characterId);
      if (defaults) cardDefaults.set(characterId, defaults);
    }

    for (const characterId of options.characterIds) {
      if (byId.has(characterId)) continue;
      const defaults = cardDefaults.get(characterId);
      if (!defaults) continue;
      byId.set(characterId, nextCharacters.length);
      nextCharacters.push(defaults.entry);
    }

    for (const character of nextCharacters) {
      const defaults = character.characterId ? cardDefaults.get(character.characterId) : undefined;
      const existingFields =
        character.customFields && typeof character.customFields === "object" && !Array.isArray(character.customFields)
          ? (character.customFields as Record<string, string>)
          : {};
      // preset -> card -> live state, the same chain the persona half runs.
      // Preset keys land first so every card lays out identically; later
      // spreads win on value, so a tracked value is never reset by re-applying.
      // An agent-invented NPC has no card and simply skips the middle layer.
      character.customFields = { ...presetFieldRecord, ...(defaults?.fields ?? {}), ...existingFields };
      character.stats = mergeTrackerNamedEntries(
        mergeTrackerNamedEntries(presetCharacterStats, defaults?.stats ?? []),
        Array.isArray(character.stats) ? character.stats : [],
      );
      touchedCharacters += 1;
    }
  }

  // ── Persona ──
  const presetPersonaStats = presetStatsAsTrackerStats(preset, "personaStats");
  const presetPersonaFields = presetFieldsAsTrackerFields(preset, "personaFields");
  const hasPersonaPayload = presetPersonaStats.length > 0 || presetPersonaFields.length > 0;

  let nextPersonaStats = personaStats;
  let nextPlayerStats = playerStats;
  let touchedPersona = false;

  if (includePersona && hasPersonaPayload) {
    // Card-level persona defaults ride inside the personaStats JSON blob, whose
    // normalizers preserve unknown keys, so no personas column was added.
    const charactersStore = createCharactersStorage(app.db);
    const personas = await charactersStore.listPersonas();
    const persona = resolveActivePersonaCandidate(personas, options.personaId ?? null, "roleplay");
    const personaConfig = persona ? normalizePersonaStats(persona.personaStats) : undefined;

    const cardBars = Array.isArray(personaConfig?.bars) ? (personaConfig.bars as CharacterStat[]) : [];
    const cardFields = normalizeCharacterTrackerCustomFieldDefaults(personaConfig?.fields);

    nextPersonaStats = mergeTrackerNamedEntries(mergeTrackerNamedEntries(presetPersonaStats, cardBars), personaStats);

    const existingCustomFields = Array.isArray(playerStats?.customTrackerFields)
      ? (playerStats.customTrackerFields as CustomTrackerField[])
      : [];
    const mergedCustomFields = mergeTrackerNamedEntries<CustomTrackerField>(
      mergeTrackerNamedEntries<CustomTrackerField>(
        presetPersonaFields,
        cardFields.map((field) => ({ name: field.name, value: field.value })),
      ),
      existingCustomFields,
    );

    nextPlayerStats = {
      stats: [],
      attributes: null,
      skills: {},
      inventory: [],
      activeQuests: [],
      status: "",
      ...(playerStats ?? {}),
      customTrackerFields: mergedCustomFields,
    } as PlayerStats;
    touchedPersona = true;
  }

  if (!touchedCharacters && !touchedPersona) return { ...EMPTY_RESULT, presetId: preset.id, presetName: preset.name };

  if (latest) {
    await gameStateStore.updateLatest(options.chatId, {
      ...(touchedCharacters ? { presentCharacters: nextCharacters } : {}),
      ...(touchedPersona ? { personaStats: nextPersonaStats, playerStats: nextPlayerStats } : {}),
    });
  } else {
    await gameStateStore.create({
      chatId: options.chatId,
      messageId: "",
      swipeIndex: 0,
      date: null,
      time: null,
      location: null,
      weather: null,
      temperature: null,
      worldCustomFields: [],
      presentCharacters: nextCharacters,
      recentEvents: [],
      playerStats: touchedPersona ? nextPlayerStats : null,
      personaStats: touchedPersona ? nextPersonaStats : null,
      fieldLocks: null,
      hiddenTrackerFields: null,
      committed: false,
    });
  }

  logger.debug(
    "Applied tracker preset %s to chat %s (%d characters, persona=%s)",
    preset.name,
    options.chatId,
    touchedCharacters,
    touchedPersona,
  );

  return {
    applied: true,
    presetId: preset.id,
    presetName: preset.name,
    characters: touchedCharacters,
    persona: touchedPersona,
  };
}
