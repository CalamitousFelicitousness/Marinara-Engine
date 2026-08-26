// The tracker panel must not re-render every character card on every patch.
//
// Measured before this lane existed: with 6 characters present, adding a 7th
// re-rendered all 6 untouched cards (7 of 7 cards, 8 renders). Afterwards only
// the new card rendered (1 of 7, 2 renders). The waste scales with the cast, and
// issue #3104 is a freeze report from chats running the tracker agents.
//
// Four independent causes had to be fixed together; any one of them restores the
// full fan-out on its own, and none of them fails visibly. That is what this
// lane pins.
//
// To re-measure: `localStorage.mariPerfVerbose = "1"`, reload, and watch the
// `[mari-perf] tracker-card:<n>` lines while a tracker turn streams.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shallowRecordEqual } from "../../packages/client/src/lib/shallow-record-equal.js";

const read = (path: string) => readFileSync(new URL(`../../packages/client/src/${path}`, import.meta.url), "utf8");

const panel = read("features/tracker-panel/components/sections/CharacterTrackerPanel.tsx");
const statIcons = read("features/tracker-panel/hooks/use-stat-icons.ts");
const mutations = read("features/tracker-panel/hooks/use-tracker-mutations.ts");
// Featured and collapsed cards share one implementation; the stability
// properties below live there now rather than in the featured wrapper.
const cardKeySet = read("features/tracker-panel/hooks/use-character-card-key-set.ts");
const sidebar = read("features/tracker-panel/components/TrackerDataSidebar.tsx");

// ── 1. Memo boundaries, and props stable enough for them to bite ──
// A memo boundary is worthless while the map builds fresh closures per card.
for (const slot of ["CompactCharacterCardSlot", "FeaturedCharacterCardSlot"]) {
  assert.equal(panel.includes(`memo(function ${slot}`), true, `${slot} is a memo boundary`);
}
for (const closure of [
  "onUpdate={(updated) =>",
  "onRemove={() =>",
  "onToggleFeatured={() =>",
  "onUploadAvatar={() =>",
]) {
  assert.equal(
    panel.includes(closure),
    false,
    `the card map must not build ${closure} per render; the memoized slot holds the index instead`,
  );
}

// ── 2. The stat lookup keeps one identity ──
// It is a prop on every card, and it is an API over moving state rather than a
// derived value, so it reads `latest` at call time instead of listing deps.
assert.equal(statIcons.includes("useMemo<StatIconLookup>"), true, "the lookup is memoized");
// Prettier splits the memo call across lines, so match the deps array alone.
assert.equal(/\}\),\s*\[\],\s*\);/u.test(statIcons), true, "the lookup has no deps; new inputs go in the latest ref");
assert.equal(statIcons.includes("latest.current."), true, "the lookup resolves against current state at call time");

// ── 3. Character mutations survive a patch ──
// They closed over the rendered snapshot, so every patch changed their identity.
assert.equal(mutations.includes("renderedCharactersRef.current"), true, "the rendered snapshot is read via ref");
assert.equal(cardKeySet.includes("keysRef.current"), true, "the key set is read via ref, not closed over");
assert.equal(
  cardKeySet.includes("mutate: mutateChatMetadata"),
  true,
  "only `mutate` is referentially stable; the mutation object it hangs off is not",
);

// ── 4. The lock context does not churn ──
// Context updates bypass React.memo, so an unstable context value re-renders
// every card no matter what the props do. Both normalizers allocate per call.
assert.equal(
  (sidebar.match(/useStableRecord\(/gu) ?? []).length >= 2,
  true,
  "both lock records are held at their previous reference while unchanged",
);

// ── Containment reserves each card's real height ──
// A fixed guess for a variable-height card made the list jump as cards scrolled in.
assert.equal(
  panel.includes("contain-intrinsic-size:auto_10rem"),
  true,
  "content-visibility placeholders reuse the last rendered height",
);

// ── One shallow comparison, not two ──
assert.equal(
  mutations.includes("function shallowRecordEqual"),
  false,
  "shallowRecordEqual lives in lib/shallow-record-equal",
);

// ── shallowRecordEqual behaviour ──
assert.equal(shallowRecordEqual({ a: 1 }, { a: 1 }), true, "same content, different objects");
assert.equal(shallowRecordEqual({ a: 1 }, { a: 2 }), false, "changed value");
assert.equal(shallowRecordEqual({ a: 1 }, { a: 1, b: 2 }), false, "an added key is a change");
assert.equal(shallowRecordEqual({ a: 1, b: 2 }, { a: 1 }), false, "a removed key is a change");
assert.equal(shallowRecordEqual({}, {}), true, "two empty records match");
// Keys are compared as a union, so an explicit undefined reads as an absent key.
// Both callers want that: locks are cleared with `delete`, never set to
// undefined, and the rendered-vs-updated diff treats "no value" as one state.
assert.equal(shallowRecordEqual({ a: undefined }, {}), true, "an explicit undefined matches an absent key");
// One level only: nested objects compare by identity, which is what callers want.
const nested = { deep: true };
assert.equal(shallowRecordEqual({ nested }, { nested }), true, "same nested reference");
assert.equal(shallowRecordEqual({ nested: { deep: true } }, { nested: { deep: true } }), false, "one level only");
// Non-records never claim equality unless they are the same value.
assert.equal(shallowRecordEqual(null, null), true);
assert.equal(shallowRecordEqual(null, {}), false);
assert.equal(shallowRecordEqual(undefined, null), false);
assert.equal(shallowRecordEqual("a", "a"), true, "Object.is short-circuits primitives");

console.log("tracker-render-cost regression passed.");
