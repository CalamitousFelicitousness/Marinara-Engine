// ──────────────────────────────────────────────
// Tracker preset application
// ──────────────────────────────────────────────
// Layers the active tracker preset onto a Roleplay chat's tracker state.
//
// Runs as a second pass after the card-owned seeding in
// `chats.routes.ts#seedNewRoleplayChatTrackerDefaults`, and again on demand
// from `POST /api/tracker-presets/apply`. Kept out of `chats.routes.ts` so an
// upstream merge cannot silently revert it: that file is upstream-owned and
// actively edited, and the only fork lines in it are the call sites.
//
// Why seeding at all: `trackerCustomFieldDefaults` is never declared to the
// tracker agent as configuration -- `buildLoreBlock` emits "Configured RPG
// pools" but has no custom-field equivalent. The agent learns a field exists
// only by seeing it in the current tracker state, so writing state is the
// whole mechanism.
import type { FastifyInstance } from "fastify";
import {
  characterTrackerCustomFieldDefaultsToRecord,
  comparableTrackerName,
  mergeTrackerNamedEntries,
  normalizePersonaStats,
  normalizeCharacterTrackerCustomFieldDefaults,
  normalizeRpgStatPools,
  trackerAdoptedRowsSchema,
  TRACKER_PRESET_MAX_FIELDS,
  TRACKER_PRESET_MAX_STATS,
  type CharacterData,
  type CharacterStat,
  type CustomTrackerField,
  type CharacterTrackerCustomFieldDefault,
  type PersonaStatBar,
  type PlayerStats,
  type PresentCharacter,
  type RPGStatPool,
  type RPGStatsConfig,
  type TrackerAdoptedRows,
  type TrackerPreset,
} from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { createAppSettingsStorage } from "../storage/app-settings.storage.js";
import { createCharactersStorage } from "../storage/characters.storage.js";
import { createChatsStorage } from "../storage/chats.storage.js";
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

/** Append rows the base does not already name, preserving the base's order and values. */
function appendUnnamedRows<T extends { name: string }>(base: readonly T[], extra: readonly T[]): T[] {
  const known = new Set(base.map((row) => comparableTrackerName(row.name)).filter(Boolean));
  const added = extra.filter((row) => {
    const key = comparableTrackerName(row.name);
    return key && !known.has(key);
  });
  return added.length > 0 ? [...base, ...added] : [...base];
}

/** Fold adopted rows into a preset, synthesizing one when no preset is selected. */
function withAdoptedRows(
  preset: TrackerPreset | null,
  adopted: {
    characterFields: CharacterTrackerCustomFieldDefault[];
    characterStats: RPGStatPool[];
    personaFields: CharacterTrackerCustomFieldDefault[];
    personaStats: PersonaStatBar[];
  } | null,
): TrackerPreset | null {
  if (!adopted) return preset;
  const base: TrackerPreset = preset ?? {
    id: "",
    name: "Adopted tracker rows",
    characterFields: [],
    characterStats: [],
    personaFields: [],
    personaStats: [],
    order: 0,
    createdAt: "",
    updatedAt: "",
  };
  return {
    ...base,
    characterFields: appendUnnamedRows(base.characterFields ?? [], adopted.characterFields),
    characterStats: appendUnnamedRows(base.characterStats ?? [], adopted.characterStats),
    personaFields: appendUnnamedRows(base.personaFields ?? [], adopted.personaFields),
    personaStats: appendUnnamedRows(base.personaStats ?? [], adopted.personaStats),
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
  const resolved =
    options.preset !== undefined ? options.preset : (await presetsStore.resolveForChat(options.chatPresetId)).preset;

  // Auto-adopt is a layer, not a separate pipeline: learned rows are appended
  // behind whatever the preset already names, so an explicit preset still owns
  // the layout order and its starting values. With no preset at all the adopted
  // rows stand alone, which is the zero-ceremony path.
  const adopted = (await isTrackerAutoAdoptEnabled(app)) ? await readAdoptedTrackerRows(app) : null;
  const preset = withAdoptedRows(resolved, adopted);
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

// ──────────────────────────────────────────────
// Extraction: build a preset draft from a chat's live tracker
// ──────────────────────────────────────────────

export interface ExtractedTrackerPreset {
  characterFields: CharacterTrackerCustomFieldDefault[];
  characterStats: RPGStatPool[];
  personaFields: CharacterTrackerCustomFieldDefault[];
  personaStats: PersonaStatBar[];
  /** Present characters that contributed at least one row. */
  characters: number;
}

const EMPTY_EXTRACTION: ExtractedTrackerPreset = {
  characterFields: [],
  characterStats: [],
  personaFields: [],
  personaStats: [],
  characters: 0,
};

/** First spelling of a name wins; later case or spacing variants collapse into it. */
function collectNames(names: Iterable<unknown>): CharacterTrackerCustomFieldDefault[] {
  const seen = new Set<string>();
  const rows: CharacterTrackerCustomFieldDefault[] = [];
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    const name = raw.trim();
    const key = comparableTrackerName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    // Names only. The chat's current text is play state, not a default that
    // belongs on every future character.
    rows.push({ name, value: "" });
  }
  return rows;
}

/** Keeps each bar's max and color, but starts it full rather than mid-story. */
function collectStats(sources: Iterable<unknown>): RPGStatPool[] {
  const seen = new Set<string>();
  const rows: RPGStatPool[] = [];
  for (const raw of sources) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const stat = raw as Partial<CharacterStat>;
    const name = typeof stat.name === "string" ? stat.name.trim() : "";
    const key = comparableTrackerName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const max = Number.isFinite(stat.max) ? Math.max(1, Number(stat.max)) : 100;
    rows.push({
      name,
      value: max,
      max,
      color: typeof stat.color === "string" && /^#[0-9a-f]{6}$/i.test(stat.color) ? stat.color : "#a78bfa",
    });
  }
  return rows;
}

