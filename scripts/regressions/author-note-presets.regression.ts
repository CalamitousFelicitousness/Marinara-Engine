import assert from "node:assert/strict";
import type { AuthorNotePreset } from "../../packages/shared/dist/index.js";
import { normalizeAuthorNoteDepth } from "../../packages/shared/dist/index.js";
import {
  collectAuthorNoteEntries,
  toAuthorNoteDepthEntries,
  toAuthorNotesContextText,
} from "../../packages/server/src/services/prompt/author-notes.js";
import { injectAtDepth } from "../../packages/server/src/services/lorebook/prompt-injector.js";

// Author's notes = chat-local note + active presets, each at its own depth.
// Assembly lives in one module; consumers are generation, dry-run, agent retry.
// This lane pins the behaviour all three depend on.

const identity = (raw: string) => raw;

function preset(overrides: Partial<AuthorNotePreset> & { id: string }): AuthorNotePreset {
  return {
    name: `preset-${overrides.id}`,
    content: `content-${overrides.id}`,
    depth: 4,
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

// ── Agents receive one flattened block, since depth is meaningless there ──
const contextText = toAuthorNotesContextText(combined);
assert.ok(contextText, "active notes must produce agent context text");
for (const entry of combined) {
  assert.ok(contextText!.includes(entry.content), `agent context missing: ${entry.content}`);
}
assert.equal(contextText!.split("\n\n").length, combined.length);

console.log("author-note-presets regression passed.");
