// Game-state boundary normalization.
//
// PresentCharacter declares characterId/name/emoji/mood/customFields/stats as
// non-nullable, but a snapshot is agent JSON and a custom tracker prompt simply
// omits what it never mentions. TypeScript then vouches for values that are not
// there, which crashed the app shell from inside a useMemo. Every writer funnels
// through the game-state store's single action, so the repair happens there.
//
// The two rules this lane exists to protect: prompt-defined keys survive, and
// untouched objects keep their identity so memoization does not churn.

import assert from "node:assert/strict";

import {
  normalizeGameStateCharacters,
  normalizePresentCharacter,
  normalizePresentCharacters,
} from "../../packages/client/src/lib/game-state-normalize.js";

// ── The crash: an omitted characterId ──
{
  const repaired = normalizePresentCharacter({ name: "Podopieczny" });
  assert.equal(repaired?.characterId, "", "a card-less character gets an empty id, not undefined");
  assert.equal(repaired?.name, "Podopieczny");
}

// ── A custom prompt that omits the built-in fields entirely ──
{
  const raw = {
    name: "Supergirl",
    body: { hair: { color: "blond" } },
    clothing: { footwear: [{ item: "red boots" }] },
  };
  const repaired = normalizePresentCharacter(raw)!;
  assert.equal(repaired.characterId, "");
  assert.equal(repaired.emoji, "");
  assert.equal(repaired.mood, "");
  assert.deepEqual(repaired.customFields, {});
  assert.deepEqual(repaired.stats, []);
  // The whole point: nested prompt output must survive the repair.
  assert.deepEqual((repaired as unknown as typeof raw).body, raw.body);
  assert.deepEqual((repaired as unknown as typeof raw).clothing, raw.clothing);
}

// ── Wrong types, not just missing ones ──
{
  const repaired = normalizePresentCharacter({
    characterId: 42,
    name: null,
    emoji: [],
    mood: {},
    customFields: "nope",
    stats: { hp: 1 },
  })!;
  assert.deepEqual(
    { id: repaired.characterId, name: repaired.name, emoji: repaired.emoji, mood: repaired.mood },
    { id: "", name: "", emoji: "", mood: "" },
  );
  assert.deepEqual(repaired.customFields, {});
  assert.deepEqual(repaired.stats, []);
}

// ── Identity is preserved when nothing needs fixing ──
// A new array every snapshot would defeat downstream memoization.
{
  const healthy = {
    characterId: "nova",
    name: "Nova",
    emoji: "🙂",
    mood: "calm",
    customFields: {},
    stats: [],
    appearance: null,
    outfit: null,
    thoughts: null,
  };
  assert.equal(normalizePresentCharacter(healthy), healthy, "a valid character is returned as-is");
  const list = [healthy];
  assert.equal(normalizePresentCharacters(list), list, "a valid list keeps its identity");
  const state = { presentCharacters: list };
  assert.equal(normalizeGameStateCharacters(state), state, "a valid snapshot keeps its identity");
}

// ── Junk entries are dropped, not rendered ──
assert.deepEqual(normalizePresentCharacters([null, "text", 7]), []);
assert.deepEqual(normalizePresentCharacters(undefined), []);
assert.deepEqual(normalizePresentCharacters({ not: "an array" }), []);
{
  const mixed = normalizePresentCharacters([null, { name: "Kept" }]);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0]!.name, "Kept");
}

// ── The snapshot wrapper touches nothing else ──
{
  const state = {
    presentCharacters: [{ name: "Nameless" }],
    location: "Metropolis",
    recentEvents: ["a", "b"],
  };
  const out = normalizeGameStateCharacters(state as never) as unknown as typeof state;
  assert.equal(out.location, "Metropolis");
  assert.deepEqual(out.recentEvents, state.recentEvents);
  assert.equal(out.presentCharacters[0]!.characterId as unknown as string, "");
}
// A patch with no character list is passed straight through.
{
  const patch = { location: "Elsewhere" };
  assert.equal(normalizeGameStateCharacters(patch as never), patch);
}

console.log("game-state-normalize regression passed.");
