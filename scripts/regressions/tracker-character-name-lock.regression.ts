// #7689: a character's locked name survives the Character Tracker. The user renamed the row a
// multi-person card ("Family survivors") had claimed to "Madeline" and locked the name; when the agent
// then reported her by name without her id, the lock (keyed by that id) stopped matching her row, and
// the next turn's card name replaced "Madeline" again. Runs the generate route's tracker steps.
import assert from "node:assert/strict";
import {
  applyTrackerFieldLocksToGameStatePatch,
  characterTrackerLockKey,
  isTrackerFieldLocked,
  type GameState,
  type PresentCharacter,
} from "../../packages/shared/src/index.js";
import {
  applyTrackerCharacterCardIdentity,
  preserveTrackerCharacterUiFields,
} from "../../packages/server/src/routes/generate/generate-route-utils.js";

const cards = [{ id: "family-card", name: "Family survivors" }];
const corrected = [
  { characterId: "family-card", name: "Madeline", mood: "Wary" },
  { characterId: "elise", name: "Elise", mood: "Playful" },
] as PresentCharacter[];
const nameLocks = { [characterTrackerLockKey(corrected[0], 0, "name")]: true };

/** One Character Tracker result applied the way the generate route applies it. */
function applyTurn(reported: Array<Record<string, unknown>>, previous: PresentCharacter[], fieldLocks = nameLocks) {
  const characters = structuredClone(reported);
  applyTrackerCharacterCardIdentity(characters, cards, { previousCharacters: previous as never });
  preserveTrackerCharacterUiFields(characters, previous as never);
  const state = { presentCharacters: previous, fieldLocks } as unknown as GameState;
  return applyTrackerFieldLocksToGameStatePatch({ presentCharacters: characters }, state)
    .presentCharacters as PresentCharacter[];
}

// The agent names her without her id: the name stays, and so does the id her lock is keyed by.
const named = applyTurn(
  [
    { name: "Madeline", mood: "Tired" },
    { name: "Elise", mood: "Cheerful" },
  ],
  corrected,
);
const { characterId, name, mood } = named[0]!;
assert.deepEqual({ characterId, name, mood }, { characterId: "family-card", name: "Madeline", mood: "Tired" });
assert.equal(isTrackerFieldLocked(nameLocks, characterTrackerLockKey(named[0], 0, "name")), true);
assert.equal(named[1]?.mood, "Cheerful");

// Next turn the agent falls back to the card's name, with or without the id: the lock still holds.
for (const reportedFirst of [{ name: "Family survivors" }, { characterId: "family-card", name: "Family survivors" }]) {
  const next = applyTurn([{ ...reportedFirst, mood: "Calm" }, { name: "Elise" }], named);
  assert.equal(next[0]?.name, "Madeline", JSON.stringify(reportedFirst));
  assert.equal(next[0]?.mood, "Calm", "unlocked fields still follow the agent");
}

// Without a lock the card's name comes back, so the lock is what keeps the correction.
assert.equal(applyTurn([{ name: "Family survivors" }, { name: "Elise" }], named, {})[0]?.name, "Family survivors");

// A row the agent reports with that id itself keeps it; the named row does not take a copy.
const both = applyTurn([{ name: "Madeline" }, { characterId: "family-card", name: "Family survivors" }], corrected);
assert.equal(both.filter((character) => character.characterId === "family-card").length, 1);

console.log("tracker character name lock regression passed");
