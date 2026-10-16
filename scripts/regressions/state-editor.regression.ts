// #7736: the State Editor pretty-prints sections exactly like JSON.stringify while knowing each node's line,
// searches keys and values with readable trails, tells real changes from reformatting, and folds several
// game-state sections into one PATCH without one playerStats slice undoing another.
import assert from "node:assert/strict";
import type { GameState } from "@marinara-engine/shared";
import {
  collectStateChanges,
  getStateSectionDraftStatus,
  layoutStateJson,
  searchStateSections,
  statePathKey,
} from "../../packages/client/src/lib/state-editor/state-editor-json.js";
import {
  buildGameStateEditorPatch,
  buildGameStateEditorSections,
  GAME_STATE_EDITOR_SECTION_IDS,
} from "../../packages/client/src/lib/state-editor/game-state-editor-source.js";
import type { StateEditorSection } from "../../packages/client/src/lib/state-editor/state-editor.types.js";

// ── layout ──

for (const value of [
  null,
  "text",
  42,
  [],
  {},
  [1, [2, []], { a: {} }],
  { a: 1, b: [true, null, "x"], c: { d: 'e\n"quoted"' }, skipped: undefined },
  [undefined, () => 1],
]) {
  assert.equal(
    layoutStateJson(value).text,
    JSON.stringify(value, null, 2),
    `layout matches JSON.stringify for ${JSON.stringify(value)}`,
  );
}

const sample = { scene: { location: "Harbor" }, people: [{ name: "Gwendolyn", mood: "tense" }, { mood: "calm" }] };
const { text, lineByPath } = layoutStateJson(sample);
const lines = text.split("\n");
const lineOf = (path: Array<string | number>) => lines[lineByPath.get(statePathKey(path))! - 1]!.trim();
assert.equal(lineOf(["scene", "location"]), '"location": "Harbor"', "a leaf's line is the line holding it");
assert.equal(lineOf(["people", 0]), "{", "an array item's line is where it opens");
assert.equal(lineOf(["people", 1, "mood"]), '"mood": "calm"');

// ── drafts ──

const section: StateEditorSection = { id: "scene", label: "Scene", value: { location: "Harbor" } };
assert.deepEqual(getStateSectionDraftStatus(section, undefined), { kind: "clean" }, "no draft is clean");
assert.deepEqual(
  getStateSectionDraftStatus(section, '{"location":"Harbor"}'),
  { kind: "clean" },
  "reformatting alone is not a change",
);
assert.deepEqual(getStateSectionDraftStatus(section, '{"location":"Docks"}'), {
  kind: "changed",
  value: { location: "Docks" },
});
assert.equal(getStateSectionDraftStatus(section, '{"location":').kind, "invalid", "broken JSON is invalid");

const other: StateEditorSection = { id: "quests", label: "Quests", value: [] };
assert.deepEqual(collectStateChanges([section, other], { scene: '{"location":"Docks"}', quests: "[" }), {
  changes: [{ sectionId: "scene", value: { location: "Docks" } }],
  invalidSectionIds: ["quests"],
});

// ── search ──

const people: StateEditorSection = { id: "people", label: "Present Characters", value: sample.people };
const hits = searchStateSections([section, people], "MOOD");
assert.deepEqual(
  hits.map((hit) => [hit.sectionLabel, ...hit.trail, hit.key].join(" > ")),
  ["Present Characters > Gwendolyn > mood", "Present Characters > #2 > mood"],
  "keys match case-insensitively, and array items are named by their name field or position",
);
assert.equal(hits[0]!.preview, '"mood": "tense"');
assert.equal(
  layoutStateJson(sample.people).text.split("\n")[hits[0]!.line - 1]!.trim(),
  '"mood": "tense"',
  "a result's line points at the match",
);

const valueHits = searchStateSections([section, people], "harb");
assert.equal(valueHits.length, 1, "primitive values match too");
assert.equal(valueHits[0]!.key, "location");

assert.equal(
  searchStateSections([section], "docks", { scene: { location: "Docks" } }).length,
  1,
  "search reads the draft values it's given",
);
assert.deepEqual(searchStateSections([section], "   "), [], "a blank query finds nothing");

// ── game-state patch folding ──

const gameState = {
  id: "gs-1",
  chatId: "chat-1",
  messageId: "msg-1",
  swipeIndex: 0,
  date: "Day 3",
  time: "Dusk",
  location: "Harbor",
  weather: "Fog",
  temperature: "12°C",
  worldCustomFields: [],
  presentCharacters: [],
  recentEvents: [],
  playerStats: {
    stats: [],
    attributes: null,
    skills: {},
    inventory: [],
    activeQuests: [{ name: "Find the lighthouse keeper", completed: false }],
    status: "",
    customTrackerFields: [{ name: "Reputation", value: "Neutral" }],
  },
  personaStats: [],
  createdAt: "2026-10-16T00:00:00.000Z",
} as unknown as GameState;

const sections = buildGameStateEditorSections(gameState, (id, part) => `${id}.${part}`);
assert.deepEqual(
  sections.map((item) => item.id),
  [...GAME_STATE_EDITOR_SECTION_IDS],
);
assert.equal(sections[0]!.label, "world-state.label");

const quests = [{ name: "Find the lighthouse keeper", completed: true }];
const customFields = [{ name: "Reputation", value: "Trusted" }];
const folded = buildGameStateEditorPatch(gameState, [
  { sectionId: "quest", value: quests },
  { sectionId: "custom-tracker", value: customFields },
]);
assert.ok("patch" in folded);
const playerStats = folded.patch.playerStats as Record<string, unknown>;
assert.deepEqual(playerStats.activeQuests, quests, "the first playerStats section survives the second");
assert.deepEqual(playerStats.customTrackerFields, customFields);

const scene = buildGameStateEditorPatch(gameState, [
  { sectionId: "world-state", value: { location: "Docks", worldCustomFields: [] } },
]);
assert.ok("patch" in scene);
assert.deepEqual(scene.patch, { location: "Docks", worldCustomFields: [] }, "only the keys in the draft are sent");

const rejected = buildGameStateEditorPatch(gameState, [{ sectionId: "quest", value: { not: "an array" } }]);
assert.ok("error" in rejected);
assert.equal(rejected.sectionId, "quest", "a slice's validation error names its section");

console.log("state-editor regression passed");
