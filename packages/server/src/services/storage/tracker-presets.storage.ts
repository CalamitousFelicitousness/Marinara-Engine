// ──────────────────────────────────────────────
// Storage: Tracker Presets
// ──────────────────────────────────────────────
import { eq, asc } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { trackerPresets } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";
import {
  TRACKER_PRESET_SETTINGS_KEY,
  type CreateTrackerPresetInput,
  type ResolvedTrackerPreset,
  type TrackerPreset,
  type UpdateTrackerPresetInput,
} from "@marinara-engine/shared";
import { createAppSettingsStorage } from "./app-settings.storage.js";

type TrackerPresetRow = {
  id: string;
  name: string;
  characterFields: string;
  characterStats: string;
  personaFields: string;
  personaStats: string;
  order: number;
  createdAt: string;
  updatedAt: string;
};

function parseList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Decode the four JSON payload columns. Malformed JSON degrades to an empty list. */
function projectPreset(row: TrackerPresetRow): TrackerPreset {
  return {
    id: row.id,
    name: row.name,
    characterFields: parseList(row.characterFields),
    characterStats: parseList(row.characterStats),
    personaFields: parseList(row.personaFields),
    personaStats: parseList(row.personaStats),
    order: row.order,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createTrackerPresetsStorage(db: DB) {
  const appSettings = createAppSettingsStorage(db);

  async function getNextOrder(): Promise<number> {
    const rows = await db.select({ order: trackerPresets.order }).from(trackerPresets);
    return rows.reduce((maxOrder, row) => Math.max(maxOrder, row.order), -1) + 1;
  }

  return {
    async list(): Promise<TrackerPreset[]> {
      const rows = (await db
        .select()
        .from(trackerPresets)
        .orderBy(asc(trackerPresets.order), asc(trackerPresets.createdAt), asc(trackerPresets.id))) as
        | TrackerPresetRow[]
        | undefined;
      return (rows ?? []).map(projectPreset);
    },

    async getById(id: string): Promise<TrackerPreset | null> {
      const rows = (await db.select().from(trackerPresets).where(eq(trackerPresets.id, id))) as
        | TrackerPresetRow[]
        | undefined;
      const row = rows?.[0];
      return row ? projectPreset(row) : null;
    },

    async create(input: CreateTrackerPresetInput): Promise<TrackerPreset | null> {
      const id = newId();
      const timestamp = now();
      await db.insert(trackerPresets).values({
        id,
        name: input.name,
        characterFields: JSON.stringify(input.characterFields ?? []),
        characterStats: JSON.stringify(input.characterStats ?? []),
        personaFields: JSON.stringify(input.personaFields ?? []),
        personaStats: JSON.stringify(input.personaStats ?? []),
        order: input.order ?? (await getNextOrder()),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return this.getById(id);
    },

    async update(id: string, data: UpdateTrackerPresetInput): Promise<TrackerPreset | null> {
      const updateFields: Record<string, unknown> = { updatedAt: now() };
      if (data.name !== undefined) updateFields.name = data.name;
      if (data.characterFields !== undefined) updateFields.characterFields = JSON.stringify(data.characterFields);
      if (data.characterStats !== undefined) updateFields.characterStats = JSON.stringify(data.characterStats);
      if (data.personaFields !== undefined) updateFields.personaFields = JSON.stringify(data.personaFields);
      if (data.personaStats !== undefined) updateFields.personaStats = JSON.stringify(data.personaStats);
      if (data.order !== undefined) updateFields.order = data.order;
      await db.update(trackerPresets).set(updateFields).where(eq(trackerPresets.id, id));
      return this.getById(id);
    },

    async reorder(presetIds: string[]): Promise<TrackerPreset[]> {
      const uniquePresetIds = Array.from(new Set(presetIds));
      if (uniquePresetIds.length === 0) return this.list();
      const orderedRows = await this.list();
      const existingIds = new Set(orderedRows.map((preset) => preset.id));
      const incomingQueue = uniquePresetIds.filter((id) => existingIds.has(id));
      if (incomingQueue.length === 0) return orderedRows;
      // Unnamed rows keep their slot; named rows are dealt back into the slots
      // they collectively occupied, in requested order. Mirrors author's notes.
      const movingIds = new Set(incomingQueue);
      let cursor = 0;
      const nextIds = orderedRows.map((preset) => {
        if (!movingIds.has(preset.id)) return preset.id;
        const nextId = incomingQueue[cursor];
        cursor += 1;
        return nextId ?? preset.id;
      });
      const timestamp = now();
      await db.transaction(async (tx) => {
        for (let index = 0; index < nextIds.length; index += 1) {
          await tx
            .update(trackerPresets)
            .set({ order: index, updatedAt: timestamp })
            .where(eq(trackerPresets.id, nextIds[index]!));
        }
      });
      return this.list();
    },

    async remove(id: string): Promise<void> {
      await db.delete(trackerPresets).where(eq(trackerPresets.id, id));
      // Clear the global pointer so seeding does not keep resolving a dead id.
      // Chats keep their stale override and fall back to the global selection.
      if ((await appSettings.get(TRACKER_PRESET_SETTINGS_KEY)) === id) {
        await appSettings.set(TRACKER_PRESET_SETTINGS_KEY, "");
      }
    },

    async getActiveId(): Promise<string | null> {
      const value = await appSettings.get(TRACKER_PRESET_SETTINGS_KEY);
      return value?.trim() ? value : null;
    },

    async setActiveId(presetId: string | null): Promise<string | null> {
      await appSettings.set(TRACKER_PRESET_SETTINGS_KEY, presetId ?? "");
      return presetId;
    },

    /**
     * Resolve which preset applies. A chat override of `null` is a deliberate
     * opt-out; `undefined` inherits. An id that no longer resolves falls back
     * to the global selection rather than silently disabling the preset.
     */
    async resolveForChat(chatPresetId: string | null | undefined): Promise<ResolvedTrackerPreset> {
      if (chatPresetId === null) return { preset: null, source: "chat" };
      if (typeof chatPresetId === "string" && chatPresetId.trim()) {
        const preset = await this.getById(chatPresetId);
        if (preset) return { preset, source: "chat" };
      }
      const activeId = await this.getActiveId();
      if (!activeId) return { preset: null, source: "none" };
      const preset = await this.getById(activeId);
      return preset ? { preset, source: "global" } : { preset: null, source: "none" };
    },
  };
}
