/**
 * The encounter budget (Capability API 1.795).
 *
 *   - Schema and gate: a threat tier's `worth` and `combat.threat.budget`, its level fields, one worth
 *     a step on every row, `forGame` naming its steps; gated at 1.795.
 *   - What a party may meet: each member's row by level, the step its game difficulty plays at (in
 *     order, or `forGame`'s), one step higher with a boss; a crowd row up for a small party.
 *   - A fight over it: invented opponents come down a rung at a time, the one worth the most first; a
 *     bestiary creature and one kept (it came back) are counted and never moved, said in the
 *     fight's adjustments, and kept as fought for when one gets away.
 *   - The Game Master's blueprint brief names each tier's worth and the party's budget.
 *
 * Laptop party B (2026-10-25): four CR 3 winter wolves and an invented CR 8 against level 5, wiped.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultRulesetSheetBuild,
  parseRulesetDefinition,
  rulesetBudgetedTiers,
  rulesetCrowdTimes,
  rulesetEncounterBudget,
  rulesetFightWorth,
  type RulesetDefinition,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-budget-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");
const { createRulesetFight } =
  await import("../../packages/server/src/services/game/ruleset-combat-director.service.js");
const { buildInitPrompt, encounterRulesetBrief } = await import("../../packages/server/src/routes/encounter.routes.js");

try {
  const text = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const XP: Record<string, number> = {
    cr_0: 10,
    cr_1_8: 25,
    cr_1_4: 50,
    cr_1_2: 100,
    cr_1: 200,
    cr_2: 450,
    cr_3: 700,
    cr_4: 1100,
    cr_5: 1800,
  };
  // SRD 5.2's Low, Moderate and High per character, levels 1 to 5.
  const budget = {
    level: ["level"],
    steps: [
      { id: "low", label: "Low" },
      { id: "moderate", label: "Moderate" },
      { id: "high", label: "High" },
    ],
    byLevel: [
      { level: 1, worth: [50, 75, 100] },
      { level: 2, worth: [100, 150, 200] },
      { level: 3, worth: [150, 225, 400] },
      { level: 4, worth: [250, 375, 500] },
      { level: 5, worth: [500, 750, 1100] },
    ],
  };
  const doc = (edit: (doc: Record<string, any>) => void = () => {}) => {
    const one = JSON.parse(text) as Record<string, any>;
    for (const tier of one.combat.threat.tiers) tier.worth = XP[tier.id];
    one.combat.threat.budget = structuredClone(budget);
    edit(one);
    return one;
  };
  const parsed = (document: unknown): RulesetDefinition => {
    const result = parseRulesetDefinition(document);
    assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
    return result.definition;
  };
  const refused = (edit: (doc: Record<string, any>) => void, message: RegExp) => {
    const result = parseRulesetDefinition(doc(edit));
    assert.equal(result.ok, false, `expected a refusal matching ${message}`);
    assert.ok(
      !result.ok && result.issues.some((issue) => message.test(issue)),
      !result.ok ? result.issues.join("; ") : "",
    );
  };

  // ── Schema ──
  const definition = parsed(doc());
  refused((one) => (one.combat.threat.budget.level = ["nope"]), /Unknown sheet field "nope"/);
  refused((one) => one.combat.threat.budget.byLevel[2].worth.pop(), /one worth for each of the 3 steps/);
  refused((one) => (one.combat.threat.budget.forGame = { hard: "deadly" }), /Unknown budget step "deadly"/);
  refused((one) => {
    for (const tier of one.combat.threat.tiers) delete tier.worth;
  }, /needs a worth on the threat tiers/);
  refused((one) => one.combat.threat.budget.byLevel.reverse(), /Each level is above the one before it/);

  // ── What a party may meet ──
  const four = rulesetEncounterBudget(definition, [5, 5, 5, 5], "normal")!;
  assert.deepEqual(four.step, { id: "moderate", label: "Moderate" });
  assert.equal(four.worth, 3000);
  assert.equal(four.bossWorth, 4400);
  assert.equal(rulesetEncounterBudget(definition, [5, 5, 5, 5], "casual")!.worth, 2000);
  // Brutal is past the last step, so it plays at the last, and a boss fight cannot go higher.
  const brutal = rulesetEncounterBudget(definition, [5, 5, 5, 5], "brutal")!;
  assert.equal(brutal.step.id, "high");
  assert.equal(brutal.bossWorth, brutal.worth);
  // A level past the last row reads the last row; nobody with a level is no budget.
  assert.equal(rulesetEncounterBudget(definition, [9], "normal")!.worth, 750);
  assert.equal(rulesetEncounterBudget(definition, [0, 0], "normal"), null);
  const told = parsed(doc((one) => (one.combat.threat.budget.forGame = { brutal: "low" })));
  assert.equal(rulesetEncounterBudget(told, [5], "brutal")!.step.id, "low");
  // 5e 2014's crowd: a pair counts half again, and a party of two reads a row up.
  const crowded = parsed(
    doc((one) => {
      one.combat.threat.budget.crowd = [
        { from: 0, times: 0.5 },
        { from: 1, times: 1 },
        { from: 2, times: 1.5 },
        { from: 3, times: 2 },
      ];
      one.combat.threat.budget.smallParty = 3;
      one.combat.threat.budget.largeParty = 5;
    }),
  );
  assert.equal(rulesetCrowdTimes(crowded, 2, 4), 1.5);
  assert.equal(rulesetCrowdTimes(crowded, 2, 2), 2);
  assert.equal(rulesetCrowdTimes(crowded, 1, 6), 0.5);
  assert.equal(rulesetFightWorth(crowded, ["cr_3", "cr_3"], 4), 2100);
  assert.equal(rulesetCrowdTimes(definition, 9, 4), 1);

  // ── Brought down ──
  const moved = rulesetBudgetedTiers(
    definition,
    [
      { tier: "cr_3", kept: true },
      { tier: "cr_3", kept: true },
      { tier: "cr_5", kept: false },
      { tier: "cr_2", kept: false },
    ],
    3000,
    4,
  );
  // 3650 at first: the CR 5, worth the most of those that may move, comes down a rung to CR 4 (2950),
  // which fits, and nothing more moves.
  assert.deepEqual(moved.tiers, ["cr_3", "cr_3", "cr_4", "cr_2"]);
  assert.deepEqual(moved.worth, { before: 3650, after: 2950 });
  // An invented boss's legendary points count it for more (laptop interim 2026-10-26: a lich with 3
  // points rated "4100, within High 4400" wiped a party in three rounds): 3 points, twice its tier.
  assert.equal(rulesetFightWorth(definition, ["cr_5", "cr_2"], 4, [2]), 4050);
  const legendary = rulesetBudgetedTiers(
    definition,
    [
      { tier: "cr_5", kept: false, times: 2 },
      { tier: "cr_2", kept: false },
    ],
    3000,
    4,
  );
  assert.deepEqual(legendary.tiers, ["cr_4", "cr_2"]);
  assert.deepEqual(legendary.worth, { before: 4050, after: 2650 });
  // Only kept ones over budget: counted, unmoved.
  const stuck = rulesetBudgetedTiers(definition, [{ tier: "cr_5", kept: true }], 100, 4);
  assert.deepEqual(stuck.tiers, ["cr_5"]);
  assert.equal(stuck.worth.after, 1800);

  // ── A fight over it ──
  const card = (name: string, level: number) => {
    const build = defaultRulesetSheetBuild(definition);
    build.fields.level = level;
    return { name, rulesetSheet: { v: 1, build } };
  };
  const cards = [card("Ulfgar", 2), card("Wren", 2)];
  const party = [
    { id: "ulfgar", name: "Ulfgar" },
    { id: "wren", name: "Wren" },
  ];
  const bestiary = Object.fromEntries(
    (definition.catalogs ?? []).filter((one) => one.holds === "creatures").map((one) => [one.id, one.entries ?? []]),
  );
  const fight = (input: { enemies: any[]; budget?: { difficulty: "normal" | "hard"; kept?: string[] } }) => {
    const built = createRulesetFight({
      definition,
      seed: 3,
      party,
      enemies: input.enemies,
      cards,
      playerName: null,
      live: null,
      partyCatalogs: {},
      bestiary,
      ...(input.budget ? { budget: input.budget } : {}),
    });
    assert.ok(built.ok, built.ok ? "" : built.error);
    return built.fight;
  };
  const enemies = [
    { id: "sentinel", name: "Hollow Sentinel", creature: "Hollow Sentinel" },
    { id: "brute", name: "Ogre Brute", tier: "cr_5" },
    { id: "mage", name: "Cult Mage", proposed: { tier: "cr_4", health: 40, defense: 13, actions: [] } },
  ];
  // Two at level 2, Moderate: 300. The sentinel alone (700) is over it, so both invented ones go as
  // low as the scale goes and the fight says it is still over.
  const over = fight({ enemies, budget: { difficulty: "normal" } });
  assert.equal(over.made?.brute?.tier, "cr_0");
  assert.equal((over.made?.mage?.proposed as { tier?: string }).tier, "cr_0");
  assert.equal(over.made?.sentinel?.tier, undefined);
  assert.ok(
    over.adjustments.some((line) => /Ogre Brute was brought down from CR 5 to CR 0: .*Moderate budget/.test(line)),
  );
  assert.ok(over.adjustments.some((line) => /worth 720, more than this party's Moderate budget of 300/.test(line)));
  // Without the sentinel and with the brute kept (it came back): only the mage moves, and only as far
  // as it needs to (Hard is 400; the brute alone is 1800, so it goes to the floor).
  const kept = fight({ enemies: enemies.slice(1), budget: { difficulty: "hard", kept: ["brute"] } });
  assert.equal(kept.made?.brute?.tier, "cr_5");
  assert.equal((kept.made?.mage?.proposed as { tier?: string }).tier, "cr_0");
  // One that fits is left as it was, and so is any fight given no budget (a story's).
  const fits = fight({ enemies: [{ id: "pup", name: "Ash Pup", tier: "cr_1" }], budget: { difficulty: "normal" } });
  const story = fight({ enemies: enemies.slice(1) });
  assert.equal(fits.made?.pup?.tier, "cr_1");
  // Said as weighed all the same (laptop playtest 2026-10-25: no word of the budget anywhere).
  assert.deepEqual(
    fits.adjustments.filter((line) => /budget/.test(line)),
    ["This fight is worth 200, within this party's Moderate budget of 300."],
  );
  assert.ok(!story.adjustments.some((line) => /budget/.test(line)), "a story's fight says nothing of one");
  assert.equal(story.made?.brute?.tier, "cr_5");
  // A boss reaches the next step: two at level 2 have High's 400, so a CR 2 chief (450) and a CR 1/2
  // guard (100) come to 300 with the chief a rung down, and the guard stays.
  const bossed = fight({
    enemies: [
      { id: "chief", name: "Chief", tier: "cr_2", boss: true },
      { id: "guard", name: "Guard", tier: "cr_1_2" },
    ],
    budget: { difficulty: "normal" },
  });
  assert.equal(bossed.made?.chief?.tier, "cr_1");
  assert.equal(bossed.made?.guard?.tier, "cr_1_2");
  // Said at the step it was weighed at (cloud re-test 2026-10-25: "Moderate budget of 4400").
  assert.ok(
    bossed.adjustments.some((line) => /this party's High budget\b/.test(line)),
    bossed.adjustments.join("; "),
  );
  assert.deepEqual(four.bossStep, { id: "high", label: "High" });

  // ── The brief ──
  const brief = await encounterRulesetBrief(definition, null, { cards, difficulty: "normal" });
  assert.ok(brief);
  assert.equal(brief.budget?.worth, 300);
  const prompt = buildInitPrompt("Ulfgar", "", "", [], "", "", false, undefined, brief)
    .map((message) => message.content)
    .join("\n");
  assert.match(prompt, /cr_3 \(CR 3, worth 700\)/);
  assert.match(
    prompt,
    /played at Moderate for a party of 2 \(levels 2, 2\).*at most 300, or 400 for a fight with a boss/,
  );
  // An invented caster's guidance (Alyssa, 2026-10-25): one role, six that spend its pools at most.
  assert.match(prompt, /A caster you make up has one role .* at most 6 that spend its pools/);
  // A ruleset with no budget says nothing of one.
  const plain = parsed(JSON.parse(text));
  const none = await encounterRulesetBrief(plain, null, { cards, difficulty: "normal" });
  assert.equal(none?.budget, null);
  assert.doesNotMatch(
    buildInitPrompt("Ulfgar", "", "", [], "", "", false, undefined, none)
      .map((message) => message.content)
      .join("\n"),
    /Budget:|worth \d/,
  );

  // ── The 1.795 gate ──
  const manifest = (minor: number) => ({
    schemaVersion: 2,
    capabilityApi: { major: 1, minor },
    builtAgainst: { engineVersion: "2.4.6", engineCommit: "0".repeat(40) },
    id: "ruleset-budget",
    name: "Budget",
    version: "0.1.0",
    description: "A packaged ruleset with an encounter budget.",
    engine: { min: "2.4.6", maxExclusive: "4.0.0" },
    kind: ["ruleset"],
    entrypoints: {},
    contributions: { assets: { paths: ["ruleset.json"] } },
    files: [{ path: "ruleset.json", sha256: "0".repeat(64), bytes: 10 }],
    permissions: [],
    restartRequired: false,
  });
  const gate = /encounter budget.*capabilityApi 1\.795/;
  const issue = (minor: number, one: Record<string, any>) =>
    getCapabilityPackageInstallIssue(manifest(minor) as any, one);
  assert.match(issue(794, doc()) ?? "", gate);
  assert.equal(issue(795, doc()), null);
  assert.match(
    issue(
      794,
      doc((one) => delete one.combat.threat.budget),
    ) ?? "",
    gate,
  );
  assert.doesNotMatch(issue(794, JSON.parse(text)) ?? "", gate);

  console.log("The encounter budget brings invented foes down to what the party may meet.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
