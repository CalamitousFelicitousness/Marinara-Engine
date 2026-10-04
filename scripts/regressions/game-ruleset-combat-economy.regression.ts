/**
 * Ruleset combat, combat C6d: conditions that change the action economy, as Haste and Slow do.
 *
 *   - `budgets`: a turn's count of a budget, more or fewer, from the first turn on; a budget may be
 *     declared with a count of 0, for one only a condition fills.
 *   - `grants`: what that budget may be spent on: the standard actions named, one weapon attack of a
 *     single strike (Extra Attack's strikes are not given), an item's use.
 *   - `exclusive`: of two budgets a turn spends only one; spending either empties the other.
 *   - `attacksPerTurn`: no attack past the cap, whatever strikes an action would give.
 *   - `onEnd`: what a condition leaves behind when it ends for good, as Haste's lethargy is.
 *   - The 1.71 gate is the install gate's (combat-cover pins its neighbours); the schema refuses
 *     budgets and conditions the ruleset does not declare.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  applyRulesetCombatChoice,
  createRulesetEncounter,
  parseRulesetDefinition,
  RULESET_MOVE_OPTION,
  rulesetCombatant,
  rulesetCombatOptions,
  rulesetSheetBuildSchema,
  type RulesetCombatantInput,
  type RulesetCombatChoice,
  type RulesetCombatEvent,
  type RulesetCombatRoller,
  type RulesetDefinition,
  type RulesetEncounterState,
} from "../../packages/shared/src/index.js";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const fiveEText = read("../../docs/development/ruleset-5e-2014.example.json");
const variant = (edit: (doc: Record<string, any>) => void) => {
  const doc = JSON.parse(fiveEText) as Record<string, any>;
  edit(doc);
  return doc;
};
const parsedOrThrow = (document: unknown): RulesetDefinition => {
  const parsed = parseRulesetDefinition(document);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.issues.join("; "));
  return parsed.definition;
};
const refusal = (document: unknown): string => {
  const parsed = parseRulesetDefinition(document);
  assert.ok(!parsed.ok, "this document was supposed to be refused");
  return parsed.issues.join("; ");
};

/** The 5e example with a haste budget of no count, and three conditions: quickened (Haste), sluggish
 *  (Slow) and drained (the lethargy Haste leaves). */
const withEconomy = (doc: Record<string, any>) => {
  doc.combat.economy.budgets.push({ id: "haste", label: "Haste action", per: "turn", count: 0 });
  for (const [id, label] of [
    ["quickened", "Quickened"],
    ["sluggish", "Sluggish"],
    ["drained", "Drained"],
  ])
    doc.sheet.live.conditions.push({ id, label });
  doc.combat.conditions.push(
    {
      condition: "quickened",
      budgets: [{ budget: "haste", flat: 1 }],
      grants: { budget: "haste", standard: ["dash", "disengage", "hide"], attacks: true },
      onEnd: { applies: [{ condition: "drained", duration: { rounds: 1 } }] },
    },
    { condition: "sluggish", effects: ["cannot-react"], exclusive: ["action", "bonus"], attacksPerTurn: 1 },
    { condition: "drained", effects: ["cannot-act"] },
  );
};
const fiveE = parsedOrThrow(variant(withEconomy));

const dice = (...faces: number[]): RulesetCombatRoller => {
  let index = 0;
  return (sides) => {
    assert.ok(index < faces.length, `the script ran out of dice (a d${sides} was asked for)`);
    return faces[index++]!;
  };
};
type EventOf<T extends RulesetCombatEvent["type"]> = Extract<RulesetCombatEvent, { type: T }>;
const eventsOf = <T extends RulesetCombatEvent["type"]>(events: RulesetCombatEvent[], type: T): EventOf<T>[] =>
  events.filter((event): event is EventOf<T> => event.type === type);

/** Brenna attacks twice an Attack action (Extra Attack), and holds what `live` says she does. */
const brenna = (conditions: string[] = []): RulesetCombatantInput => ({
  id: "brenna",
  name: "Brenna",
  side: "party",
  build: rulesetSheetBuildSchema.parse({
    abilities: { str: 18, dex: 14, con: 16, int: 10, wis: 10, cha: 10 },
    saves: { str_save: "proficient", con_save: "proficient" },
    fields: { level: 7, ac: 18, speed: 30, hp_max: 60, attacks_per_action: 2 },
    lists: {
      attacks: [
        { name: "Longsword", ability: "str", proficient: true, bonus: 0, damage: "1d8", damage_type: "slashing" },
      ],
    },
  }),
  live: conditions.length ? { conditions } : {},
  catalogs: {},
});
const snag = (): RulesetCombatantInput => ({
  id: "snag",
  name: "Snag",
  side: "enemy",
  block: {
    health: 200,
    defense: 5,
    initiativeModifier: 2,
    speed: 30,
    actions: [
      { id: "scimitar", name: "Scimitar", budget: "action", toHit: 4, damage: { count: 1, sides: 6, flat: 2 } },
    ],
  },
});
const fight = (conditions: string[]): RulesetEncounterState =>
  createRulesetEncounter({ definition: fiveE, seed: 3, combatants: [brenna(conditions), snag()], roller: dice(20, 1) });
const act = (state: RulesetEncounterState, choice: Omit<RulesetCombatChoice, "actorId">, ...faces: number[]) =>
  applyRulesetCombatChoice(fiveE, state, { actorId: "brenna", ...choice } as RulesetCombatChoice, dice(...faces));
const menu = (state: RulesetEncounterState) => rulesetCombatOptions(fiveE, state, "brenna");
const sword = (state: RulesetEncounterState) => menu(state).find((option) => option.label === "Longsword");

