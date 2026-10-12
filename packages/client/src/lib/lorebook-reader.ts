// ──────────────────────────────────────────────
// Lorebook Reader: the list a chat's Lorebook Reader shows
//
// Entries from every lorebook the chat uses, in each book's own order, with macros
// replaced for display. Pinned entries (saved with the chat) come first, in the
// order they were pinned; the rest stay grouped by lorebook. Disabled entries,
// including ones switched off for this chat only, are kept and marked off.
// ──────────────────────────────────────────────
import type { LorebookEntry } from "@marinara-engine/shared";

/** Chat metadata key holding the Reader's pinned entry ids. */
export const LOREBOOK_PINNED_ENTRY_IDS_KEY = "lorebookPinnedEntryIds";

export interface LorebookReaderEntry {
  id: string;
  lorebookId: string;
  lorebookName: string;
  /** Name and content with macros replaced, as the Reader shows them. */
  name: string;
  content: string;
  /** Off for the model: disabled in its lorebook or for this chat. */
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

/** Every entry of the chat's lorebooks, book by book, as the Reader displays it. */
export function buildLorebookReaderEntries({
  lorebooks,
  entries,
  entryStateOverrides,
  display,
}: {
  lorebooks: ReadonlyArray<{ id: string; name: string }>;
  entries: readonly LorebookEntry[];
  entryStateOverrides?: Record<string, { enabled?: boolean } | undefined> | null;
  display: (text: string) => string;
}): LorebookReaderEntry[] {
  return lorebooks.flatMap((lorebook) =>
    entries
      .filter((entry) => entry.lorebookId === lorebook.id)
      .map((entry) => ({
        id: entry.id,
        lorebookId: lorebook.id,
        lorebookName: lorebook.name,
        name: display(entry.name ?? "").trim(),
        content: display(entry.content ?? ""),
        off: entry.enabled === false || entryStateOverrides?.[entry.id]?.enabled === false,
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