/**
 * Read a chat's latest tracker snapshot and derive the preset rows it uses.
 *
 * Deterministic on purpose: the tracker agent's accumulated output already
 * names every field, so extracting it beats asking a model to guess names that
 * must match the tracker prompt exactly. Values are dropped and stat bars reset
 * to full, because a preset seeds new chats and mid-story values are not
 * defaults.
 *
 * Pure read. Nothing is written, and the caller reviews before saving.
 */
export async function extractTrackerPresetFromChat(
  app: FastifyInstance,
  chatId: string,
): Promise<ExtractedTrackerPreset> {
  const latest = await createGameStateStorage(app.db).getLatest(chatId);
  if (!latest) return EMPTY_EXTRACTION;

  const presentCharacters = parseSnapshotList<PresentCharacter>(latest.presentCharacters, []);
  const playerStats = parseSnapshotRecord<PlayerStats>(latest.playerStats);

  const fieldNames: string[] = [];
  const statRows: unknown[] = [];
  let characters = 0;
  for (const character of presentCharacters) {
    const fields =
      character?.customFields && typeof character.customFields === "object" && !Array.isArray(character.customFields)
        ? Object.keys(character.customFields as Record<string, string>)
        : [];
    const stats = Array.isArray(character?.stats) ? character.stats : [];
    if (fields.length === 0 && stats.length === 0) continue;
    fieldNames.push(...fields);
    statRows.push(...stats);
    characters += 1;
  }

  const personaFieldRows = Array.isArray(playerStats?.customTrackerFields)
    ? (playerStats.customTrackerFields as CustomTrackerField[])
    : [];

  return {
    characterFields: collectNames(fieldNames),
    characterStats: collectStats(statRows),
    personaFields: collectNames(personaFieldRows.map((field) => field?.name)),
    personaStats: collectStats(parseSnapshotList<CharacterStat>(latest.personaStats, [])),
    characters,
  };
}

// ──────────────────────────────────────────────
// Auto-adopt: rows learned from manual tracker edits
// ──────────────────────────────────────────────

/** App-settings key. "true" enables adoption; anything else disables it. */
export const TRACKER_AUTO_ADOPT_SETTINGS_KEY = "trackerAutoAdoptFields";

/** App-settings key holding the learned rows as JSON. */
export const TRACKER_ADOPTED_ROWS_SETTINGS_KEY = "trackerAdoptedRows";

/** Longest row name the adopted-rows schema accepts. */
const ADOPTED_ROW_NAME_MAX = 120;

function emptyAdoptedRows(): TrackerAdoptedRows {
  return { characterFields: [], characterStats: [], personaFields: [], personaStats: [] };
}

export async function isTrackerAutoAdoptEnabled(app: FastifyInstance): Promise<boolean> {
  return (await createAppSettingsStorage(app.db).get(TRACKER_AUTO_ADOPT_SETTINGS_KEY)) === "true";
}

