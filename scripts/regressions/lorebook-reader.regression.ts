// #7464: the Lorebook Reader lists every entry of the chat's lorebooks, pinned ones first, with
// macros replaced for display and search, and keeps its pins with the chat only.
import assert from "node:assert/strict";
import type { LorebookEntry } from "@marinara-engine/shared";
import { CHAT_PRESET_EXCLUDED_METADATA_KEYS } from "../../packages/shared/src/types/chat-preset.js";
import { isViewOnlyChatMetadataPatch } from "../../packages/shared/src/utils/chat-window-defaults.js";
import {
  buildLorebookReaderEntries,
  groupLorebookReaderEntries,
  readLorebookPinnedEntryIds,
  toggleLorebookPinnedEntry,
} from "../../packages/client/src/lib/lorebook-reader.js";

const entry = (id: string, lorebookId: string, name: string, content: string, enabled = true, folderId?: string) =>
  ({ id, lorebookId, name, content, enabled, folderId: folderId ?? null }) as LorebookEntry;

const build = () =>
  buildLorebookReaderEntries({
    lorebooks: [
      { id: "world", name: "Riverside World" },
      { id: "campus", name: "Campus Notes" },
    ],
    // Out of book order on purpose: the Reader groups by the chat's lorebook order, then each book's own order.
    entries: [
      entry("dorm", "campus", "Dorm room", "{{user}} lives in room 4B."),
      entry("riverside", "world", "Riverside", "A quiet town.{{setvar::mood::grim}}"),
      entry("schedule", "campus", "{{user}}'s class schedule", "History with {{char}} on **Monday**.", false),
      entry("cafe", "world", "The Lantern Café", "{{char}} works here. Mood: {{getvar::mood}}"),
      entry("map", "world", "Town map", "Visit {{incvar::visits}}, {{getvar::term}} term.", true, "drawer"),
      entry("elsewhere", "other", "Not in this chat", "Never listed."),
    ],
    entryStateOverrides: { cafe: { enabled: false } },
    disabledFolderIds: new Set(["drawer"]),
    macros: {
      persona: { name: "Jem" },
      primaryCharacter: { name: "Mira" },
      characters: [{ name: "Mira" }],
      variables: { term: "Fall" },
    },
  });
const entries = build();

assert.deepEqual(
  entries.map((item) => [item.id, item.lorebookName, item.name, item.content, item.off]),
  [
    ["riverside", "Riverside World", "Riverside", "A quiet town.", false],
    ["cafe", "Riverside World", "The Lantern Café", "Mira works here. Mood: ", true],
    ["map", "Riverside World", "Town map", "Visit 1, Fall term.", true],
    ["dorm", "Campus Notes", "Dorm room", "Jem lives in room 4B.", false],
    ["schedule", "Campus Notes", "Jem's class schedule", "History with Mira on **Monday**.", true],
  ],
  "entries keep book and entry order, show macros as names, keep variable macros to their own text, and mark " +
    "entries off when disabled, in a switched-off folder, or switched off for this chat",
);
assert.deepEqual(build(), entries, "showing the list again shows the same text ({{incvar}} does not count up)");

const list = groupLorebookReaderEntries(entries, ["schedule", "missing", "riverside"]);
assert.deepEqual(
  list.pinned.map((item) => item.id),
  ["schedule", "riverside"],
  "pins come first in pin order; pins of entries the chat no longer has are skipped",
);
assert.deepEqual(
  list.groups.map((group) => [group.name, group.entries.map((item) => item.id)]),
  [
    ["Riverside World", ["cafe", "map"]],
    ["Campus Notes", ["dorm"]],
  ],
  "the remaining entries stay grouped by lorebook without repeating pinned ones",
);

const search = (query: string) => {
  const result = groupLorebookReaderEntries(entries, ["schedule"], query);
  return [...result.pinned, ...result.groups.flatMap((group) => group.entries)].map((item) => item.id);
};
assert.deepEqual(search("jem"), ["schedule", "dorm"], "search matches names and content as displayed");
assert.deepEqual(search("{{user}}"), [], "search does not match the raw macros");
assert.deepEqual(search("  LANTERN "), ["cafe"], "search ignores case and surrounding spaces");
assert.deepEqual(search("nothing like this"), []);

assert.deepEqual(toggleLorebookPinnedEntry(["a"], "b"), ["a", "b"], "pinning appends");
assert.deepEqual(toggleLorebookPinnedEntry(["a", "b"], "a"), ["b"], "pinning again unpins");
assert.deepEqual(readLorebookPinnedEntryIds({ lorebookPinnedEntryIds: ["a", 3, "", "a", "b"] }), ["a", "b"]);
assert.deepEqual(readLorebookPinnedEntryIds({ lorebookPinnedEntryIds: "a" }), []);
assert.deepEqual(readLorebookPinnedEntryIds(undefined), []);

assert.ok(isViewOnlyChatMetadataPatch(["lorebookPinnedEntryIds"]), "pins are a view-only save");
assert.ok(isViewOnlyChatMetadataPatch(["windowLayout", "lorebookPinnedEntryIds"]));
assert.ok(!isViewOnlyChatMetadataPatch(["lorebookPinnedEntryIds", "activeLorebookIds"]));
assert.ok(!isViewOnlyChatMetadataPatch([]));
assert.ok(CHAT_PRESET_EXCLUDED_METADATA_KEYS.includes("lorebookPinnedEntryIds"), "settings profiles never carry pins");

console.info("Lorebook Reader regressions passed.");
