// Character cards collapse to a one-line header.
//
// A cast of eight fills the panel with cards you have to scroll past to reach
// the one you want. Collapsing reduces a card to avatar, emoji, name and mood,
// persisted per chat in metadata the same way featured cards already are.
//
// Display only: nothing here touches presentCharacters, so the collapsed state
// never reaches the prompt. That is the property most worth pinning, because
// the obvious "optimisation" later is to stop sending collapsed characters.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

function walkPanel(dir: string): Array<{ path: string; text: string }> {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walkPanel(path);
    return /\.tsx?$/u.test(path) ? [{ path, text: readFileSync(path, "utf8") }] : [];
  });
}

const readClient = (path: string) =>
  readFileSync(new URL(`../../packages/client/src/${path}`, import.meta.url), "utf8");

const constants = readClient("features/tracker-panel/lib/tracker-panel.constants.ts");
const keySetHook = readClient("features/tracker-panel/hooks/use-character-card-key-set.ts");
const featuredHook = readClient("features/tracker-panel/hooks/use-featured-character-cards.ts");
const panel = readClient("features/tracker-panel/components/sections/CharacterTrackerPanel.tsx");
const row = readClient("features/tracker-panel/components/character-card/CollapsedCharacterRow.tsx");
const sectionList = readClient("features/tracker-panel/components/TrackerSectionList.tsx");
const mutations = readClient("features/tracker-panel/hooks/use-tracker-mutations.ts");
const locales = JSON.parse(readClient("localization/locales/en.json")) as Record<string, string>;

// ── Persistence rides the same path as featured cards ──
assert.match(constants, /TRACKER_COLLAPSED_CHARACTER_META_KEY = "trackerCollapsedCharacterKeys"/u);
assert.notEqual(
  /TRACKER_COLLAPSED_CHARACTER_META_KEY = "([^"]+)"/u.exec(constants)?.[1],
  /TRACKER_FEATURED_CHARACTER_META_KEY = "([^"]+)"/u.exec(constants)?.[1],
  "the two sets must not share a metadata key",
);
// One implementation, parameterised by meta key: featured delegates to it.
assert.match(featuredHook, /useCharacterCardKeySet\(/u, "featured cards must reuse the shared key set");
assert.ok(!featuredHook.includes("useUpdateChatMetadata"), "featured cards must not keep a second implementation");
assert.match(keySetHook, /mutateChatMetadata\(\{ id: activeChatId, \[metaKey\]: Array\.from\(next\) \}\)/u);
for (const member of ["replace", "toggle", "remove"]) {
  assert.match(keySetHook, new RegExp(`\\b${member}\\b`, "u"), `key set must expose ${member}`);
}

// ── Display only ──
// The collapsed row reads the character; nothing writes presentCharacters, and
// no server file learns the metadata key.
assert.ok(!row.includes("presentCharacters"), "the collapsed row must not touch tracker data");
assert.ok(
  !readFileSync(new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url), "utf8").includes(
    "trackerCollapsedCharacterKeys",
  ),
  "collapse is a view state and must not reach prompt assembly",
);

// ── The three groups are disjoint, and collapsed wins ──
assert.match(panel, /const collapsedEntries = characterEntries\.filter\(\(entry\) => entry\.collapsed\)/u);
assert.match(panel, /const featuredEntries = characterEntries\.filter\(\(entry\) => !entry\.collapsed && entry\.featured\)/u);
assert.match(
  panel,
  /const compactEntries = characterEntries\.filter\(\(entry\) => !entry\.collapsed && !entry\.featured\)/u,
  "a collapsed card must not also render as a compact card",
);
// The per-character callback must not shadow the section's own collapse toggle.
assert.match(panel, /onToggleCharacterCollapsed: \(key: string\) => void;/u);
assert.match(panel, /onToggleCollapsed\?: \(\) => void;/u, "the section-level toggle must survive");
assert.match(panel, /onToggle=\{onToggleCollapsed\}/u, "SectionHeader still drives the whole-section collapse");

// ── Collapse-all keys off live characters, not the stored set ──
assert.match(
  sectionList,
  /presentCharacters\.map\(\(character, index\) => getCharacterFeatureKey\(character, index\)\)/u,
  "collapse-all must enumerate live characters so stale keys cannot strand it",
);
assert.match(sectionList, /characterCardKeys\.length > 0 && characterCardKeys\.every\(/u);

// ── Removing a character drops its collapsed key ──
assert.match(mutations, /removeCollapsedCharacterCard\(removedKey\)/u);
assert.match(mutations, /removeFeaturedCharacterCard\(removedKey\)/u);

// ── Localised, per the client rule for user-facing copy ──
for (const key of [
  "ui.trackerPanel.charactertrackercard.collapseCharacterCard",
  "ui.trackerPanel.charactertrackerpanel.collapseAllCharacters",
  "ui.trackerPanel.charactertrackerpanel.expandAllCharacters",
  "ui.trackerPanel.charactertrackerpanel.expandValue1",
]) {
  assert.ok(locales[key], `missing English string for ${key}`);
}
assert.ok(!/title="[A-Z]/u.test(row), "the collapsed row must not hardcode user-facing copy");

// ── Avatars are framed the panel's way, not the card library's ──
// The row first rendered getAvatarCropStyle(character.avatarCrop). Two faults:
// avatarCrop arrives from storage as a JSON string, so isLegacyAvatarCrop's
// `"zoom" in c` threw and took the panel down; and no other tracker avatar
// honours avatarCrop at all, so the same character framed one way collapsed
// and another way expanded. The panel uses portraitFocus/portraitZoom.
const panelDir = fileURLToPath(new URL("../../packages/client/src/features/tracker-panel/", import.meta.url));
const panelSources = walkPanel(panelDir);
assert.ok(panelSources.length > 20, `expected the panel's sources, found ${panelSources.length}`);
for (const { path, text } of panelSources) {
  assert.ok(
    !text.includes("getAvatarCropStyle"),
    `${path.slice(panelDir.length)} frames an avatar with avatarCrop; the panel uses portraitFocus`,
  );
}
// Anything that does read avatarCrop must go through the parser, never a cast:
// the value is `unknown` because it can still be raw JSON text.
for (const { path, text } of panelSources) {
  if (!text.includes("avatarCrop")) continue;
  assert.ok(
    !/avatarCrop as \w/u.test(text),
    `${path.slice(panelDir.length)} casts avatarCrop instead of calling normalizeAvatarCrop`,
  );
}

// ── The row stays a single toggle plus an optional delete ──
// Nesting the name editor or avatar upload inside the toggle would put a button
// inside a button; both remain available on the expanded card.
assert.equal((row.match(/<button/gu) ?? []).length, 2, "expand and delete, nothing else");
assert.match(row, /aria-expanded=\{false\}/u);

console.log("tracker-character-collapse regression passed.");
