// Nested per-character tracker data from a custom Character Tracker prompt.
//
// The agent's extra keys (clothing, body, action_traces) were persisted but
// never read back, so they rendered nowhere and vanished on any turn the agent
// omitted them. This lane pins the three rules that make them first-class:
// preserve on omission, lock by dotted path, and edit immutably.

import assert from "node:assert/strict";

import {
  applyTrackerExtraLocks,
  blankTrackerExtraTemplate,
  characterTrackerLockPrefix,
  isTrackerExtraLeaf,
  applyTrackerFieldLocksToGameStatePatch,
  KNOWN_PRESENT_CHARACTER_KEYS,
  mergeTrackerExtras,
  readCharacterExtras,
  readTrackerExtraAt,
  removeTrackerExtraAt,
  trackerExtraLockKey,
  writeTrackerExtraAt,
} from "../../packages/shared/dist/index.js";

// ── Extras are everything PresentCharacter does not render itself ──
const character = {
  characterId: "amy",
  name: "Amy",
  emoji: "🙂",
  mood: "wary",
  appearance: "tall",
  outfit: "wool coat",
  thoughts: null,
  customFields: { Footwear: "boots" },
  stats: [{ name: "HP", value: 90, max: 100, color: "#ef4444" }],
  avatarPath: "/api/avatars/file/amy.png",
  clothing: { footwear: [{ item: "leather boots", heel_height_cm: 4, state: "scuffed" }] },
  action_traces: ["stepped inside"],
};

assert.deepEqual(Object.keys(readCharacterExtras(character)), ["clothing", "action_traces"]);
assert.ok(KNOWN_PRESENT_CHARACTER_KEYS.has("customFields"), "flat custom fields are not extras");
assert.ok(!KNOWN_PRESENT_CHARACTER_KEYS.has("clothing"), "a prompt-defined key is an extra");

// ── Lock keys are dotted paths under the character's own prefix ──
const prefix = characterTrackerLockPrefix({ characterId: "amy", name: "Amy" }, 0);
assert.equal(
  trackerExtraLockKey(prefix, ["clothing", "footwear", 0, "heel_height_cm"]),
  "characters.id:amy.extra.clothing.footwear.0.heel_height_cm",
);
// A dot inside a key must not fracture the path, or an unrelated lock could
// collide with a deeper node.
assert.equal(trackerExtraLockKey(prefix, ["a.b"]), "characters.id:amy.extra.a%2Eb");
// The "extra" namespace keeps a prompt-defined "stats" clear of real stat locks.
assert.notEqual(trackerExtraLockKey(prefix, ["stats"]), `${prefix}.stats`);

// ── Preserve on omission, matching customFields ──
{
  const previous = { clothing: { footwear: [{ item: "boots", heel_height_cm: 10, state: "pristine" }] } };
  const next = { clothing: { footwear: [{ state: "soaked" }] } };
  const merged = mergeTrackerExtras(previous, next) as typeof previous;
  assert.deepEqual(merged.clothing.footwear[0], { item: "boots", heel_height_cm: 10, state: "soaked" });
}

// A key the agent stops mentioning entirely survives.
assert.deepEqual(mergeTrackerExtras({ body: { hair: "wet" } }, {}), { body: { hair: "wet" } });
assert.deepEqual(mergeTrackerExtras({ body: { hair: "wet" } }, undefined), { body: { hair: "wet" } });

// The agent owns list membership: a discarded shoe really is gone.
assert.deepEqual(mergeTrackerExtras({ shoes: [{ item: "a" }, { item: "b" }] }, { shoes: [{ item: "a" }] }), {
  shoes: [{ item: "a" }],
});

// A type change replaces rather than merging incoherently.
assert.deepEqual(mergeTrackerExtras({ note: { a: 1 } }, { note: "plain" }), { note: "plain" });

// ── Locks restore the previous value, at any depth ──
{
  const previous = { clothing: { footwear: [{ item: "boots", heel_height_cm: 10 }] } };
  const next = { clothing: { footwear: [{ item: "sneakers", heel_height_cm: 0 }] } };
  const locked = new Set(["clothing.footwear.0.heel_height_cm"]);
  const result = applyTrackerExtraLocks(previous, next, (path) => locked.has(path.join("."))) as typeof previous;
  assert.equal(result.clothing.footwear[0]!.item, "sneakers", "an unlocked leaf still updates");
  assert.equal(result.clothing.footwear[0]!.heel_height_cm, 10, "a locked leaf is restored");
}

