// ──────────────────────────────────────────────
// Lorebook Reader: the list a chat's Lorebook Reader shows
//
// Entries from every lorebook the chat uses, in each book's own order, with macros
// replaced for display. Pinned entries (saved with the chat) come first, in the
// order they were pinned; the rest stay grouped by lorebook. Disabled entries,
// including ones in a switched-off folder or switched off for this chat only, are
// kept and marked off.
// ──────────────────────────────────────────────
import type { LorebookEntry } from "@marinara-engine/shared";
import { createMessageMacroResolver } from "./chat-macros";

type MessageMacroContextInput = Parameters<typeof createMessageMacroResolver>[0];

/** Chat metadata key holding the Reader's pinned entry ids. */
export const LOREBOOK_PINNED_ENTRY_IDS_KEY = "lorebookPinnedEntryIds";

/** An entry's name and content with macros replaced, as the Reader shows them. */
interface LorebookReaderText {
  name: string;
  content: string;
}

export interface LorebookReaderEntry extends LorebookReaderText {
  id: string;
  lorebookId: string;
  lorebookName: string;
  /** Off for the model: disabled itself, by its folder, or for this chat. */
  off: boolean;
}

export interface LorebookReaderList {
  pinned: LorebookReaderEntry[];
  groups: Array<{ id: string; name: string; entries: LorebookReaderEntry[] }>;
}

export function readLorebookPinnedEntryIds(metadata: Record<string, unknown> | null | undefined): string[] {
  const value = metadata?.[LOREBOOK_PINNED_ENTRY_IDS_KEY];
  return Array.isArray(value)
    ? Array.from(new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0)))
    : [];
}

/** Pins the entry at the end of the pinned list, or unpins it. */
export function toggleLorebookPinnedEntry(pinnedIds: readonly string[], entryId: string): string[] {
  return pinnedIds.includes(entryId) ? pinnedIds.filter((id) => id !== entryId) : [...pinnedIds, entryId];
}

/**
 * Shows an entry's name and content the way chat messages show text, with macros replaced. Each text gets
 * a fresh macro context, so a variable macro such as {{setvar}} or {{incvar}} never carries into another
 * text or into the next build. The result is kept per entry, so rebuilding the list after a pin or another
 * chat update does not resolve every entry again.
 */
export function createLorebookReaderDisplay(macros: MessageMacroContextInput, randomSeed?: string) {
  const shown = new WeakMap<LorebookEntry, LorebookReaderText>();
  const resolve = (text: string) =>
    createMessageMacroResolver({ ...macros, variables: { ...macros.variables } }, { randomSeed })(text);
  return (entry: LorebookEntry): LorebookReaderText => {
    let text = shown.get(entry);
    if (!text) {
      text = { name: resolve(entry.name ?? "").trim(), content: resolve(entry.content ?? "") };
      shown.set(entry, text);
    }
    return text;
  };
}

/** Every entry of the chat's lorebooks, book by book, as the Reader displays it. */
export function buildLorebookReaderEntries({
  lorebooks,
  entries,
  entryStateOverrides,
  disabledFolderIds,
  display,
}: {
  lorebooks: ReadonlyArray<{ id: string; name: string }>;
  entries: readonly LorebookEntry[];
  entryStateOverrides?: Record<string, { enabled?: boolean } | undefined> | null;
  /** Folders whose entries never activate (see collectEffectivelyDisabledFolderIds). */
  disabledFolderIds?: ReadonlySet<string>;
  display: (entry: LorebookEntry) => LorebookReaderText;
}): LorebookReaderEntry[] {
  return lorebooks.flatMap((lorebook) =>
    entries
      .filter((entry) => entry.lorebookId === lorebook.id)
      .map((entry) => ({
        id: entry.id,
        lorebookId: lorebook.id,
        lorebookName: lorebook.name,
        ...display(entry),
        off:
          entry.enabled === false ||
          (!!entry.folderId && !!disabledFolderIds?.has(entry.folderId)) ||
          entryStateOverrides?.[entry.id]?.enabled === false,
      })),
  );
}

/** The list for a search (matching displayed names and content): pinned entries first, then each book's others. */
export function groupLorebookReaderEntries(
  entries: readonly LorebookReaderEntry[],
  pinnedIds: readonly string[],
  query = "",
): LorebookReaderList {
  const needle = query.trim().toLocaleLowerCase();
  const matches = (entry: LorebookReaderEntry) =>
    !needle || entry.name.toLocaleLowerCase().includes(needle) || entry.content.toLocaleLowerCase().includes(needle);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const pinned = pinnedIds.flatMap((id) => {
    const entry = byId.get(id);
    return entry && matches(entry) ? [entry] : [];
  });
  const pinnedSet = new Set(pinnedIds);
  const groups: LorebookReaderList["groups"] = [];
  for (const entry of entries) {
    if (pinnedSet.has(entry.id) || !matches(entry)) continue;
    const group = groups.at(-1);
    if (group?.id === entry.lorebookId) group.entries.push(entry);
    else groups.push({ id: entry.lorebookId, name: entry.lorebookName, entries: [entry] });
  }
  return { pinned, groups };
}
