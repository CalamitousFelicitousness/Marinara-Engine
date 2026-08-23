// Character detail fields must flex to their content, and the persona must
// resolve a tracker portrait.
//
// Two fixes that only show up visually, so they are pinned by source shape.
//
// 1. mood / appearance / outfit truncated to a single line unless the card also
//    carried stats or custom fields -- backwards, since the sparse card is the
//    one with room to spare. Measured in a browser: the value box went from a
//    fixed 15px to 93px on a long outfit once it wrapped.
// 2. The persona is not a character card, so it appeared in none of the avatar
//    lookups. A tracker prompt that lists the user as a present character got
//    the initial placeholder instead of the persona portrait.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readClient = (path: string) =>
  readFileSync(new URL(`../../packages/client/src/${path}`, import.meta.url), "utf8");

const rowLayout = readClient("features/tracker-panel/lib/tracker-row-layout.ts");
const compactField = readClient("features/tracker-panel/components/character-card/CharacterTrackerField.tsx");
const featuredFields = readClient("features/tracker-panel/components/character-card/FeaturedCharacterFields.tsx");
const generateRoutes = readFileSync(
  new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url),
  "utf8",
);

// ── One clamp, three tiers, keyed on the card's own container ──
// Compact cards sit two to a row, so the card is about half the panel width.
const clamp = /TRACKER_DETAIL_VALUE_CLAMP_CLASS =\s*"([^"]+)"/u.exec(rowLayout)?.[1] ?? "";
assert.match(clamp, /^line-clamp-\d+ @min-\[176px\]:line-clamp-\d+ @min-\[260px\]:line-clamp-\d+$/u, clamp);
const tiers = [...clamp.matchAll(/line-clamp-(\d+)/gu)].map((m) => Number(m[1]));
assert.equal(tiers.length, 3, "three width tiers");
assert.ok(
  tiers[0]! < tiers[1]! && tiers[1]! < tiers[2]!,
  `the budget must grow with the card, got ${tiers.join(" -> ")}`,
);
assert.ok(tiers[0]! >= 3, "even the narrowest tier must clear a one-line truncate");

// ── Both card layouts use it, and neither truncates a detail value ──
for (const [name, source] of [
  ["compact", compactField],
  ["featured", featuredFields],
] as const) {
  assert.equal(source.includes("TRACKER_DETAIL_VALUE_CLAMP_CLASS"), true, `${name} detail fields use the shared clamp`);
  assert.equal(source.includes('previewLineCount="full"'), true, `${name} lets the clamp class own the budget`);
  assert.equal(source.includes('"truncate"'), false, `${name} detail values must not truncate to one line`);
}

// A fixed height clips a wrapped value no matter what the clamp says.
assert.equal(compactField.includes("h-3.5 @min-[176px]:h-4"), false, "fixed row heights would clip the wrap");
assert.equal(compactField.includes("min-h-3.5"), true, "the row grows from a minimum instead");

// The wrap must not depend on the card also having stats or custom fields.
assert.equal(compactField.includes("readable"), false, "wrapping is unconditional now");

// Featured fields no longer size their budget from the panel-width preset.
assert.equal(
  featuredFields.includes("FEATURED_FIELD_PREVIEW_LINES_BY_PROFILE"),
  false,
  "the line budget follows the card, not the panel width preset",
);

// ── Persona avatar sits between the chat card and the fuzzy library match ──
const personaMatch = generateRoutes.indexOf("isPersonaCharacter && personaAvatarPath");
const cardMatch = generateRoutes.indexOf("if (matched?.avatarPath) {");
const fuzzyMatch = generateRoutes.indexOf("findCharAvatarFuzzy(name, libraryAvatarByName)");
assert.ok(personaMatch > 0, "the persona is a tracker avatar source");
assert.ok(cardMatch > 0 && fuzzyMatch > 0, "the existing avatar chain is intact");
assert.ok(
  cardMatch < personaMatch && personaMatch < fuzzyMatch,
  "a chat character card stays more specific than the persona, which beats the fuzzy library match",
);
assert.equal(
  generateRoutes.includes("personaAvatarName = persona?.name ? normalizeTextForMatch(persona.name)"),
  true,
  "the persona is matched by normalized name, as the tracker emits names",
);

console.log("tracker-field-flex regression passed.");