// Locking a container freezes its whole subtree.
{
  const previous = { clothing: { footwear: [{ item: "boots" }], outerwear: [{ item: "coat" }] } };
  const next = { clothing: { footwear: [{ item: "sneakers" }], outerwear: [{ item: "parka" }] } };
  const result = applyTrackerExtraLocks(previous, next, (path) => path.join(".") === "clothing") as typeof previous;
  assert.deepEqual(result.clothing, previous.clothing);
}

// Locking a node the previous tree never had cannot erase the incoming value.
assert.deepEqual(
  applyTrackerExtraLocks(undefined, { fresh: "value" }, (path) => path.join(".") === "fresh"),
  { fresh: "value" },
);

// ── Immutable edits ──
{
  const extras = { clothing: { footwear: [{ item: "boots", state: "pristine" }] } };
  const edited = writeTrackerExtraAt(extras, ["clothing", "footwear", 0, "state"], "soaked") as typeof extras;
  assert.equal(edited.clothing.footwear[0]!.state, "soaked");
  assert.equal(extras.clothing.footwear[0]!.state, "pristine", "the source tree is not mutated");
  assert.equal(readTrackerExtraAt(edited, ["clothing", "footwear", 0, "item"]), "boots");
  assert.equal(readTrackerExtraAt(edited, ["clothing", "nope", 3]), undefined);
}

// Removing an array member closes the gap; removing a key drops it.
assert.deepEqual(removeTrackerExtraAt({ list: ["a", "b", "c"] }, ["list", 1]), { list: ["a", "c"] });
assert.deepEqual(removeTrackerExtraAt({ a: 1, b: 2 }, ["b"]), { a: 1 });

// ── A new array row copies the shape, not the values ──
assert.deepEqual(blankTrackerExtraTemplate({ item: "boots", heel_height_cm: 10, worn: true, tags: ["x"] }), {
  item: "",
  heel_height_cm: 0,
  worn: false,
  tags: [],
});

// ── Leaf classification drives which rows get an input ──
assert.ok(isTrackerExtraLeaf("text") && isTrackerExtraLeaf(3) && isTrackerExtraLeaf(null));
assert.ok(!isTrackerExtraLeaf({}) && !isTrackerExtraLeaf([]));

// ── Runaway nesting is bounded rather than blowing the stack ──
{
  let deep: Record<string, unknown> = { leaf: "bottom" };
  for (let i = 0; i < 200; i++) deep = { down: deep };
  assert.doesNotThrow(() => mergeTrackerExtras(deep, deep));
  assert.doesNotThrow(() => applyTrackerExtraLocks(deep, deep, () => false));
}

// ── Integration: locks reach extras through the real game-state patch path ──
// This is the call both generate.routes.ts and retry-agents-route.ts make, so a
// lock that does not survive here does not survive anywhere.
{
  const currentState = {
    id: "s1",
    chatId: "c1",
    messageId: "m1",
    swipeIndex: 0,
    date: null,
    time: null,
    location: null,
    weather: null,
    temperature: null,
    worldCustomFields: [],
    presentCharacters: [
      {
        characterId: "amy",
        name: "Amy",
        emoji: "🙂",
        mood: "calm",
        appearance: null,
        outfit: null,
        thoughts: null,
        customFields: {},
        stats: [],
        clothing: { footwear: [{ item: "boots", heel_height_cm: 10 }] },
      },
    ],
    recentEvents: [],
    playerStats: null,
    personaStats: null,
    fieldLocks: { "characters.id:amy.extra.clothing.footwear.0.heel_height_cm": true },
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  const patch = {
    presentCharacters: [
      {
        characterId: "amy",
        name: "Amy",
        emoji: "🙂",
        mood: "startled",
        appearance: null,
        outfit: null,
        thoughts: null,
        customFields: {},
        stats: [],
        clothing: { footwear: [{ item: "sneakers", heel_height_cm: 0 }] },
      },
    ],
  };

  const result = applyTrackerFieldLocksToGameStatePatch(patch, currentState as never);
  const shoe = (result.presentCharacters as Array<Record<string, never>>)[0]!.clothing.footwear[0];
  assert.equal(shoe.item, "sneakers", "an unlocked nested leaf still updates through the patch path");
  assert.equal(shoe.heel_height_cm, 10, "a locked nested leaf survives the patch path");
  assert.equal((result.presentCharacters as Array<Record<string, unknown>>)[0]!.mood, "startled");
}

console.log("tracker-extras regression passed.");
