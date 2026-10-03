// Emptying a preset so an import can write into it.
//
// Characters and personas need none of this: their storage replaces the card in
// one update and keeps the previous one as a version snapshot. Presets keep their
// content in child rows instead, so replacing one means clearing what is there
// first. Nothing snapshots those, which is why the question that leads here has
// to say so. Lorebooks swap their rows inside the importer's own transaction.
//
// Emptying rather than deleting is the point: the row keeps its id, so
// everything pointing at it stays pointed at it.

import type { createPromptsStorage } from "../storage/prompts.storage.js";

type PromptsStorage = ReturnType<typeof createPromptsStorage>;

/**
 * Removes every section, group and choice block from a preset.
 *
 * The ordering arrays name ids that are about to stop existing, so they are
 * emptied here rather than left pointing at nothing until the import rewrites
 * them.
 */
export async function emptyPresetForOverwrite(storage: PromptsStorage, presetId: string): Promise<void> {
  const sections = (await storage.listSections(presetId)) as unknown as Array<{ id: string }>;
  for (const section of sections) {
    await storage.removeSection(section.id);
  }
  const groups = (await storage.listGroups(presetId)) as unknown as Array<{ id: string }>;
  for (const group of groups) {
    await storage.removeGroup(group.id);
  }
  const blocks = (await storage.listChoiceBlocksForPreset(presetId)) as unknown as Array<{ id: string }>;
  for (const block of blocks) {
    await storage.removeChoiceBlock(block.id);
  }
  await storage.update(presetId, { sectionOrder: [], groupOrder: [] });
}
