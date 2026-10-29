/**
 * Automated active characters for Merged Roleplay groups: the choosing rules.
 *
 * Pins keep their state, the narrator stays active, nobody-active and no-change leave the
 * chat alone, and both sources (Decision model answers, Character Tracker present list)
 * report "no data" as null rather than "nobody here".
 */
import assert from "node:assert/strict";

const { chooseSceneCharacters, presentFromDecision, presentFromTracker, scenePresenceQuestions, scenePresenceState } =
  await import("../../packages/server/src/services/generation/scene-presence-decision.js");

const ids = ["narrator", "logan", "kurt", "rogue"];
const choose = (overrides: Partial<Parameters<typeof chooseSceneCharacters>[0]> = {}) =>
  chooseSceneCharacters({
    candidateIds: ids,
    presentIds: ["logan"],
    currentInactiveIds: [],
    pinnedIds: [],
    narratorId: "narrator",
    ...overrides,
  });

// ── choosing ────────────────────────────────────────────────────────────────────

assert.deepEqual(choose(), ["kurt", "rogue"], "absent characters go inactive; the narrator stays active");
assert.deepEqual(
  choose({ currentInactiveIds: ["logan", "kurt", "rogue"], presentIds: ["kurt"] }),
  ["logan", "rogue"],
  "an entering character comes back, a leaving one goes",
);
assert.deepEqual(
  choose({ pinnedIds: ["rogue"], currentInactiveIds: [] }),
  ["kurt"],
  "a pinned active character stays active although absent",
);
assert.deepEqual(
  choose({ pinnedIds: ["logan"], currentInactiveIds: ["logan"], presentIds: ["logan", "kurt"] }),
  ["logan", "rogue"],
  "a pinned inactive character stays inactive although present",
);
assert.equal(choose({ presentIds: null }), null, "no source answered: leave the chat alone");
assert.equal(choose({ currentInactiveIds: ["rogue", "kurt"] }), null, "no change: no write");
assert.equal(
  choose({ narratorId: null, presentIds: [] }),
  null,
  "without a narrator, a choice that leaves nobody active is dropped",
);
assert.deepEqual(
  choose({ narratorId: null, presentIds: ["kurt"] }),
  ["narrator", "logan", "rogue"],
  "without a narrator every character follows the scene",
);
assert.deepEqual(choose({ presentIds: [] }), ["logan", "kurt", "rogue"], "an empty scene keeps only the narrator");

// ── sources ─────────────────────────────────────────────────────────────────────

assert.equal(presentFromDecision(new Map(), 0.5), null, "no answers is no data");
assert.deepEqual(
  presentFromDecision(
    new Map([
      ["logan", 0.9],
      ["kurt", 0.5],
      ["rogue", 0.2],
    ]),
    0.5,
  ),
  ["logan", "kurt"],
  "answers at or over the threshold are present",
);

assert.equal(presentFromTracker(undefined, ids), null, "no tracker list is no data");
assert.equal(presentFromTracker([], ids), null, "an empty tracker list is no data, as the tracker merge treats it");
assert.deepEqual(
  presentFromTracker(
    [{ characterId: "kurt", name: "Kurt" }, { characterId: "npc-guard", name: "Guard" }, { name: "No id" }, null],
    ids,
  ),
  ["kurt"],
  "only attached characters count; NPCs and entries without an id are skipped",
);
assert.deepEqual(
  presentFromTracker([{ characterId: "npc-guard", name: "Guard" }], ids),
  [],
  "a scene of NPCs only is data: no attached character is present",
);

// ── questions and state ─────────────────────────────────────────────────────────

const candidates = [
  { id: "logan", name: "Logan", about: "x".repeat(1000) },
  { id: "kurt", name: "Kurt" },
];
const questions = scenePresenceQuestions(candidates);
assert.deepEqual(
  questions.map((question) => question.id),
  ["logan", "kurt"],
  "one question per candidate, keyed by id",
);
assert.match(questions[0]!.instructions, /^Logan is physically present/, "the question names the character");

const state = scenePresenceState(
  [
    { role: "user", name: "Ylli", content: "I wave Kurt over." },
    { role: "assistant", name: "Narrator", content: "Logan grunts." },
  ],
  candidates,
  ["Logan"],
  4000,
);
assert.deepEqual(state.last_tracked_present, ["Logan"], "the tracker's last scene is in the state");
assert.equal(
  (state.candidates as Array<{ about?: string }>)[0]!.about!.length,
  300,
  "a long card is cut so it cannot crowd out the transcript",
);
assert.equal((state.recent_messages as unknown[]).length, 2, "the transcript is in the state");
assert.equal(
  "last_tracked_present" in scenePresenceState([], candidates, [], 4000),
  false,
  "no tracker data, no empty field",
);

console.log("scene-presence-decision regression passed");
