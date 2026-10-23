/** Capability API 1.377: a ruleset's own words on its sheet, menu and cards. A combat modifier's
 *  `label` said in place of the composed phrase, a pool's `unit` and `units`, a list's `display`, a
 *  text field hidden by a derived value, a condition left out of the picker, a track shown once
 *  moved, an item toggle's labels, an item use's title, creature traits to 1200 letters, and the
 *  gate that asks for 1.377. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultRulesetSheetBuild,
  isRulesetTextHidden,
  parseRulesetDefinition,
  rulesetItemEffectFacts,
  rulesetItemEffectText,
  supportedCapabilityApi,
  type RulesetDefinition,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-sheet-words-"));
const previous = { DATA_DIR: process.env.DATA_DIR, MARINARA_DATA_DIR: process.env.MARINARA_DATA_DIR };
process.env.DATA_DIR = dataDir;
process.env.MARINARA_DATA_DIR = dataDir;
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");

const baseText = readFileSync(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url), "utf8");
const fixture = (edit: (doc: Record<string, any>) => void = () => {}) => {
  const doc = JSON.parse(baseText) as Record<string, any>;
  edit(doc);
  return doc;
};
const parse = (doc: unknown): RulesetDefinition => {
  const result = parseRulesetDefinition(doc);
  assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
  return result.definition;
};
const issuesOf = (doc: unknown) => {
  const result = parseRulesetDefinition(doc);
  return result.ok ? "" : result.issues.join("; ");
};
const list = (doc: Record<string, any>, id: string) => doc.sheet.lists.find((one: { id: string }) => one.id === id);

try {
  assert.ok(supportedCapabilityApi.minor >= 377);

  const words = fixture((doc) => {
    doc.sheet.live.pools[1].unit = "hit die";
    doc.sheet.live.pools[1].units = "hit dice";
    list(doc, "spells").display = {
      tab: "Spells",
      by: { column: "level", labels: ["Cantrips", "1st level", "2nd level"] },
      mark: "prepared",
    };
    doc.sheet.live.text[0].hideWhen = { derived: "spell_save_dc", equals: 0 };
    doc.sheet.live.conditions[1].pickable = false;
    doc.sheet.live.tracks[2].showWhenSet = true;
    doc.combat.conditions[13].modifiers[0].label = "advantage on saves against being charmed";
    doc.catalogs[0].entries[0].creature.traits = [{ name: "Weaknesses", text: "w".repeat(1100) }];
  });
  const definition = parse(words);
  assert.equal(definition.sheet.live.pools[1]!.units, "hit dice");
  assert.equal(definition.sheet.lists.find((one) => one.id === "spells")!.display?.by?.labels[0], "Cantrips");
  assert.equal(definition.sheet.live.conditions[1]!.pickable, false);
  assert.equal(definition.sheet.live.tracks[2]!.showWhenSet, true);

  // A modifier's own label is the whole phrase a card says.
  const modifier = definition.combat!.conditions![13]!.modifiers![0]!;
  const facts = rulesetItemEffectFacts(definition, { modifiers: [modifier] });
  assert.equal(facts.length, 1);
  assert.equal(rulesetItemEffectText(facts[0]!), "advantage on saves against being charmed");

  // A text field hidden by a derived value.
  const build = defaultRulesetSheetBuild(definition);
  const text = definition.sheet.live.text[0]!;
  assert.equal(isRulesetTextHidden(text, build, definition, { spell_save_dc: 0 }), true);
  assert.equal(isRulesetTextHidden(text, build, definition, { spell_save_dc: 13 }), false);
  assert.equal(isRulesetTextHidden({}, build, definition, {}), false);

  // What the schema refuses.
  assert.match(
    issuesOf(fixture((doc) => (list(doc, "spells").display = { by: { column: "name", labels: ["A"] } }))),
    /Must name a number column/,
  );
  assert.match(
    issuesOf(fixture((doc) => (list(doc, "spells").display = { mark: "level" }))),
    /Must name a yes-or-no column/,
  );
  assert.match(
    issuesOf(fixture((doc) => (doc.sheet.live.text[0].hideWhen = { derived: "nothing_here", equals: 0 }))),
    /Unknown derived value "nothing_here"/,
  );
  assert.match(
    issuesOf(fixture((doc) => (doc.sheet.live.text[0].hideWhen = { derived: "spell_save_dc", equals: 0, in: [1] }))),
    /exactly one of/,
  );
  assert.ok(
    issuesOf(
      fixture((doc) => (doc.catalogs[0].entries[0].creature.traits = [{ name: "Long", text: "w".repeat(1300) }])),
    ),
    "a trait over 1200 letters",
  );

  // ── The gate ──
  const gate = /capabilityApi 1\.377 or newer/;
  const manifest = (minor: number) => ({
    schemaVersion: 2,
    capabilityApi: { major: 1, minor },
    id: "fivee",
    name: "5e",
    version: "1.0.0",
    kind: ["ruleset"],
    entrypoints: {},
    contributions: { assets: { paths: ["ruleset.json"] } },
    files: [{ path: "ruleset.json", sha256: "0".repeat(64), bytes: 10 }],
    permissions: [],
    restartRequired: false,
  });
  const issueAt = (minor: number, doc: unknown, catalogs?: Map<string, unknown>) =>
    getCapabilityPackageInstallIssue(manifest(minor) as never, doc as never, catalogs as never) ?? "";
  assert.doesNotMatch(issueAt(376, fixture()), gate, "the example asks for nothing new");
  assert.match(issueAt(376, words), gate);
  assert.doesNotMatch(issueAt(377, words), gate);
  for (const edit of [
    (doc: Record<string, any>) => (doc.sheet.live.pools[1].unit = "hit die"),
    (doc: Record<string, any>) => (list(doc, "spells").display = { tab: "Spells" }),
    (doc: Record<string, any>) => (doc.sheet.live.text[0].hideWhen = { derived: "spell_save_dc", equals: 0 }),
    (doc: Record<string, any>) => (doc.sheet.live.conditions[1].pickable = false),
    (doc: Record<string, any>) => (doc.sheet.live.tracks[2].showWhenSet = true),
    (doc: Record<string, any>) => (doc.combat.conditions[13].modifiers[0].label = "says so"),
    (doc: Record<string, any>) =>
      (doc.catalogs[0].entries[0].creature.traits = [{ name: "Long", text: "w".repeat(401) }]),
  ]) {
    assert.match(issueAt(376, fixture(edit)), gate);
  }
  // A trait of 400 letters, the old ceiling, still installs below 1.377.
  assert.doesNotMatch(
    issueAt(
      376,
      fixture((doc) => (doc.catalogs[0].entries[0].creature.traits = [{ name: "Long", text: "w".repeat(400) }])),
    ),
    gate,
  );
  // An item toggle's labels and an item use's title in a catalog file ask for 1.377 as well.
  const items = (item: Record<string, unknown>) =>
    new Map([["catalogs/items.json", { id: "items", entries: [{ id: "lantern", ...item }] }]]);
  assert.match(issueAt(376, fixture(), items({ toggle: { onLabel: "Raise the hood" } })), gate);
  assert.match(issueAt(376, fixture(), items({ use: { title: "Scatter ball bearings" } })), gate);
  assert.doesNotMatch(issueAt(377, fixture(), items({ use: { title: "Scatter ball bearings" } })), gate);

  console.log("Ruleset sheet words: labels, units, list display, hidden text, the picker, tracks, traits, the gate.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
