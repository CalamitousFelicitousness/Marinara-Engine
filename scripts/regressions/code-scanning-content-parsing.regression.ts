import assert from "node:assert/strict";
import { normalizeCardAssetImageSyntax } from "../../packages/client/src/lib/card-asset-links.js";
import {
  decodeAstroPropsAttribute,
  extractJannyAstroCharacterProps,
} from "../../packages/server/src/routes/bot-browser-janny.routes.js";
import { parseLorebookWriteApprovalText } from "../../packages/server/src/routes/generate/agent-write-approval.js";
import { dedupeLastMessageWrappers } from "../../packages/server/src/routes/generate/generate-route-utils.js";
import { buildImpersonateInstruction } from "../../packages/server/src/services/conversation/impersonate-prompt.js";
import { stripGmCommandTags } from "../../packages/server/src/services/game/segment-edits.js";
import { parseTrustedTimestamp } from "../../packages/server/src/services/import/import-timestamps.js";
import { extractSetvarAssignments } from "../../packages/server/src/services/import/st-prompt.importer.js";
import { stripGenerationGuideInstruction } from "../../packages/shared/src/utils/generation-guide.js";
import { stripMacroComments } from "../../packages/shared/src/utils/macro-engine.js";
import { sanitizeFolderSegment } from "../../packages/shared/src/features/folder-packages/manifest-package.js";
import {
  decodeEncodedSpeakerTags,
  groupConsecutiveSegments,
  parseSpeakerTags,
} from "../../packages/shared/src/utils/speaker-segments.js";

assert.deepEqual(extractSetvarAssignments("{{setvar::mode::gm}} {{SETVAR::tone::warm}}"), [
  ["mode", "gm"],
  ["tone", "warm"],
]);
assert.deepEqual(extractSetvarAssignments("İ {{SETVAR::mode::gm}}"), [["mode", "gm"]]);
assert.equal(extractSetvarAssignments("{{setvar::0::".repeat(20_000) + "value}}").length, 1);
assert.deepEqual(extractSetvarAssignments("{{setvar::broken::{{setvar::mode::gm}}"), [["mode", "gm"]]);

assert.ok(parseTrustedTimestamp(`2024-01-02${" ".repeat(50_000)}@ 03h 04m 05s`));

assert.equal(
  normalizeCardAssetImageSyntax("(portrait)[card://self/gallery/a.png]"),
  "![portrait](card://self/gallery/a.png)",
);
assert.equal(
  normalizeCardAssetImageSyntax("(portrait\rvariant)[card://self/gallery/a.png]"),
  "![portrait variant](card://self/gallery/a.png)",
);
assert.equal(normalizeCardAssetImageSyntax("(portrait)[card://]"), "(portrait)[card://]");

assert.equal(
  extractJannyAstroCharacterProps(
    `${"<astro-island data-x=\"x\"></astro-island>".repeat(20_000)}<astro-island props=\"wanted\" component-export=\"CharacterButtons\"></astro-island>`,
  ),
  "wanted",
);
assert.equal(extractJannyAstroCharacterProps('<astro-island props="character fallback"></astro-island>'), "character fallback");
assert.equal(
  extractJannyAstroCharacterProps(
    '<astro-island data-props="stale" props="wanted" component-export="CharacterButtons"></astro-island>',
  ),
  "wanted",
);
assert.equal(decodeAstroPropsAttribute("&quot;x&amp;y&quot;"), '"x&y"');
assert.equal(decodeAstroPropsAttribute("&amp;quot;"), "&quot;");
const nestedAlt = "(".repeat(50_000) + "portrait)[card://self/gallery/a.png]";
assert.equal(normalizeCardAssetImageSyntax(nestedAlt).endsWith("portrait](card://self/gallery/a.png)"), true);

const approval = parseLorebookWriteApprovalText(
  `<!-- marinara:lorebook-entry:v1 -->\n### ${" ".repeat(50_000)}Entry\nKeys: one, two\nTag: lore\n\nBody`,
);
assert.equal(approval[0]?.name, "Entry");
assert.deepEqual(approval[0]?.keys, ["one", "two"]);
assert.deepEqual(parseLorebookWriteApprovalText("### Heading only\nBody text"), [
  { action: "append", name: "Heading only", content: "Body text", keys: [], tag: "" },
]);
assert.deepEqual(parseLorebookWriteApprovalText("### Keys only\nKeys: one, two\n\nBody text"), [
  { action: "append", name: "Keys only", content: "Body text", keys: ["one", "two"], tag: "" },
]);
assert.deepEqual(
  parseLorebookWriteApprovalText("### First\nFirst body\n\n### Second\nKeys: two\n\nSecond body"),
  [
    { action: "append", name: "First", content: "First body", keys: [], tag: "" },
    { action: "append", name: "Second", content: "Second body", keys: ["two"], tag: "" },
  ],
);

