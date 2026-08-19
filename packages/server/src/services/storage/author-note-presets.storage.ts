// ──────────────────────────────────────────────
// Storage: Author's Note Presets
// ──────────────────────────────────────────────
import { eq, asc } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { authorNotePresets } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";
import type { CreateAuthorNotePresetInput, UpdateAuthorNotePresetInput } from "@marinara-engine/shared";

export function createAuthorNotePresetsStorage(db: DB) {
  async function getNextOrder(): Promise<number> {
    const rows = await db.select({ order: authorNotePresets.order }).from(authorNotePresets);
    return rows.reduce((maxOrder, row) => Math.max(maxOrder, row.order), -1) + 1;
  }

  return {
    async list() {
      return db
        .select()
        .from(authorNotePresets)
        .orderBy(asc(authorNotePresets.order), asc(authorNotePresets.createdAt), asc(authorNotePresets.id));
    },

    async getById(id: string) {
      const rows = await db.select().from(authorNotePresets).where(eq(authorNotePresets.id, id));
      return rows[0] ?? null;
    },

    async create(input: CreateAuthorNotePresetInput) {
      const id = newId();
      const timestamp = now();
      await db.insert(authorNotePresets).values({
        id,
        name: input.name,
        content: input.content ?? "",
        depth: input.depth ?? 4,
        order: input.order ?? (await getNextOrder()),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      return this.getById(id);
    },

    async update(id: string, data: UpdateAuthorNotePresetInput) {
      const updateFields: Record<string, unknown> = { updatedAt: now() };
      if (data.name !== undefined) updateFields.name = data.name;
      if (data.content !== undefined) updateFields.content = data.content;
      if (data.depth !== undefined) updateFields.depth = data.depth;
      if (data.order !== undefined) updateFields.order = data.order;
      await db.update(authorNotePresets).set(updateFields).where(eq(authorNotePresets.id, id));
      return this.getById(id);
    },

    async reorder(presetIds: string[]) {
      const uniquePresetIds = Array.from(new Set(presetIds));
      if (uniquePresetIds.length === 0) return this.list();
      const orderedRows = await this.list();
      const existingIds = new Set(orderedRows.map((preset) => preset.id));
      const incomingQueue = uniquePresetIds.filter((id) => existingIds.has(id));
      if (incomingQueue.length === 0) return orderedRows;
      // Unnamed rows keep their slot. Named rows are dealt back into the slots
      // they collectively occupied, in requested order.
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
            .update(authorNotePresets)
            .set({ order: index, updatedAt: timestamp })
            .where(eq(authorNotePresets.id, nextIds[index]!));
        }
      });
      return this.list();
    },

    async remove(id: string) {
      // No cross-table cleanup: chats keep the stale id and prompt assembly
      // drops ids that no longer resolve.
      await db.delete(authorNotePresets).where(eq(authorNotePresets.id, id));
    },
  };
}