export async function setTrackerAutoAdoptEnabled(app: FastifyInstance, enabled: boolean): Promise<void> {
  await createAppSettingsStorage(app.db).set(TRACKER_AUTO_ADOPT_SETTINGS_KEY, enabled ? "true" : "false");
}

export async function readAdoptedTrackerRows(app: FastifyInstance): Promise<TrackerAdoptedRows> {
  const raw = await createAppSettingsStorage(app.db).get(TRACKER_ADOPTED_ROWS_SETTINGS_KEY);
  if (!raw) return emptyAdoptedRows();
  try {
    const parsed = trackerAdoptedRowsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    logger.warn("[tracker] Stored adopted tracker rows failed validation; reading them as empty");
  } catch (err) {
    logger.warn(err, "[tracker] Stored adopted tracker rows are not valid JSON; reading them as empty");
  }
  return emptyAdoptedRows();
}

export async function writeAdoptedTrackerRows(
  app: FastifyInstance,
  rows: TrackerAdoptedRows,
): Promise<TrackerAdoptedRows> {
  const parsed = trackerAdoptedRowsSchema.parse(rows);
  await createAppSettingsStorage(app.db).set(TRACKER_ADOPTED_ROWS_SETTINGS_KEY, JSON.stringify(parsed));
  return parsed;
}

/** The tracker columns a manual edit can carry. `undefined` means the edit leaves that column alone. */
export interface TrackerRowState {
  presentCharacters?: unknown;
  personaStats?: unknown;
  playerStats?: unknown;
}

