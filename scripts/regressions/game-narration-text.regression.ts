import assert from "node:assert/strict";
import {
  buildGameTranslationSource,
  stripBalancedTag,
  stripGmTagsKeepReadables,
  stripMapUpdateTag,
  stripUnknownBracketTags,
} from "../../packages/shared/src/utils/game-narration-text.js";

assert.equal(
  stripGmTagsKeepReadables("Before [combat_result]\nprivate recap\n[/combat_result] after"),
  "Before  after",
);
assert.equal(
  stripGmTagsKeepReadables("A [COMBAT_RESULT]one[/COMBAT_RESULT] B [combat_result]two[/combat_result] C"),
  "A  B  C",
);
assert.equal(
  stripGmTagsKeepReadables('Read [note: "Keep me"] and [Book: "Chapter one"] [state: {"hp":2}]'),
  'Read [note: "Keep me"] and [Book: "Chapter one"]',
);
assert.equal(stripUnknownBracketTags('A [unknown: {"quoted": "]", "nested": [1,2]}] B'), "A  B");
assert.equal(stripBalancedTag('A [choices: ["one", "two"]] B [choices: []] C', "[choices:"), "A  B  C");
assert.equal(stripBalancedTag("A [choices: broken [choices: []] B", "[choices:"), "A [choices: broken  B");
assert.equal(stripMapUpdateTag("Before [map_update: broken\nAfter"), "Before After");
assert.equal(stripGmTagsKeepReadables("A [party-turn][party-chat][music: calm] B"), "A  B");

assert.equal(stripBalancedTag('A [choices: ["a ] b", "c"]] Z', "[choices:"), "A  Z");
assert.equal(stripBalancedTag('A [choices: ["a \\" ] b"]] Z', "[choices:"), "A  Z");

// Malformed model output used to rescan the remaining text for every opener.
// This input is small enough to be returned by a model, but quadratic scans stall it.
for (const tag of ["[combat_result]", "[map_update:", "[choices:", "[unknown:"]) {
  const input = tag.repeat(20_000);
  const started = performance.now();
  const result = stripGmTagsKeepReadables(input);
  assert.ok(performance.now() - started < 2_000, `${tag} must be stripped without quadratic rescanning`);
  assert.equal(result, tag === "[map_update:" ? "" : input);
}

// The server's automatic translation and the Game screen share this text (#7010):
// GM turns lose internal tags, and dialogue keeps only its speaker.
assert.equal(
  buildGameTranslationSource({
    id: "turn",
    role: "assistant",
    content: [
      "[music: calm] A lamp burns.",
      '[Alice] [main] [patient]: "Stay here."',
      '[Alice] [whisper:Bob] [calm]: "Keep quiet."',
      "[Alice] [thought] [worried]: I should go.",
      'Before the note. [Note: Remember the bridge.] After the note. [choices: ["Go", "Stay"]]',
    ].join("\n\n"),
  }),
  [
    "A lamp burns.",
    '[Alice]: "Stay here."',
    '[Alice]: "Keep quiet."',
    '[Alice]: "I should go."',
    "Before the note.",
    "[Note: Remember the bridge.]",
    "After the note.",
  ].join("\n\n"),
);
assert.equal(
  buildGameTranslationSource({ id: "player", role: "user", content: "[To the party] [Alice] [main]: Hi" }),
  "[Alice] [main]: Hi",
  "player messages are only stripped of their address prefix",
);

console.info(
  "Game narration stripping preserves readables, builds the shared translation source, and handles repeated unclosed tags in bounded time.",
);
