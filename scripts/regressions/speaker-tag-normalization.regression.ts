// Group chat colouring survives the tag spelling models actually produce.
//
// The prompt asks for `<speaker="Amy">`, which is not well-formed markup: an
// attribute needs a name. Models trained on XML and HTML emit
// `<speaker name="Amy">` instead, and keep emitting it however the instruction
// is worded, so the colour lookup silently fell through to the default.
//
// Eleven parsers hardcode the canonical spelling. The fix repairs the model's
// output once at each boundary rather than teaching each parser a second
// syntax, so the property to pin is that the repaired text is matched by the
// very regex the chat renderer uses.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeSpeakerTags } from "../../packages/shared/dist/index.js";

const readClient = (path: string) =>
  readFileSync(new URL(`../../packages/client/src/${path}`, import.meta.url), "utf8");
const readServer = (path: string) =>
  readFileSync(new URL(`../../packages/server/src/${path}`, import.meta.url), "utf8");

// ── The contract: normalized output is what the renderer actually parses ──
// Lifted from the renderer rather than restated, so the two cannot drift apart.
const chatMessage = readClient("components/chat/ChatMessage.tsx");
const rendererPattern = /const SPEAKER_TAG_RE = \/(.+)\/g;/u.exec(chatMessage)?.[1];
assert.ok(rendererPattern, "could not read SPEAKER_TAG_RE from the chat renderer");
const parseSpeakers = (text: string) =>
  [...text.matchAll(new RegExp(rendererPattern, "g"))].map((match) => ({ name: match[1], body: match[2] }));

const cases: Array<{ label: string; input: string; speakers: Array<{ name: string; body: string }> }> = [
  {
    label: "the attribute form models produce",
    input: '<speaker name="Amy">"Hello there,"</speaker> she said.',
    speakers: [{ name: "Amy", body: '"Hello there,"' }],
  },
  {
    label: "single quotes",
    input: "<speaker name='Marta'>\"Fine.\"</speaker>",
    speakers: [{ name: "Marta", body: '"Fine."' }],
  },
  {
    label: "whitespace around the equals and before the close",
    input: '<speaker   name = "Ty" >"Mm."</speaker>',
    speakers: [{ name: "Ty", body: '"Mm."' }],
  },
  {
    label: "already canonical, untouched",
    input: '<speaker="Amy">"Hello."</speaker>',
    speakers: [{ name: "Amy", body: '"Hello."' }],
  },
  {
    label: "several tags, mixed spellings, interleaved narration",
    input: '<speaker name="Amy">"One."</speaker> Beat. <speaker="Marta">"Two."</speaker>',
    speakers: [
      { name: "Amy", body: '"One."' },
      { name: "Marta", body: '"Two."' },
    ],
  },
  {
    label: "a name with a diacritic",
    input: '<speaker name="Zofia Wróbel">"Tak."</speaker>',
    speakers: [{ name: "Zofia Wróbel", body: '"Tak."' }],
  },
];

for (const { label, input, speakers } of cases) {
  const normalized = normalizeSpeakerTags(input);
  assert.deepEqual(parseSpeakers(normalized), speakers, `${label}: renderer must parse the normalized text`);
}

// ── What it must not touch ──
for (const untouched of [
  "no tags here at all",
  "</speaker>",
  '<speakerphone name="Amy">',
  '<character name="Amy">"Hi."</character>',
  // The canonical form matches [^"]*, so a quoted name cannot be represented in
  // it. Rewriting would emit a tag that truncates at the quote; leaving it alone
  // keeps the text visible and uncoloured instead of mangled.
  '<speaker name="Amy "The Blade"">"Hi."</speaker>',
]) {
  assert.equal(normalizeSpeakerTags(untouched), untouched, `must leave alone: ${untouched}`);
}

// Guard the guard: the renderer's own regex must reject the attribute form, or
// every case above would pass without the normalizer doing anything.
assert.deepEqual(
  parseSpeakers('<speaker name="Amy">"Hello."</speaker>'),
  [],
  "the renderer must not already understand the attribute form",
);

// ── Both boundaries call it ──
// Server: before the individual-mode unwrap, which reads a canonical tag, and
// before the response is persisted.
const generateRoutes = readServer("routes/generate.routes.ts");
assert.match(generateRoutes, /fullResponse = normalizeSpeakerTags\(fullResponse\);/u, "the server repairs the response");
const normalizeAt = generateRoutes.indexOf("fullResponse = normalizeSpeakerTags(fullResponse);");
const unwrapAt = generateRoutes.indexOf('const speakerWrap = new RegExp(`^\\\\s*<speaker="');
assert.ok(unwrapAt > 0, "could not find the individual-mode speaker unwrap");
assert.ok(normalizeAt < unwrapAt, "normalization must run before the unwrap that expects a canonical tag");

// Client: covers the streaming window and messages stored before this shipped.
assert.match(chatMessage, /const text = normalizeSpeakerTags\(rawText\);/u, "the renderer repairs before parsing");

console.log("speaker-tag-normalization regression passed.");