// ── Budgets and grants (Haste) ──
{
  const plain = fight([]);
  assert.equal(rulesetCombatant(plain, "brenna")!.budgets.haste, 0, "a budget of no count is empty");
  const hasted = fight(["quickened"]);
  assert.equal(rulesetCombatant(hasted, "brenna")!.budgets.haste, 1, "quickened fills it from the first turn");
  assert.ok(
    menu(hasted).some((option) => option.id === "standard:dash@haste"),
    "a dash on it",
  );
  assert.ok(!menu(plain).some((option) => option.id === "standard:dash@haste"), "and none without it");
  // The Attack action spends the action: two strikes, the second in hand.
  let state = hasted;
  const first = act(state, { optionId: sword(state)!.id, targetIds: ["snag"] }, 15, 4);
  state = first.state;
  assert.deepEqual(
    eventsOf(first.events, "budget").map((event) => event.budget),
    ["action"],
  );
  const second = act(state, { optionId: sword(state)!.id, targetIds: ["snag"] }, 15, 4);
  state = second.state;
  assert.deepEqual(eventsOf(second.events, "budget"), [], "the second strike is in hand");
  // With the action spent and nothing in hand, the haste action buys ONE more strike.
  const extra = sword(state)!;
  assert.equal(extra.budget, "haste");
  assert.equal(extra.oneStrike, true);
  const third = act(state, { optionId: extra.id, targetIds: ["snag"] }, 15, 4);
  state = third.state;
  assert.deepEqual(
    eventsOf(third.events, "budget").map((event) => event.budget),
    ["haste"],
  );
  assert.equal(rulesetCombatant(state, "brenna")!.strikesLeft, undefined, "no strike put in hand");
  assert.equal(sword(state), undefined, "and nothing left to attack with");
  // Next turn the haste action is back.
  state = act(state, { optionId: "end-turn", targetIds: [] }).state;
  state = applyRulesetCombatChoice(
    fiveE,
    state,
    { actorId: "snag", optionId: "end-turn", targetIds: [] },
    dice(),
  ).state;
  assert.equal(rulesetCombatant(state, "brenna")!.budgets.haste, 1);
}

// ── Exclusive budgets and a cap on attacks (Slow) ──
{
  let state = fight(["sluggish"]);
  const swing = act(state, { optionId: sword(state)!.id, targetIds: ["snag"] }, 15, 4);
  state = swing.state;
  assert.deepEqual(
    eventsOf(swing.events, "budget").map((event) => [event.budget, event.left]),
    [
      ["action", 0],
      ["bonus", 0],
    ],
    "the action spent empties the bonus action",
  );
  assert.equal(sword(state), undefined, "one attack a turn, whatever Extra Attack gives");
  // Dash is still there? No: it is on the action, which is spent. Nothing on the bonus action either.
  assert.ok(!menu(state).some((option) => option.budget === "bonus"));
}

// ── No reactions (Slow): a foe walking away is struck at by the fighter, not by a slowed one ──
{
  const walkAway = (conditions: string[]) => {
    const state = createRulesetEncounter({
      definition: fiveE,
      seed: 3,
      combatants: [brenna(conditions), snag()],
      roller: dice(20, 1),
      board: {
        grid: { width: 8, height: 1, tiles: [Array.from({ length: 8 }, () => "plains" as const)] },
        placements: { brenna: { x: 0, y: 0 }, snag: { x: 1, y: 0 } },
      },
    });
    const turned = act(state, { optionId: "end-turn", targetIds: [] }).state;
    return applyRulesetCombatChoice(
      fiveE,
      turned,
      { actorId: "snag", optionId: RULESET_MOVE_OPTION, targetIds: [], to: { x: 4, y: 0 } },
      dice(),
    ).state;
  };
  assert.equal(walkAway([]).window?.trigger.kind, "leaves-reach", "the fighter may strike");
  assert.equal(walkAway(["sluggish"]).window, undefined, "a slowed one may not");
}

// ── What a condition leaves behind (Haste's lethargy) ──
{
  // Quickened for one round: it ends at the end of Brenna's turn, and drained follows it.
  const state = createRulesetEncounter({
    definition: fiveE,
    seed: 3,
    combatants: [brenna(), snag()],
    roller: dice(20, 1),
  });
  const holder = rulesetCombatant(state, "brenna")!;
  holder.tracked.push({ condition: "quickened", rounds: 1 });
  const ended = act(state, { optionId: "end-turn", targetIds: [] });
  const conditions = eventsOf(ended.events, "condition").map((event) => [event.condition, event.active]);
  assert.deepEqual(
    conditions,
    [
      ["quickened", false],
      ["drained", true],
    ],
    "quickened ends and leaves drained",
  );
  assert.ok(rulesetCombatant(ended.state, "brenna")!.tracked.some((entry) => entry.condition === "drained"));
}

// ── The schema ──
{
  assert.match(
    refusal(
      variant((doc) => {
        withEconomy(doc);
        doc.combat.conditions.find((entry: { condition: string }) => entry.condition === "quickened").grants.budget =
          "focus";
      }),
    ),
    /Unknown budget "focus"/,
  );
  assert.match(
    refusal(
      variant((doc) => {
        withEconomy(doc);
        doc.combat.conditions.find(
          (entry: { condition: string }) => entry.condition === "quickened",
        ).onEnd.applies[0].condition = "weary";
      }),
    ),
    /Unknown condition "weary"/,
  );
  assert.match(
    refusal(
      variant((doc) => {
        withEconomy(doc);
        doc.combat.conditions.find((entry: { condition: string }) => entry.condition === "quickened").grants = {
          budget: "haste",
        };
      }),
    ),
    /A grant says what its budget may be spent on/,
  );
}

console.log("Ruleset combat economy: budgets, grants, exclusive budgets, a cap on attacks and what ends leave.");
