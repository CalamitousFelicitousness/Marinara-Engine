import assert from "node:assert/strict";
import type { AuthorNotePreset, AuthorNotePresetSet } from "../../packages/shared/dist/index.js";
import {
  authorNotePresetSetListSchema,
  isAuthorNotePresetSetActive,
  toggleAuthorNotePresetSet,
  normalizeAuthorNoteDepth,
  normalizeAuthorNoteRole,
} from "../../packages/shared/dist/index.js";
import {
  collectAuthorNoteEntries,
  toAuthorNoteDepthEntries,
  toAuthorNotesContextText,
} from "../../packages/server/src/services/prompt/author-notes.js";
import { injectAtDepth } from "../../packages/server/src/services/lorebook/prompt-injector.js";
import { postProcessMessages } from "../../packages/server/src/routes/generate/generate-route-utils.js";

// Author's notes = chat-local note + active presets, each at its own depth.
// Assembly lives in one module; consumers are generation, dry-run, agent retry.
// This lane pins the behaviour all three depend on.

const identity = (raw: string) => raw;

function preset(overrides: Partial<AuthorNotePreset> & { id: string }): AuthorNotePreset {
  return {
    name: `preset-${overrides.id}`,
    content: `content-${overrides.id}`,
    depth: 4,
    role: "system",
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ── Depth normalization is shared, not re-derived per route ──
// The default used to be hardcoded as `4` in three separate files.
assert.equal(normalizeAuthorNoteDepth(undefined), 4);
assert.equal(normalizeAuthorNoteDepth("nonsense"), 4);
assert.equal(normalizeAuthorNoteDepth(Number.NaN), 4);
assert.equal(normalizeAuthorNoteDepth(Infinity), 4);
assert.equal(normalizeAuthorNoteDepth(-3), 0);
assert.equal(normalizeAuthorNoteDepth(2.7), 2);
assert.equal(normalizeAuthorNoteDepth(0), 0);

// ── An empty chat with no presets contributes nothing ──
assert.deepEqual(collectAuthorNoteEntries({}, [], identity), []);
assert.equal(toAuthorNotesContextText([]), null);

// ── The chat-local note still works on its own (pre-presets behaviour) ──
const chatOnly = collectAuthorNoteEntries(
  { authorNotes: "  keep it tense  ", authorNotesDepth: 2 },
  [],
  identity,
);
assert.equal(chatOnly.length, 1);
assert.equal(chatOnly[0]!.content, "keep it tense");
assert.equal(chatOnly[0]!.depth, 2);
assert.equal(chatOnly[0]!.presetId, null);

// A whitespace-only note is not a note.
assert.deepEqual(collectAuthorNoteEntries({ authorNotes: "   \n  " }, [], identity), []);

// ── Only presets listed in chat metadata are active ──
const library = [
  preset({ id: "a", depth: 4, order: 0 }),
  preset({ id: "b", depth: 0, order: 1 }),
  preset({ id: "c", depth: 2, order: 2 }),
];
const twoActive = collectAuthorNoteEntries(
  { activeAuthorNotePresetIds: ["a", "c"] },
  library,
  identity,
);
assert.deepEqual(
  twoActive.map((entry) => entry.presetId),
  ["a", "c"],
);

// ── Several presets may be active at once, each keeping its own depth ──
const allActive = collectAuthorNoteEntries(
  { activeAuthorNotePresetIds: ["a", "b", "c"] },
  library,
  identity,
);
assert.equal(allActive.length, 3);
assert.deepEqual(
  allActive.map((entry) => entry.depth).sort((x, y) => x - y),
  [0, 2, 4],
);

// ── Library order wins over the order ids happen to sit in on the chat row ──
// The user controls preset order by dragging; the chat row is a set.
const shuffled = collectAuthorNoteEntries(
  { activeAuthorNotePresetIds: ["c", "a", "b"] },
  library,
  identity,
);
assert.deepEqual(
  shuffled.filter((entry) => entry.presetId).map((entry) => entry.presetId),
  ["a", "b", "c"],
);

// ── Deleting a preset leaves stale ids by design ──
// Assembly skips them, so a chat holding a deleted preset id still generates.
const stale = collectAuthorNoteEntries(
  { activeAuthorNotePresetIds: ["a", "does-not-exist", "c"] },
  library,
  identity,
);
assert.deepEqual(
  stale.map((entry) => entry.presetId),
  ["a", "c"],
);

// Non-string ids on the chat row are ignored rather than crashing.
assert.deepEqual(
  collectAuthorNoteEntries({ activeAuthorNotePresetIds: [null, 7, "a"] }, library, identity).map(
    (entry) => entry.presetId,
  ),
  ["a"],
);
assert.deepEqual(collectAuthorNoteEntries({ activeAuthorNotePresetIds: "a" }, library, identity), []);

// An active preset with an empty body contributes nothing.
assert.deepEqual(
  collectAuthorNoteEntries(
    { activeAuthorNotePresetIds: ["empty"] },
    [preset({ id: "empty", content: "   " })],
    identity,
  ),
  [],
);

// ── Macros are resolved through the caller-supplied resolver ──
// Each route resolves macros differently, so the module takes a callback.
const resolved = collectAuthorNoteEntries(
  { authorNotes: "{{char}} is tense", activeAuthorNotePresetIds: ["a"] },
  [preset({ id: "a", content: "{{char}} hides a secret" })],
  (raw) => raw.replace(/\{\{char\}\}/g, "Elara"),
);
assert.equal(resolved.length, 2);
assert.ok(resolved.every((entry) => entry.content.startsWith("Elara")));
assert.ok(!resolved.some((entry) => entry.content.includes("{{char}}")));

// A note that resolves to nothing is dropped, not injected blank.
assert.deepEqual(
  collectAuthorNoteEntries({ authorNotes: "{{gone}}" }, [], () => "   "),
  [],
);

// ── The chat-local note and presets are all present together ──
const combined = collectAuthorNoteEntries(
  { authorNotes: "chat note", authorNotesDepth: 1, activeAuthorNotePresetIds: ["a", "b"] },
  library,
  identity,
);
assert.equal(combined.length, 3, "chat-local note and both active presets must all survive");
assert.equal(
  combined.filter((entry) => entry.presetId === null).length,
  1,
  "exactly one chat-local entry",
);
// ── Ordering contract: presets in library order, chat-local note last ──
// injectAtDepth breaks same-depth ties by array position, so this order is what
// the model reads. Chat-local last wins a same-depth contradiction by recency.
assert.deepEqual(
  combined.map((entry) => entry.presetId),
  ["a", "b", null],
);

// Tie-break is observable end-to-end: three notes at one depth arrive in order.
const sameDepth = collectAuthorNoteEntries(
  { authorNotes: "from the chat box", authorNotesDepth: 3, activeAuthorNotePresetIds: ["x", "y"] },
  [
    preset({ id: "x", depth: 3, order: 0, content: "first preset" }),
    preset({ id: "y", depth: 3, order: 1, content: "second preset" }),
  ],
  identity,
);
const sameDepthInjected = injectAtDepth(
  [
    { role: "user" as const, content: "a" },
    { role: "assistant" as const, content: "b" },
    { role: "user" as const, content: "c" },
    { role: "assistant" as const, content: "d" },
  ] as never,
  toAuthorNoteDepthEntries(sameDepth) as never,
) as unknown as Array<{ role: string; content: string }>;
assert.deepEqual(
  sameDepthInjected.filter((message) => message.role === "system").map((message) => message.content),
  ["first preset", "second preset", "from the chat box"],
);

// ── Depth entries hand off cleanly to injectAtDepth ──
const depthEntries = toAuthorNoteDepthEntries(allActive);
assert.ok(depthEntries.every((entry) => entry.role === "system"));
assert.deepEqual(
  [...depthEntries].map((entry) => entry.depth).sort((x, y) => x - y),
  [0, 2, 4],
);

const history = [
  { role: "user" as const, content: "m1" },
  { role: "assistant" as const, content: "m2" },
  { role: "user" as const, content: "m3" },
  { role: "assistant" as const, content: "m4" },
];
const injected = injectAtDepth(history as never, depthEntries as never) as unknown as Array<{
  role: string;
  content: string;
}>;
assert.equal(injected.length, history.length + depthEntries.length);
// Every original message survives, in order.
assert.deepEqual(
  injected.filter((message) => message.role !== "system").map((message) => message.content),
  ["m1", "m2", "m3", "m4"],
);
// Depth 0 lands after the final original message; depth 4 lands before the first.
assert.equal(injected.at(-1)!.content, library.find((entry) => entry.depth === 0)!.content);
assert.equal(injected[0]!.content, library.find((entry) => entry.depth === 4)!.content);

// ── Each note carries its own role into the prompt ──
assert.equal(normalizeAuthorNoteRole(undefined), "system");
assert.equal(normalizeAuthorNoteRole("narrator"), "system");
assert.equal(normalizeAuthorNoteRole("assistant"), "assistant");
const roled = collectAuthorNoteEntries(
  { authorNotes: "chat voice", authorNotesDepth: 0, authorNotesRole: "user", activeAuthorNotePresetIds: ["s", "v"] },
  [
    preset({ id: "s", depth: 2, order: 0, content: "system voice" }),
    preset({ id: "v", depth: 1, order: 1, role: "assistant", content: "assistant voice" }),
  ],
  identity,
);
assert.deepEqual(
  toAuthorNoteDepthEntries(roled).map((entry) => [entry.content, entry.role]),
  [
    ["system voice", "system"],
    ["assistant voice", "assistant"],
    ["chat voice", "user"],
  ],
);
// Chats saved before notes had a role read as system.
assert.equal(collectAuthorNoteEntries({ authorNotes: "old note" }, [], identity)[0]!.role, "system");

// Post-Processing Messages "Apply" sends a mid-history system note as user; user and assistant pass through.
const roledPrompt = injectAtDepth(
  [
    { role: "system" as const, content: "system prompt" },
    { role: "user" as const, content: "u1" },
    { role: "assistant" as const, content: "a1" },
    { role: "user" as const, content: "u2" },
  ] as never,
  toAuthorNoteDepthEntries(roled) as never,
);
const roleOf = (messages: Array<{ role: string; content: string }>, text: string) =>
  messages.find((message) => message.content.includes(text))?.role;
const applied = postProcessMessages(roledPrompt as never, { strictRoleFormatting: true });
assert.equal(roleOf(applied, "system voice"), "user");
assert.equal(roleOf(applied, "assistant voice"), "assistant");
assert.equal(roleOf(applied, "chat voice"), "user");
const notApplied = postProcessMessages(roledPrompt as never, { strictRoleFormatting: false });
assert.equal(roleOf(notApplied, "system voice"), "system");
assert.equal(roleOf(notApplied, "assistant voice"), "assistant");

// ── Agents receive one flattened block, since depth is meaningless there ──
const contextText = toAuthorNotesContextText(combined);
assert.ok(contextText, "active notes must produce agent context text");
for (const entry of combined) {
  assert.ok(contextText!.includes(entry.content), `agent context missing: ${entry.content}`);
}
assert.equal(contextText!.split("\n\n").length, combined.length);

// ── Preset sets: which chips are on, and what a chip click does ──
const set = (id: string, presetIds: string[]): AuthorNotePresetSet => ({ id, name: `set-${id}`, presetIds });
const live = ["a", "b", "c", "d"];
const isOn = (s: AuthorNotePresetSet, active: string[]) => isAuthorNotePresetSetActive(s, active, live);

// All of its presets enabled, in any order, alongside anything else.
assert.equal(isOn(set("x", ["a", "b"]), ["b", "a"]), true);
assert.equal(isOn(set("x", ["a"]), ["a", "b"]), true);
assert.equal(isOn(set("x", ["a", "b"]), ["a"]), false);
// Deleted ids are ignored on both sides.
assert.equal(isOn(set("x", ["a", "gone"]), ["a"]), true);
assert.equal(isOn(set("x", ["a"]), ["a", "gone"]), true);
// Saved empty = "all off"; emptied by deletions = never on.
assert.equal(isOn(set("off", []), []), true);
assert.equal(isOn(set("off", []), ["gone"]), true);
assert.equal(isOn(set("off", []), ["a"]), false);
assert.equal(isOn(set("emptied", ["gone"]), []), false);

const one = set("1", ["a", "b"]);
const two = set("2", ["b", "c"]);
const pair = [one, two];
const click = (sets: AuthorNotePresetSet[], s: AuthorNotePresetSet, active: string[]) =>
  toggleAuthorNotePresetSet(sets, s, active, live);

// Clicking adds; nothing already on is turned off.
assert.deepEqual(click(pair, one, ["d"]), ["d", "a", "b"]);
assert.deepEqual(click(pair, two, ["a", "b"]), ["a", "b", "c"]);
// Clicking an on set again keeps what another on set still holds.
assert.deepEqual(click(pair, two, ["a", "b", "c"]), ["a", "b"]);
assert.deepEqual(click(pair, one, ["a", "b", "c", "d"]), ["b", "c", "d"]);
// An off set holds nothing.
assert.deepEqual(click(pair, two, ["b", "c"]), []);
// A subset of the clicked set does not hold its presets.
const inner = set("inner", ["a"]);
assert.deepEqual(click([one, inner], one, ["a", "b"]), []);
assert.deepEqual(click([set("first", ["c"]), set("second", ["c"])], set("first", ["c"]), ["c"]), []);
// Deleted ids are dropped from the result.
assert.deepEqual(click(pair, set("x", ["a", "gone"]), ["gone"]), ["a"]);
// Saved empty clears; emptied by deletions changes nothing but stale ids.
assert.deepEqual(click(pair, set("off", []), ["a", "c"]), []);
assert.deepEqual(click(pair, set("emptied", ["gone"]), ["a"]), ["a"]);

// ── Set list validation: what PUT /author-note-presets/sets accepts ──
assert.deepEqual(authorNotePresetSetListSchema.parse([{ id: "s1", name: "  Combat ", presetIds: ["a", "b", "a"] }]), [
  { id: "s1", name: "Combat", presetIds: ["a", "b"] },
]);
assert.equal(authorNotePresetSetListSchema.safeParse([{ id: "s1", name: "   ", presetIds: [] }]).success, false);
assert.equal(
  authorNotePresetSetListSchema.safeParse([
    { id: "s1", name: "A", presetIds: [] },
    { id: "s1", name: "B", presetIds: [] },
  ]).success,
  false,
);
assert.equal(
  authorNotePresetSetListSchema.safeParse([{ id: "s1", name: "A", presetIds: [], extra: 1 }]).success,
  false,
);

console.log("author-note-presets regression passed.");
