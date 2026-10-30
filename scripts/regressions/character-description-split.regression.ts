// ─────────────────────────────────────────────────────────────
// Character description split regression
// ─────────────────────────────────────────────────────────────
// Guards the shared pattern splitter behind "Split description into fields":
//  - labelled sections, W++ one-liners and interview blocks land in their fields
//  - every character of the description survives (lossless), apart from separators and repeated headers
//  - narrator / multi-character cards are skipped unless forced, empty descriptions are skipped
//  - existing field text is appended to, not duplicated, and applyDescriptionSplit writes the extension fields
import assert from "node:assert/strict";
import {
  applyDescriptionSplit,
  DESCRIPTION_SPLIT_FIELDS,
  splitCharacterDescription,
} from "../../packages/shared/src/utils/character-description-split.js";

// Compares text regardless of spacing and of the <START> marker the splitter adds in front of examples.
const squash = (s: string) =>
  s
    .toLowerCase()
    .replace(/<start>/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
const joined = (fields: Record<string, string>) => DESCRIPTION_SPLIT_FIELDS.map((f) => fields[f] ?? "").join("\n");

// 1. Labelled sections with markdown headers and "Label: value" lines.
const labelled = splitCharacterDescription({
  name: "Arya Vale",
  description: [
    "Arya Vale is a 24 year old courier who runs packages across the lower city.",
    "",
    "## Appearance",
    "Height: 168 cm",
    "Hair: short black hair with a silver streak",
    "She wears a patched grey jacket and running shoes.",
    "",
    "## Personality",
    "Stubborn, quick to laugh, hates being told to slow down.",
    "Likes: rooftops, cheap noodles",
    "",
    "Backstory: Arya grew up in the docks and ran away from home at fifteen after her father died.",
    "",
    "---",
    "Scenario: {{user}} has just hired Arya to carry a sealed letter across the city.",
  ].join("\n"),
  personality: "",
  scenario: "",
  system_prompt: "",
  mes_example: "",
  extensions: {},
});
assert.equal(labelled.status, "changed");
assert.deepEqual(labelled.changed, ["description", "personality", "appearance", "backstory", "scenario"]);
assert.match(labelled.after.description, /^Arya Vale is a 24 year old courier/);
assert.ok(!labelled.after.description.includes("Hair:"), "appearance lines left the description");
assert.match(labelled.after.appearance, /Height: 168 cm\nHair: short black hair[\s\S]*running shoes\./);
assert.ok(!labelled.after.appearance.includes("## Appearance"), "a header that only names its field is dropped");
assert.match(labelled.after.personality, /^Stubborn, quick to laugh[\s\S]*Likes: rooftops, cheap noodles$/);
assert.match(labelled.after.backstory, /^Backstory: Arya grew up in the docks/);
assert.match(labelled.after.scenario, /^Scenario: \{\{user\}\} has just hired Arya/);
// Lossless apart from the separator and the two canonical headers: every other line is in some field.
const labelledAfter = squash(joined(labelled.after));
const labelledKept = labelled.before.description
  .split("\n")
  .filter((line) => line.trim() && !["## Appearance", "## Personality", "---"].includes(line.trim()));
for (const line of labelledKept) assert.ok(labelledAfter.includes(squash(line)), `kept: ${line}`);
assert.equal(
  labelledAfter.length,
  labelledKept.reduce((sum, line) => sum + squash(line).length, 0),
);

// 2. A one-line W++ card splits per entry.
const wpp = splitCharacterDescription({
  name: "Adriana Hayes",
  description:
    "[Adriana Hayes: age (21 years), sex (Female), personality (kind, shy, bookish, loyal), appearance (long auburn hair, green eyes, 165 cm), background (raised by her grandmother in a coastal town), likes (rain, old novels)]",
});
assert.equal(wpp.status, "changed");
assert.match(wpp.after.description, /age \(21 years\)/);
assert.match(wpp.after.description, /sex \(Female\)/);
assert.match(wpp.after.personality, /personality \(kind, shy, bookish, loyal\)/);
assert.match(wpp.after.personality, /likes \(rain, old novels\)/);
assert.match(wpp.after.appearance, /appearance \(long auburn hair, green eyes, 165 cm\)/);
assert.match(wpp.after.backstory, /background \(raised by her grandmother in a coastal town\)/);
assert.equal(squash(joined(wpp.after)).length, squash(wpp.before.description).length, "W++ split is lossless");

// 2b. A one-line PList card ("[ {{char}}: traits; {{char}}'s body: ...; ]") splits per section.
const plist = splitCharacterDescription({
  name: "Monika",
  description:
    "[ {{char}}: intelligent, confident, introverted, lonely, romantic, likes(literature, piano, {{user}}), dislikes(being trapped, indifference), hobbies(reading, writing); Monika's body: 18 years old, slim build, emerald green eyes, long brown hair (high ponytail with white bow); ]",
});
assert.equal(plist.status, "changed");
assert.match(plist.after.personality, /^\[ \{\{char\}\}: intelligent, confident[\s\S]*hobbies\(reading, writing\);$/);
assert.match(plist.after.appearance, /^Monika's body: 18 years old[\s\S]*white bow\);$/);
assert.equal(plist.after.description, "");
assert.equal(squash(joined(plist.after)).length, squash(plist.before.description).length, "PList split is lossless");

// 3. Interview-style dialogue and <START> blocks become example messages.
const interview = splitCharacterDescription({
  name: "Mei",
  description: [
    "Mei is a shrine maiden who sells charms at the mountain gate.",
    "",
    'Interviewer: "How would you describe yourself?"',
    '{{char}}: "Oh, just a humble keeper of the gate. Nothing special, really."',
    'Interviewer: "And what do you do when nobody is around?"',
    '{{char}}: *She glances at the trees.* "I talk to the foxes. Don\'t tell anyone."',
    "",
    "<START>",
    "{{user}}: Good morning, Mei.",
    '{{char}}: "Early riser! The charms are fresh today."',
  ].join("\n"),
  mes_example: "",
});
assert.equal(interview.status, "changed");
assert.deepEqual(interview.changed, ["description", "mes_example"]);
assert.equal(interview.after.description, "Mei is a shrine maiden who sells charms at the mountain gate.");
assert.ok(interview.after.mes_example.startsWith("<START>\nInterviewer:"), "examples open with <START>");
assert.match(interview.after.mes_example, /<START>\n\{\{user\}\}: Good morning, Mei\.\n\{\{char\}\}: "Early riser!/);
assert.equal(squash(joined(interview.after)), squash(interview.before.description));

// 4. Narrator and multi-character cards are left alone unless forced; empty descriptions always are.
const narrator = splitCharacterDescription({
  name: "Dungeon Master",
  description: "Personality: fair but ruthless.\nAppearance: a hooded figure.",
});
assert.equal(narrator.status, "skipped");
assert.match(narrator.reason ?? "", /narrator/);
assert.deepEqual(narrator.after, narrator.before);
const forced = splitCharacterDescription(
  { name: "Dungeon Master", description: "Personality: fair but ruthless.\nAppearance: a hooded figure." },
  { force: true },
);
assert.equal(forced.status, "changed");
assert.equal(forced.after.personality, "Personality: fair but ruthless.");
assert.equal(forced.after.appearance, "Appearance: a hooded figure.");
const twoNames = splitCharacterDescription({
  name: "Twins",
  description: "Name: Riley\nPersonality: loud\n\nName: Misato\nPersonality: quiet",
});
assert.equal(twoNames.status, "skipped");
assert.match(twoNames.reason ?? "", /several characters \(riley, misato\)/);
assert.equal(splitCharacterDescription({ name: "Nobody", description: "   " }).status, "skipped");

// 5. Plain prose with nothing labelled is reported as unchanged, not rewritten.
const prose = splitCharacterDescription({
  name: "Mia",
  description: "Mia is a quiet librarian who spends her evenings reading by the window of her small flat.",
});
assert.equal(prose.status, "unchanged");
assert.deepEqual(prose.after, prose.before);
assert.equal(prose.keywordSorted, false);
assert.equal(labelled.keywordSorted, false, "a labelled card is not flagged");

// 5b. An unlabelled paragraph sorted by its wording alone is flagged, so the UI can warn that it may be misfiled.
const sorted = splitCharacterDescription({
  name: "Mia",
  description: [
    "Mia is a quiet librarian who spends her evenings reading by the window of her small flat.",
    "",
    "She has long auburn hair tied in a loose braid, pale green eyes and a slim build. She usually wears a cardigan over a plain dress and round glasses.",
  ].join("\n"),
});
assert.equal(sorted.status, "changed");
assert.deepEqual(sorted.changed, ["description", "appearance"]);
assert.equal(sorted.keywordSorted, true, "keyword-sorted prose is flagged");

// 6. Existing field text is kept: moved text is appended, and text already present is not added twice.
const existing = splitCharacterDescription({
  name: "Nora",
  description: "Nora is a pilot.\n\nPersonality: brave and reckless.\nAppearance: tall, with a shaved head.",
  personality: "Calm under pressure.",
  extensions: { appearance: "Appearance: tall, with a shaved head." },
});
assert.equal(existing.status, "changed");
assert.equal(existing.after.personality, "Calm under pressure.\n\nPersonality: brave and reckless.");
assert.equal(existing.after.appearance, "Appearance: tall, with a shaved head.");
assert.equal(existing.after.description, "Nora is a pilot.");

// 7. applyDescriptionSplit writes the top-level fields and the appearance/backstory extensions.
const applied = applyDescriptionSplit(
  { name: "Nora", description: "x", extensions: { talkativeness: 0.5, appearance: "", backstory: "" } },
  existing.after,
);
assert.equal(applied.description, "Nora is a pilot.");
assert.equal(applied.personality, existing.after.personality);
assert.equal(applied.extensions?.appearance, existing.after.appearance);
assert.equal(applied.extensions?.talkativeness, 0.5, "other extensions are kept");

process.stdout.write("Character description split regression passed.\n");
