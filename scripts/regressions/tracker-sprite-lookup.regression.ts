// Tracker sprite lookup id normalization.
//
// `PresentCharacter.characterId` is typed string but arrives as agent JSON, and
// a character with no card of its own carries none. `normalizeLookupCharacterIds`
// trimmed every entry unguarded, so one such character crashed the whole app
// shell -- the tracker sidebar threw during a useMemo and the recovery boundary
// swallowed the screen. Reproduced from a real snapshot before this guard.

import assert from "node:assert/strict";

import {
  isSpriteLookupCharacterId,
  normalizeLookupCharacterIds,
} from "../../packages/client/src/features/tracker-panel/lib/sprite-expressions.js";

// ── The crash ──
// A present character without a card contributes undefined; it must be skipped,
// not thrown on.
assert.deepEqual(normalizeLookupCharacterIds(["real-id", undefined]), ["real-id"]);
assert.deepEqual(normalizeLookupCharacterIds([undefined, null]), []);
assert.doesNotThrow(() => normalizeLookupCharacterIds([undefined as unknown as string]));

// Non-string junk from the same untrusted source is dropped rather than coerced.
assert.deepEqual(normalizeLookupCharacterIds([42 as unknown as string, "real-id"]), ["real-id"]);

// ── Normal behaviour is unchanged ──
assert.deepEqual(normalizeLookupCharacterIds(["  padded  "]), ["padded"], "ids are trimmed");
assert.deepEqual(normalizeLookupCharacterIds(["dup", "dup", " dup "]), ["dup"], "deduped after trimming");
assert.deepEqual(normalizeLookupCharacterIds([]), []);
assert.deepEqual(normalizeLookupCharacterIds(["", "   "]), [], "blank ids never reach the query layer");
assert.deepEqual(
  normalizeLookupCharacterIds(["a", "b", "a"]),
  ["a", "b"],
  "first occurrence wins, so query order stays stable",
);

// ── Synthetic ids are not real character cards ──
// These would each become a 404 fetch, so the filter must hold.
for (const synthetic of ["manual-1", "party-npc:guard", "npc:baker"]) {
  assert.ok(!isSpriteLookupCharacterId(synthetic), `${synthetic} must not be looked up`);
  assert.deepEqual(normalizeLookupCharacterIds([synthetic, "real-id"]), ["real-id"]);
}
assert.ok(isSpriteLookupCharacterId("yh6xRJdmaF0qu-JqhBiRv"));

console.log("tracker-sprite-lookup regression passed.");