const wrappedMessages = [
  { content: `${"\n".repeat(50_000)}  ## Last Message  \nOld` },
  { content: "## Last Message\nCurrent" },
];
dedupeLastMessageWrappers(wrappedMessages);
assert.equal(wrappedMessages[0]?.content, "Old");
assert.equal(wrappedMessages[1]?.content, "## Last Message\nCurrent");
const standaloneHeading = [{ content: "## Last Message" }, { content: "<last_message>Current</last_message>" }];
dedupeLastMessageWrappers(standaloneHeading);
assert.equal(standaloneHeading[0]?.content, "");
const inlineWrapperText = [
  { content: "History\n</chat_history>" },
  { content: "Ordinary prose mentions <last_message> and a later line\n## Last Message" },
  { content: "<last_message>Current</last_message>" },
];
dedupeLastMessageWrappers(inlineWrapperText);
assert.equal(inlineWrapperText[0]?.content, "History\n</chat_history>");
assert.equal(inlineWrapperText[1]?.content, "Ordinary prose mentions <last_message> and a later line\n## Last Message");
const boundaryWhitespaceNoise = [
  { content: `${"\n".repeat(50_000)}x` },
  { content: "<last_message>Old</last_message>" },
  { content: "<last_message>Current</last_message>" },
];
dedupeLastMessageWrappers(boundaryWhitespaceNoise);
assert.equal(boundaryWhitespaceNoise[0]?.content.endsWith("x"), true);

const legacyDirection = `[Impersonation instruction — write {{user}}'s next response, steering it toward the following:${" ".repeat(50_000)}Go north]`;
assert.equal(
  buildImpersonateInstruction({ customPrompt: "Direction:", direction: legacyDirection }),
  "Direction: Go north.",
);
const whitespaceLegacyDirection =
  "[Impersonation instruction — write {{user}}'s next response, steering it toward the following:   ]";
assert.equal(
  buildImpersonateInstruction({ customPrompt: "Direction:", direction: whitespaceLegacyDirection }),
  `Direction: ${whitespaceLegacyDirection}`,
);

assert.equal(stripGmCommandTags(`[skill_check:${" ".repeat(50_000)}]Visible`), "Visible");
assert.equal(stripGmCommandTags(`İ [SKILL_CHECK:${" ".repeat(50_000)}]Visible`), "İ Visible");
assert.equal(stripGmCommandTags("[[music: x]]"), "[]");
assert.equal(stripGmCommandTags("[choices: [A] | [B]]Visible"), "Visible");
assert.equal(stripGmCommandTags("[choices: [A]\n[music: x]Visible"), "Visible");
assert.equal(stripGmCommandTags('[map_update: {"a": 1}\nVisible'), "Visible");
assert.equal(stripGmCommandTags("[map_update:x"), "");
assert.equal(stripGmCommandTags("[map_update:"), "");
assert.equal(stripGmCommandTags("[party-turn]A[party-chat]B"), "AB");
assert.equal(stripGmCommandTags("[note: remember the key]\n[book: chapter text]"), "[note: remember the key]\n[book: chapter text]");
const malformedBracketNoise = "[".repeat(100_000) + ":]";
assert.equal(stripGmCommandTags(malformedBracketNoise), malformedBracketNoise);
assert.equal(
  stripGenerationGuideInstruction(
    `[Narrator instruction ${" ".repeat(50_000)} following:${" ".repeat(50_000)}Continue north]`,
  ),
  "Continue north",
);
assert.equal(
  stripGenerationGuideInstruction("[Narrator instruction — following: Choose [A] or [B]]"),
  "Choose [A] or [B]",
);
assert.equal(stripMacroComments("Before{{//".repeat(20_000) + "comment}}After"), "BeforeAfter");
assert.equal(stripMacroComments("Before{{// comment with } a lone brace }}After"), "BeforeAfter");
assert.equal(sanitizeFolderSegment("-".repeat(50_000) + "package" + "-".repeat(50_000), "fallback"), "package");
assert.equal(sanitizeFolderSegment(`${"a".repeat(79)} rest`, "fallback"), "a".repeat(79));
const scopedParsingStartedAt = performance.now();
extractSetvarAssignments("{{setvar::broken::".repeat(20_000) + "{{setvar::mode::gm}}");
stripMacroComments("Before{{//".repeat(20_000) + "comment with } a lone brace }}After");
sanitizeFolderSegment("-".repeat(50_000) + "package" + "-".repeat(50_000), "fallback");
assert.ok(performance.now() - scopedParsingStartedAt < 5_000, "adversarial parsing should complete within five seconds");
const encodedSpeakerNoise = "&lt;;".repeat(20_000);
assert.equal(decodeEncodedSpeakerTags(encodedSpeakerNoise), encodedSpeakerNoise);
assert.equal(decodeEncodedSpeakerTags("&lt;speaker=&quot;Luna&quot;&gt;"), '<speaker="Luna">');
assert.equal(decodeEncodedSpeakerTags("İ &LT;speaker=&quot;Luna&quot;&GT;"), 'İ <speaker="Luna">');
assert.equal(decodeEncodedSpeakerTags("&#X3C;speaker=&quot;Luna&quot;&#X3E;"), '<speaker="Luna">');
assert.deepEqual(parseSpeakerTags('Before <speaker="Luna">Hello</speaker> After', new Set(["luna"])), [
  { speaker: null, text: "Before", start: 0, end: 7 },
  { speaker: "Luna", text: "Hello", start: 7, end: 38 },
  { speaker: null, text: "After", start: 38, end: 44 },
]);
assert.equal(parseSpeakerTags('<speaker="a">'.repeat(50_000), new Set(["a"])), null);
assert.equal(
  groupConsecutiveSegments([
    { speaker: "Luna", text: "\n".repeat(50_000) + "Hello" + "\n".repeat(50_000), start: 0, end: 100_005 },
  ])[0]?.lines[0],
  "Hello",
);

process.stdout.write("Code-scanning content parsing regression passed.\n");
