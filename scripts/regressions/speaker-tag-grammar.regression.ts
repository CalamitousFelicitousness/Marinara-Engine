// Speaker tags have one grammar, and it is well-formed markup.
//
// Group chat colouring originally asked models for `<speaker="Amy">`, which is
// not valid markup: an attribute needs a name. Models emit `<speaker name="Amy">`
// whatever the prompt says, so the colour lookup missed and fell through to the
// default, silently. The first fix rewrote the model's output into the malformed
// spelling, which kept the bad format canonical and bought a repair step to
// maintain forever.
//
// Readers now accept both spellings and writers emit the well-formed one, so the
// tolerance covers stored history rather than model behaviour, and nothing
// rewrites a model's output on the way in.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  formatSpeakerTag,
  hasSpeakerTag,
  parseSpeakerTags,
  replaceSpeakerSpans,
  speakerNameFromMatch,
  speakerOpenTagRegex,
  speakerTaggedSpanRegex,
  stripSpeakerTags,
  SPEAKER_CLOSE_TAG,
} from "../../packages/shared/dist/index.js";

const LEGACY = '<speaker="Amy">"Hello."</speaker>';
const MODERN = '<speaker name="Amy">"Hello."</speaker>';

// ── Both spellings are one tag ──
for (const [label, text] of [
  ["legacy", LEGACY],
  ["well-formed", MODERN],
  ["single quotes", "<speaker name='Amy'>\"Hello.\"</speaker>"],
  ["loose whitespace", '<speaker   name = "Amy" >"Hello."</speaker>'],
  ["loose close", '<speaker name="Amy">"Hello."</ speaker >'],
] as const) {
  assert.equal(hasSpeakerTag(text), true, `${label}: detected`);
  const match = speakerTaggedSpanRegex().exec(text);
  assert.ok(match, `${label}: matched as a span`);
  assert.equal(speakerNameFromMatch(match), "Amy", `${label}: name resolved`);
  assert.equal(stripSpeakerTags(text), '"Hello."', `${label}: stripped to its dialogue`);
}

// Things that merely look like the tag are not it.
for (const notATag of ["no tags here", "</speaker>", '<speakerphone name="Amy">', '<character name="Amy">'])
  assert.equal(hasSpeakerTag(notATag), false, `must not match: ${notATag}`);

// ── Writers emit the well-formed spelling, and readers read it back ──
assert.equal(formatSpeakerTag("Amy"), '<speaker name="Amy">');
assert.equal(SPEAKER_CLOSE_TAG, "</speaker>");
// A name carrying a double quote was previously unrepresentable: the tag
// truncated at it. Single-quoting keeps it whole, and readers accept both.
const awkward = 'Amy "The Blade"';
const roundTripped = `${formatSpeakerTag(awkward)}"Hi."${SPEAKER_CLOSE_TAG}`;
assert.equal(speakerNameFromMatch(speakerTaggedSpanRegex().exec(roundTripped)!), awkward, "awkward name round-trips");

// ── The regex factories hand out fresh objects ──
// A shared instance with the `g` flag carries lastIndex between callers, so one
// consumer's partial scan moves where the next one starts.
const first = speakerOpenTagRegex();
first.exec(`${LEGACY} ${MODERN}`);
assert.ok(first.lastIndex > 0, "the first scan advanced");
assert.equal(speakerOpenTagRegex().lastIndex, 0, "a second call must not inherit lastIndex");

// ── A span without a closer is not a span, which is the streaming case ──
const halfStreamed = '<speaker name="Amy">"Hel';
assert.equal(replaceSpeakerSpans(halfStreamed, () => "REPLACED"), halfStreamed, "an unclosed span is left alone");
assert.equal(
  replaceSpeakerSpans(`${MODERN} ${LEGACY}`, (name, body) => `[${name}|${body}]`),
  '[Amy|"Hello."] [Amy|"Hello."]',
  "both spellings reach the replacer",
);

// ── Segment parsing agrees across spellings ──
const known = new Set(["amy"]);
const legacySegments = parseSpeakerTags(`Beat. ${LEGACY} After.`, known);
const modernSegments = parseSpeakerTags(`Beat. ${MODERN} After.`, known);
assert.ok(legacySegments && modernSegments, "both spellings parse as tagged segments");
assert.deepEqual(
  legacySegments.map((segment) => [segment.speaker, segment.text]),
  modernSegments.map((segment) => [segment.speaker, segment.text]),
  "same speakers and text either way",
);
for (const [label, segments, source] of [
  ["legacy", legacySegments, `Beat. ${LEGACY} After.`],
  ["well-formed", modernSegments, `Beat. ${MODERN} After.`],
] as const) {
  const tagged = segments.find((segment) => segment.speaker === "Amy");
  assert.ok(tagged, `${label}: the tagged segment resolved its known speaker`);
  // Offsets are used to attribute reactions to an exact part, so they must bound
  // the real span in the source rather than merely being ordered.
  assert.equal(source.slice(tagged.start, tagged.end).startsWith("<speaker"), true, `${label}: span starts at the tag`);
  assert.equal(source.slice(tagged.start, tagged.end).endsWith("</speaker>"), true, `${label}: span ends at the closer`);
}
assert.equal(parseSpeakerTags("No tags at all.", known), null, "untagged content falls through");

// ── No consumer keeps a private copy of the grammar ──
// Twelve of them did, which is how one spelling came to be handled in some
// places and not others. Anything matching a speaker tag goes through the module.
const GRAMMAR_MODULE = "packages/shared/src/utils/speaker-tags.ts";
const PRIVATE_GRAMMAR_RE = /[/'"`]<\s*\\?\/?\s*speaker[\s=>]/u;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/u.test(path) ? [path] : [];
  });
}

const offenders: string[] = [];
for (const root of ["packages/client/src", "packages/server/src", "packages/shared/src"]) {
  for (const path of walk(join(repoRoot, root))) {
    const relative = path.slice(repoRoot.length).replaceAll("\\", "/");
    if (relative === GRAMMAR_MODULE) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      // Prose may name the tag; code may not define it.
      const code = line.trim();
      if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) continue;
      if (PRIVATE_GRAMMAR_RE.test(line)) offenders.push(`${relative}: ${code}`);
    }
  }
}
assert.deepEqual(offenders, [], `speaker tag grammar duplicated outside ${GRAMMAR_MODULE}:\n${offenders.join("\n")}`);
// Guard the guard: the detector must recognise the shapes it forbids.
for (const shape of ['/<speaker="([^"]*)">/g', 'text.includes("<speaker=")', "`</speaker>`", '"<speaker name="'])
  assert.match(shape, PRIVATE_GRAMMAR_RE, `detector missed ${shape}`);

// ── The prompt asks for what the writer emits ──
const generateRoutes = readFileSync(join(repoRoot, "packages/server/src/routes/generate.routes.ts"), "utf8");
const chatsRoutes = readFileSync(join(repoRoot, "packages/server/src/routes/chats.routes.ts"), "utf8");
for (const [label, source] of [
  ["live generation", generateRoutes],
  ["prompt preview", chatsRoutes],
] as const) {
  assert.match(
    source,
    /wrap each character's dialogue in \$\{formatSpeakerTag\("name"\)\}/u,
    `${label} must describe the tag with the writer, not a literal`,
  );
}
// Nothing rewrites the model's output on the way in any more.
assert.ok(!generateRoutes.includes("normalizeSpeakerTags"), "inbound rewriting is gone");

console.log("speaker-tag-grammar regression passed.");