type NamedRow = Record<string, unknown> & { name: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function namedRows(value: unknown): NamedRow[] {
  return (Array.isArray(value) ? value : []).filter(
    (row): row is NamedRow => isPlainRecord(row) && typeof row.name === "string" && !!comparableTrackerName(row.name),
  );
}

/** Character identity across one edit: card id when there is one, else the name. */
function characterMatchKey(character: Record<string, unknown>): string {
  const id = typeof character.characterId === "string" ? character.characterId.trim() : "";
  if (id) return `id:${id}`;
  const name = typeof character.name === "string" ? comparableTrackerName(character.name) : "";
  return name ? `name:${name}` : "";
}

/** Rows to learn and names to forget, accumulated across every character in one edit. */
class RowDelta<T> {
  readonly added: T[] = [];
  readonly removed = new Set<string>();

  compare(before: readonly T[], after: readonly T[], nameOf: (row: T) => string): void {
    const beforeKeys = new Set(before.map((row) => comparableTrackerName(nameOf(row))));
    const afterKeys = new Set(after.map((row) => comparableTrackerName(nameOf(row))));
    for (const row of after) {
      if (!beforeKeys.has(comparableTrackerName(nameOf(row)))) this.added.push(row);
    }
    for (const key of beforeKeys) {
      if (key && !afterKeys.has(key)) this.removed.add(key);
    }
  }

  /** Forget first, then append unseen rows, so a rename moves the row rather than dropping it. */
  fold<R extends { name: string }>(rows: readonly R[], normalized: readonly R[], cap: number): R[] {
    const next = rows.filter((row) => !this.removed.has(comparableTrackerName(row.name)));
    const known = new Set(next.map((row) => comparableTrackerName(row.name)));
    for (const row of normalized) {
      if (next.length >= cap) break;
      const key = comparableTrackerName(row.name);
      if (!key || known.has(key) || row.name.length > ADOPTED_ROW_NAME_MAX) continue;
      known.add(key);
      next.push(row);
    }
    return next;
  }
}

/**
 * Fold one manual tracker edit into the learned rows.
 *
 * A row name that appears on a character present both before and after the
 * edit is learned; one that disappears is forgotten. Characters the edit adds
 * or removes are skipped, so deleting a character or clearing the tracker never
 * empties the list. Persona bars and fields follow the same rule. Values are
 * not learned: fields start blank and bars start full, as in an extracted preset.
 *
 * Returns null when the edit changes no row names.
 */
export function foldManualTrackerEdit(
  rows: TrackerAdoptedRows,
  before: TrackerRowState,
  after: TrackerRowState,
): TrackerAdoptedRows | null {
  const characterFields = new RowDelta<string>();
  const characterStats = new RowDelta<NamedRow>();
  const personaFields = new RowDelta<NamedRow>();
  const personaStats = new RowDelta<NamedRow>();

  if (after.presentCharacters !== undefined) {
    const previous = new Map<string, Record<string, unknown>>();
    for (const character of parseSnapshotList<unknown>(before.presentCharacters, [])) {
      if (!isPlainRecord(character)) continue;
      const key = characterMatchKey(character);
      if (key) previous.set(key, character);
    }
    for (const character of parseSnapshotList<unknown>(after.presentCharacters, [])) {
      if (!isPlainRecord(character)) continue;
      const prior = previous.get(characterMatchKey(character));
      if (!prior) continue;
      characterFields.compare(
        isPlainRecord(prior.customFields) ? Object.keys(prior.customFields) : [],
        isPlainRecord(character.customFields) ? Object.keys(character.customFields) : [],
        (name) => name,
      );
      characterStats.compare(namedRows(prior.stats), namedRows(character.stats), (row) => row.name);
    }
  }

  if (Array.isArray(after.personaStats)) {
    personaStats.compare(
      namedRows(parseSnapshotList<unknown>(before.personaStats, [])),
      namedRows(after.personaStats),
      (row) => row.name,
    );
  }

  const afterPlayer = isPlainRecord(after.playerStats) ? after.playerStats : null;
  if (afterPlayer && Array.isArray(afterPlayer.customTrackerFields)) {
    const beforePlayer = parseSnapshotRecord<Record<string, unknown>>(before.playerStats);
    personaFields.compare(
      namedRows(beforePlayer?.customTrackerFields),
      namedRows(afterPlayer.customTrackerFields),
      (row) => row.name,
    );
  }

  const next: TrackerAdoptedRows = {
    characterFields: characterFields.fold(
      rows.characterFields,
      collectNames(characterFields.added),
      TRACKER_PRESET_MAX_FIELDS,
    ),
    characterStats: characterStats.fold(
      rows.characterStats,
      collectStats(characterStats.added),
      TRACKER_PRESET_MAX_STATS,
    ),
    personaFields: personaFields.fold(
      rows.personaFields,
      collectNames(personaFields.added.map((row) => row.name)),
      TRACKER_PRESET_MAX_FIELDS,
    ),
    personaStats: personaStats.fold(rows.personaStats, collectStats(personaStats.added), TRACKER_PRESET_MAX_STATS),
  };
  return JSON.stringify(next) === JSON.stringify(rows) ? null : next;
}

/**
 * Capture the snapshot a manual game-state PATCH is about to overwrite and
 * return the step that learns from the edit once the write succeeds.
 *
 * Called only from that route, which panel and HUD edits go through; agent,
 * seeding and preset writes go straight to storage, so their rows are never
 * learned. The baseline mirrors the route's own target: the message+swipe
 * snapshot, else the last assistant message's, else the latest, which is also
 * what `updateByMessage` clones when the target has no row yet.
 */
export async function prepareTrackerRowLearning(
  app: FastifyInstance,
  chatId: string,
  edit: {
    manual: boolean;
    clearOverrides: boolean;
    target: { messageId: string; swipeIndex: number } | null;
    fields: TrackerRowState;
  },
): Promise<(() => Promise<void>) | null> {
  if (!edit.manual || edit.clearOverrides) return null;
  const { presentCharacters, personaStats, playerStats } = edit.fields;
  if (presentCharacters === undefined && personaStats === undefined && playerStats === undefined) return null;
  if (!(await isTrackerAutoAdoptEnabled(app))) return null;

  const gameStateStore = createGameStateStorage(app.db);
  let target = edit.target;
  if (!target) {
    const messages = await createChatsStorage(app.db).listMessages(chatId);
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant) target = { messageId: lastAssistant.id, swipeIndex: lastAssistant.activeSwipeIndex };
  }
  const baseline =
    (target ? await gameStateStore.getByChatAndMessage(chatId, target.messageId, target.swipeIndex) : null) ??
    (await gameStateStore.getLatest(chatId));
  if (!baseline) return null;
  const before: TrackerRowState = {
    presentCharacters: baseline.presentCharacters,
    personaStats: baseline.personaStats,
    playerStats: baseline.playerStats,
  };

  return async () => {
    // Learning is a side effect of an edit that is already stored, so a failure
    // is logged rather than turned into a failed PATCH.
    try {
      const next = foldManualTrackerEdit(await readAdoptedTrackerRows(app), before, {
        presentCharacters,
        personaStats,
        playerStats,
      });
      if (next) await writeAdoptedTrackerRows(app, next);
    } catch (err) {
      logger.error(err, "[tracker] Failed to learn tracker rows from a manual edit of chat %s", chatId);
    }
  };
}
