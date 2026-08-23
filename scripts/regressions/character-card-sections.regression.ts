// Both character card layouts must render one shared section tail.
//
// CharacterTrackerExtras used to be mounted in the compact card only, so a
// featured card rendered none of the nested data the tracker agent had already
// stored. The handlers behind those sections were duplicated byte-for-byte
// across both cards, and had already drifted in their casts.
//
// This lane pins the de-duplication itself: the sections live in one component,
// the mutations live in one hook, and neither card may grow its own copy again.
//
// Source-shape checks compare booleans rather than matching against the file, so
// a failure reports the claim instead of dumping 30KB of source.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { readCharacterCustomFieldEntries } from "../../packages/client/src/features/tracker-panel/hooks/use-character-card-mutations.js";

const read = (path: string) => readFileSync(new URL(`../../packages/client/src/${path}`, import.meta.url), "utf8");

const CARD_DIR = "features/tracker-panel/components/character-card/";
const sharedSections = read(`${CARD_DIR}CharacterCardSections.tsx`);
const mutations = read("features/tracker-panel/hooks/use-character-card-mutations.ts");
const cards: Array<[string, string]> = [
  ["compact", read(`${CARD_DIR}CharacterTrackerCard.tsx`)],
  ["featured", read(`${CARD_DIR}FeaturedCharacterTrackerCard.tsx`)],
];

// ── Both layouts mount the shared tail, with density ──
for (const [name, card] of cards) {
  assert.equal(card.includes("<CharacterCardSections"), true, `${name} card renders the shared section tail`);
  assert.equal(card.includes("readable={"), true, `${name} card passes a readable density to the shared tail`);
  assert.equal(
    card.includes("useCharacterCardMutations({ character, characterIndex, onUpdate })"),
    true,
    `${name} card takes its mutations from the shared hook`,
  );
}

// Each layout claims a distinct variant, and the shared component styles both.
const usedVariants = cards.map(([, card]) => /variant="(\w+)"/u.exec(card)?.[1]);
assert.deepEqual(usedVariants, ["compact", "featured"]);
for (const variant of usedVariants) {
  assert.equal(sharedSections.includes(`  ${variant}:`), true, `shared tail styles the ${variant} variant`);
}

// ── The sections exist only in the shared component ──
// This is the check that would have caught the shipped bug: extras cannot be
// mounted in one card and forgotten in the other, because no card mounts it.
assert.equal(sharedSections.includes("<CharacterTrackerExtras"), true, "shared tail renders nested extras");
assert.equal(sharedSections.includes("customFields.map("), true, "shared tail renders the custom-field rows");
for (const [name, card] of cards) {
  assert.equal(
    card.includes("<CharacterTrackerExtras"),
    false,
    `${name} card reaches extras through the shared tail, not directly`,
  );
  assert.equal(card.includes("customFields.map("), false, `${name} card does not re-render the custom-field rows`);
  assert.equal(card.includes("<InlineAddRow"), false, `${name} card does not own the add-field row`);
  // A card assembling a customFields object has forked the hook again.
  assert.equal(card.includes("customFields: nextFields"), false, `${name} card does not write customFields directly`);
}

// ── The mutations exist only in the hook ──
for (const handler of ["updateCustomField", "addCustomField", "removeCustomField", "addCharacterStat"]) {
  assert.equal(mutations.includes(handler), true, `${handler} belongs to the mutations hook`);
  for (const [name, card] of cards) {
    assert.equal(
      card.includes(`const ${handler} =`),
      false,
      `${name} card must not re-declare ${handler}; it lives in use-character-card-mutations`,
    );
  }
}

// ── Hiding a field clears it against that field's own type ──
// `mood` is `string`, the rest are `string | null`. A computed-key spread widens,
// so a value lookup would let `mood: null` compile; literal keys are checked.
assert.equal(
  mutations.includes('mood: (character) => ({ ...character, mood: "" })'),
  true,
  "hiding mood clears it to an empty string, not null",
);
for (const field of ["appearance", "outfit", "thoughts"]) {
  assert.equal(
    mutations.includes(`${field}: (character) => ({ ...character, ${field}: null })`),
    true,
    `hiding ${field} clears it to null`,
  );
}

// ── Custom-field entries keep order and stay editable as text ──
const character = {
  name: "Nova",
  customFields: { Outfit: "coat", Rank: 3, Ready: true, Gear: { left: "torch" } },
} as never;
const entries = readCharacterCustomFieldEntries(character);
assert.deepEqual(
  entries.map(([name]) => name),
  ["Outfit", "Rank", "Ready", "Gear"],
  "insertion order is the render order",
);
// The raw value is preserved for rename writes; only the third slot is display text.
assert.deepEqual(entries[1], ["Rank", 3, "3"]);
assert.deepEqual(entries[2], ["Ready", true, "true"]);
assert.equal(entries[0]?.[1], "coat");
assert.equal(typeof entries[3]?.[2], "string", "a nested value still renders as editable text");

assert.deepEqual(readCharacterCustomFieldEntries({ name: "Nova" } as never), [], "a card with no custom fields");

console.log("character-card-sections regression passed.");
