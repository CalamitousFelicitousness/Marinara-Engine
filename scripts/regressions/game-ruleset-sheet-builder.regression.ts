/**
 * The guided builder (Capability API 1.81): `sheet.builder.steps` and a catalog entry's `grants`.
 *
 *   - The keys read, and a builder that names what the ruleset does not have is refused.
 *   - Picks apply what they grant (score increases, chosen increases, training, field values, rows,
 *     the step's field) and unpicking takes it back, a subrace with its race.
 *   - The methods: point buy within its budget, an array or rolls handed out one value to a score,
 *     manual entry; increases go on top.
 *   - An edit made in the full form survives until the builder's own answer changes.
 *   - Each step's remaining choices; gated inline and in a catalog file.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyRulesetBuilder,
  defaultRulesetSheetBuild,
  parseRulesetDefinition,
  readRulesetBuilderState,
  rulesetBuilderAbilitySlots,
  rulesetBuilderCatalogIds,
  rulesetBuilderChoiceKey,
  rulesetBuilderOptions,
  rulesetBuilderRemaining,
  rulesetBuilderTrainedSlots,
  rulesetCatalogEntryIssues,
  rulesetPointBuySpent,
  type RulesetBuilderState,
  type RulesetCatalogEntriesById,
  type RulesetDefinition,
  type RulesetSheetBuild,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-sheet-builder-"));
process.env.DATA_DIR = dataDir;
process.env.MARINARA_DATA_DIR = dataDir;
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const fiveEText = read("../../docs/development/ruleset-5e-2014.example.json");

const races = {
  id: "races",
  label: "Races",
  feeds: ["features"],
  filters: [{ id: "parent", label: "Race", type: "text" }],
  entries: [
    {
      id: "dwarf",
      label: "Dwarf",
      summary: "Stout and hardy.",
      rows: [{ list: "features", values: { name: "Darkvision", text: "See in the dark." } }],
      grants: { abilities: { add: { con: 2 } } },
    },
    { id: "hill-dwarf", label: "Hill Dwarf", filters: { parent: "dwarf" }, grants: { abilities: { add: { wis: 1 } } } },
    {
      id: "half-elf",
      label: "Half-Elf",
      grants: {
        abilities: { add: { cha: 2 }, choose: [{ count: 2, amount: 1, except: ["cha"] }] },
        trained: { choose: [{ what: "skills", count: 2 }] },
      },
    },
  ],
};
const classes = {
  id: "classes",
  label: "Classes",
  entries: [
    {
      id: "fighter",
      label: "Fighter",
      grants: {
        trained: {
          saves: ["str_save", "con_save"],
          choose: [{ what: "skills", count: 2, from: ["acrobatics", "athletics", "perception", "survival"] }],
        },
        sets: { hit_die: "d10" },
      },
    },
    {
      id: "wizard",
      label: "Wizard",
      grants: { trained: { saves: ["int_save", "wis_save"] }, sets: { hit_die: "d6" } },
    },
  ],
};
const steps = [
  { id: "race", label: "Race", kind: "catalog", catalog: "races", field: "race", filters: {} },
  {
    id: "subrace",
    label: "Subrace",
    kind: "catalog",
    catalog: "races",
    min: 0,
    within: { step: "race", filter: "parent" },
  },
  { id: "class", label: "Class", kind: "catalog", catalog: "classes", field: "class" },
  { id: "level", label: "Level", kind: "fields", fields: ["level", "background"] },
  {
    id: "scores",
    label: "Ability Scores",
    kind: "abilities",
    methods: {
      pointBuy: {
        budget: 27,
        costs: [
          [8, 0],
          [9, 1],
          [10, 2],
          [11, 3],
          [12, 4],
          [13, 5],
          [14, 7],
          [15, 9],
        ],
      },
      standardArray: [15, 14, 13, 12, 10, 8],
      roll: { count: 4, sides: 6, keep: 3 },
      manual: true,
    },
  },
  { id: "skills", label: "Proficiencies", kind: "trained" },
];

const variant = (edit: (doc: Record<string, any>) => void = () => {}) => {
  const doc = JSON.parse(fiveEText) as Record<string, any>;
  // A race offers subraces by a filter, so the race step offers only the ones without a parent; the
  // test reads them with `filters: {}` and checks `within` on its own.
  doc.catalogs.push(structuredClone(races), structuredClone(classes));
  doc.sheet.builder = { tier: "proficient", steps: structuredClone(steps) };
  edit(doc);
  return doc;
};
const parsed = (doc: unknown): RulesetDefinition => {
  const result = parseRulesetDefinition(doc);
  assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
  return result.definition;
};
const refused = (edit: (doc: Record<string, any>) => void, pattern: RegExp) => {
  const result = parseRulesetDefinition(variant(edit));
  assert.equal(result.ok, false, `refused: ${pattern}`);
  assert.ok(
    !result.ok && result.issues.some((issue) => pattern.test(issue)),
    `${pattern} in ${!result.ok && result.issues.join("; ")}`,
  );
};

try {
  const definition = parsed(variant());
  const catalogs: RulesetCatalogEntriesById = Object.fromEntries(
    (definition.catalogs ?? []).map((catalog) => [catalog.id, catalog.entries ?? []]),
  );
  assert.deepEqual(rulesetBuilderCatalogIds(definition), ["races", "classes"]);

  // ── What is refused ──
  refused((doc) => (doc.sheet.builder.steps[0].catalog = "nope"), /No catalog of rows "nope"/);
  refused((doc) => (doc.sheet.builder.steps[0].catalog = "creatures"), /No catalog of rows "creatures"/);
  refused((doc) => (doc.sheet.builder.steps[0].field = "level"), /No text or enum field "level"/);
  refused((doc) => (doc.sheet.builder.steps[1].within.step = "class"), /No catalog step "class" before/);
  refused((doc) => (doc.sheet.builder.steps[1].within.filter = "nope"), /No text or tags filter "nope"/);
  refused((doc) => (doc.sheet.builder.steps[0].filters = { nope: "x" }), /Unknown filter "nope"/);
  refused((doc) => (doc.sheet.builder.steps[0].min = 3), /at most its max/);
  refused((doc) => doc.sheet.builder.steps[3].fields.push("nope"), /Unknown field "nope"/);
  refused((doc) => doc.sheet.builder.steps[4].methods.standardArray.pop(), /one value to each of the 6 scores/);
  refused((doc) => doc.sheet.builder.steps.push({ ...doc.sheet.builder.steps[4], id: "again" }), /one step/);
  refused((doc) => (doc.sheet.builder.steps[4].methods = {}), /offers a method/);
  refused(
    (doc) =>
      (doc.sheet.builder.steps[4].methods.pointBuy.costs = [
        [8, 0],
        [10, 2],
      ]),
    /one score at a time/,
  );
  refused((doc) => (doc.sheet.builder.steps[4].methods.roll.keep = 5), /keeps at most/);
  refused(
    (doc) => doc.sheet.builder.steps.push({ id: "gear", label: "Gear", kind: "startingGear" }),
    /no starting gear/,
  );
  refused((doc) => (doc.sheet.builder.tier = "none"), /not a tier above untrained/);
  refused(
    (doc) =>
      doc.sheet.builder.steps.push({
        id: "own",
        label: "Own",
        kind: "trained",
        choose: [{ what: "saves", count: 1, from: ["nope"] }],
      }),
    /Unknown save "nope"/,
  );
  refused((doc) => (doc.sheet.builder.steps[1].id = "race"), /Duplicate builder step id "race"/);
  // Grants, inline (an asset file's entries go through the same checks).
  const grantRefused = (grants: unknown, pattern: RegExp) =>
    refused(
      (doc) => (doc.catalogs.find((c: { id: string }) => c.id === "classes").entries[0].grants = grants),
      pattern,
    );
  grantRefused({ abilities: { add: { luck: 1 } } }, /Unknown ability "luck"/);
  grantRefused({ abilities: { choose: [{ count: 6, amount: 1, except: ["cha"] }] } }, /Only 5 scores are left/);
  grantRefused({ trained: { skills: ["nope"] } }, /Unknown skill "nope"/);
  grantRefused({ trained: { saves: ["str_save"], tier: "none" } }, /not a tier above untrained/);
  grantRefused({ trained: { choose: [{ what: "saves", count: 1, from: ["athletics"] }] } }, /Unknown save "athletics"/);
  grantRefused({ sets: { hit_die: "d20" } }, /cannot hold "d20"/);
  grantRefused({ sets: { level: 99 } }, /cannot hold 99/);
  grantRefused({ sets: { nope: 1 } }, /Unknown field "nope"/);
  refused(
    (doc) => delete doc.catalogs.find((c: { id: string }) => c.id === "classes").entries[0].grants,
    /exactly one of "rows", "creature" or "item", or only "grants"/,
  );
  refused(
    (doc) =>
      (doc.catalogs.find((c: { holds?: string }) => c.holds === "creatures").entries[0].grants = {
        sets: { level: 1 },
      }),
    /Only an entry for a sheet grants/,
  );
  assert.deepEqual(
    rulesetCatalogEntryIssues(
      definition,
      definition.catalogs!.find((c) => c.id === "classes")!,
      [{ id: "x", label: "X", grants: { sets: { hit_die: "d3" } } }],
    ).map((issue) => issue.message),
    ['Field "hit_die" cannot hold "d3"'],
    "a catalog file's entries are checked the same way",
  );

  // ── Picks apply and unpicking takes back ──
  const raceStep = definition.sheet.builder!.steps[0]!;
  const subStep = definition.sheet.builder!.steps[1]!;
  assert.ok(raceStep.kind === "catalog" && subStep.kind === "catalog");
  let build: RulesetSheetBuild = defaultRulesetSheetBuild(definition);
  let state: RulesetBuilderState = {};
  const apply = (next: RulesetBuilderState) => {
    const out = applyRulesetBuilder(definition, build, next, catalogs);
    build = out.build;
    state = out.state;
  };
  assert.deepEqual(
    rulesetBuilderOptions(definition, subStep, {}, catalogs).map((entry) => entry.id),
    [],
    "no subrace before a race",
  );
  apply({ picks: { race: ["dwarf"] } });
  assert.equal(build.abilities.con, 12, "a dwarf's constitution +2");
  assert.equal(build.fields.race, "Dwarf", "the step writes its field");
  assert.equal(build.lists.features?.filter((row) => row._catalog === "races/dwarf").length, 1, "its rows");
  assert.deepEqual(
    rulesetBuilderOptions(definition, subStep, state, catalogs).map((entry) => entry.id),
    ["hill-dwarf"],
    "a subrace by its race",
  );
  apply({ ...state, picks: { ...state.picks, subrace: ["hill-dwarf"] } });
  assert.equal(build.abilities.wis, 11);
  apply({ ...state });
  assert.equal(build.abilities.con, 12, "applying again changes nothing");
  assert.equal(build.lists.features?.filter((row) => row._catalog === "races/dwarf").length, 1, "rows never twice");
  apply({ ...state, picks: { ...state.picks, race: ["half-elf"] } });
  assert.equal(build.abilities.con, 10, "the dwarf's increase is taken back");
  assert.equal(build.abilities.wis, 10, "and the subrace's, whose race went");
  assert.equal(build.abilities.cha, 12);
  assert.equal(build.fields.race, "Half-Elf");
  assert.equal(
    build.lists.features?.some((row) => row._catalog === "races/dwarf"),
    false,
    "its rows go",
  );

  // A chosen increase, never twice and never one the choice excepts.
  const [abilitySlot] = rulesetBuilderAbilitySlots(definition, state, catalogs);
  assert.ok(abilitySlot);
  assert.equal(abilitySlot.stepId, "scores", "shown at the abilities step");
  assert.deepEqual(abilitySlot.from, ["str", "dex", "con", "int", "wis"]);
  apply({ ...state, abilityChoices: { [abilitySlot.key]: ["dex", "dex", "cha", "int", "str"] } });
  assert.deepEqual(
    [build.abilities.dex, build.abilities.int, build.abilities.str, build.abilities.cha],
    [11, 11, 10, 12],
  );

  // Class: saves, a field, a skill choice at the trained step.
  apply({ ...state, picks: { ...state.picks, class: ["fighter"] } });
  assert.equal(build.saves.str_save, "proficient");
  assert.equal(build.fields.hit_die, "d10");
  assert.equal(build.fields.class, "Fighter");
  const fighterSlot = rulesetBuilderTrainedSlots(definition, state, catalogs).find(
    (slot) => slot.entry?.id === "fighter",
  );
  assert.ok(fighterSlot);
  assert.equal(fighterSlot.stepId, "skills");
  apply({ ...state, trainedChoices: { [fighterSlot.key]: ["athletics", "arcana", "perception"] } });
  assert.equal(build.skills.athletics, "proficient");
  assert.equal(build.skills.perception, "proficient");
  assert.equal(build.skills.arcana, undefined, "only from the class's list");

  // An edit in the full form survives until the builder's answer for it changes.
  build = {
    ...build,
    fields: { ...build.fields, hit_die: "d12" },
    skills: { ...build.skills, athletics: "expertise" },
  };
  apply({ ...state, method: "manual" });
  assert.equal(build.fields.hit_die, "d12", "a field edit survives an unrelated step");
  apply({ ...state, picks: { ...state.picks, class: ["wizard"] } });
  assert.equal(build.fields.hit_die, "d6", "and goes when the pick changes");
  assert.equal(build.skills.athletics, "expertise", "a tier raised by hand is the player's");
  assert.equal(build.skills.perception, undefined, "the builder's own is taken back");
  assert.equal(build.saves.str_save, undefined);
  assert.equal(build.saves.int_save, "proficient");
  apply({ ...state, picks: { ...state.picks, race: [], class: [] } });
  assert.equal(build.fields.race, undefined, "no race, no field");
  assert.equal(build.abilities.cha, 10);

  // ── The methods ──
  const scoreStep = definition.sheet.builder!.steps[4]!;
  assert.ok(scoreStep.kind === "abilities");
  const ids = ["str", "dex", "con", "int", "wis", "cha"];
  build = defaultRulesetSheetBuild(definition);
  state = {};
  let left = rulesetBuilderRemaining(definition, build, state, catalogs);
  assert.deepEqual(left, { race: 1, subrace: 0, class: 1, level: 1, scores: 1, skills: 0 }, "background is empty");
  apply({ method: "pointBuy" });
  assert.deepEqual(
    ids.map((id) => build.abilities[id]),
    [8, 8, 8, 8, 8, 8],
    "point buy starts at the lowest",
  );
  assert.equal(rulesetPointBuySpent(scoreStep.methods.pointBuy!, build.abilities, ids), 0);
  apply({ ...state, base: { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, picks: { race: ["dwarf"] } });
  assert.equal(
    rulesetPointBuySpent(scoreStep.methods.pointBuy!, { str: 15, dex: 14, con: 13, int: 12, wis: 10, cha: 8 }, ids),
    27,
  );
  assert.equal(build.abilities.con, 15, "bought 13, +2 from the race");
  left = rulesetBuilderRemaining(definition, build, state, catalogs);
  assert.equal(left.scores, 0, "the budget is spent");
  assert.equal(left.race, 0);
  build = { ...build, abilities: { ...build.abilities, int: 17 } };
  apply({ ...state });
  assert.equal(build.abilities.int, 17, "a score typed in the full form survives");
  apply({ ...state, base: { ...state.base, int: 13 } });
  assert.equal(build.abilities.int, 13, "until the builder's own answer for it changes");
  apply({ ...state, base: { ...state.base, int: 12, str: 14 } });
  assert.equal(rulesetBuilderRemaining(definition, build, state, catalogs).scores, 1, "points left over");
  apply({ ...state, base: { ...state.base, str: 16 } });
  assert.equal(rulesetBuilderRemaining(definition, build, state, catalogs).scores, 1, "off the table");
  // The array: one value to one score, a second claim is no claim.
  apply({ ...state, method: "standardArray", assign: { str: 0, dex: 0, con: 2 } });
  assert.equal(build.abilities.str, 15);
  assert.equal(build.abilities.con, 15, "13 +2");
  assert.equal(rulesetBuilderRemaining(definition, build, state, catalogs).scores, 4);
  // Rolls.
  apply({ ...state, method: "roll", rolled: [17, 9], assign: { str: 1, dex: 0 } });
  assert.deepEqual([build.abilities.str, build.abilities.dex], [9, 17]);
  assert.equal(rulesetBuilderRemaining(definition, build, state, catalogs).scores, 4);
  // A method the step does not offer reads as none.
  assert.equal(rulesetBuilderRemaining(definition, build, { method: "nope" as never }, catalogs).scores, 1);

  // The trained step's own choice counts there.
  const own = parsed(
    variant((doc) => (doc.sheet.builder.steps[5].choose = [{ what: "skills", count: 1, from: ["stealth"] }])),
  );
  const ownSlot = rulesetBuilderTrainedSlots(own, {}, catalogs);
  assert.equal(ownSlot[0]?.key, rulesetBuilderChoiceKey("skills", null, 0));
  assert.equal(rulesetBuilderRemaining(own, defaultRulesetSheetBuild(own), {}, catalogs).skills, 1);
  // Without a trained or abilities step, a grant's choices are shown where the entry was picked.
  const lean = parsed(variant((doc) => doc.sheet.builder.steps.splice(4, 2)));
  const leanState = { picks: { race: ["half-elf"] } };
  assert.equal(rulesetBuilderRemaining(lean, defaultRulesetSheetBuild(lean), leanState, catalogs).race, 4);

  // The state is read tolerantly.
  assert.deepEqual(readRulesetBuilderState({ builder: "nonsense" }), {});
  assert.deepEqual(readRulesetBuilderState(undefined), {});
  assert.deepEqual(readRulesetBuilderState({ builder: { method: "manual", extra: 1 } }), { method: "manual" });

  // ── The gate ──
  const manifest = (minor: number, paths = ["ruleset.json"]) => ({
    schemaVersion: 2,
    capabilityApi: { major: 1, minor },
    builtAgainst: { engineVersion: "2.4.6", engineCommit: "0".repeat(40) },
    id: "ruleset-builder",
    name: "Builder",
    version: "0.1.0",
    description: "A packaged ruleset with a guided builder.",
    engine: { min: "2.4.6", maxExclusive: "4.0.0" },
    kind: ["ruleset"],
    entrypoints: {},
    contributions: { assets: { paths } },
    files: [{ path: "ruleset.json", sha256: "0".repeat(64), bytes: 10 }],
    permissions: [],
    restartRequired: false,
  });
  const issue = (minor: number, doc: Record<string, any>, files?: Map<string, unknown>, paths?: string[]) =>
    getCapabilityPackageInstallIssue(manifest(minor, paths) as any, doc, files as any);
  const withBuilder = variant((doc) => {
    // Builder alone: classes with plain rows, races without grants.
    doc.catalogs = doc.catalogs.filter((c: { id: string }) => c.id !== "races" && c.id !== "classes");
    doc.sheet.builder.steps = [doc.sheet.builder.steps[3]];
  });
  assert.match(issue(80, withBuilder) ?? "", /guided builder.*1\.81/);
  assert.equal(issue(81, withBuilder), null);
  const grantsOnly = variant((doc) => {
    delete doc.sheet.builder;
    doc.catalogs = doc.catalogs.filter((c: { id: string }) => c.id !== "classes");
  });
  assert.match(issue(80, grantsOnly) ?? "", /1\.81/);
  assert.equal(issue(81, grantsOnly), null);
  const filed = variant((doc) => {
    delete doc.sheet.builder;
    doc.catalogs = doc.catalogs.filter((c: { id: string }) => c.id !== "classes");
    const raceCatalog = doc.catalogs.find((c: { id: string }) => c.id === "races");
    raceCatalog.asset = "catalogs/races.json";
    delete raceCatalog.entries;
  });
  const files = new Map<string, unknown>([["catalogs/races.json", { entries: races.entries }]]);
  const paths = ["ruleset.json", "catalogs/races.json"];
  assert.match(issue(80, filed, files, paths) ?? "", /1\.81/);
  assert.equal(issue(81, filed, files, paths), null);
  assert.equal(issue(74, JSON.parse(fiveEText)), null, "an older package still validates");

  console.log("Ruleset builder: steps, grants, methods, take-backs, remaining choices and the 1.81 gate.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
