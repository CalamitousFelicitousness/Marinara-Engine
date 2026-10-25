// How much a fight may hold for the party that meets it (Capability API 1.793): each threat tier's
// `worth`, a budget per member by level and difficulty step, and how a crowd of opponents counts. The
// Game Master is told the budget, and the Engine brings invented opponents down a rung at a time while
// a fight is over it. A creature of a bestiary, or one that comes back, is counted and never changed.
import { GAME_DIFFICULTIES, type GameDifficulty } from "../combat-conditions.js";
import type { RulesetDefinition } from "../../schemas/ruleset.schema.js";

type Budget = NonNullable<NonNullable<NonNullable<RulesetDefinition["combat"]>["threat"]>["budget"]>;

/** A party member's level as the budget reads it: the sum of its `level` fields on the sheet. */
export function rulesetBudgetLevel(budget: Budget, fields: Record<string, unknown> | undefined) {
  return budget.level.reduce((sum, field) => {
    const value = Number(fields?.[field]);
    return sum + (Number.isFinite(value) && value > 0 ? value : 0);
  }, 0);
}

export interface RulesetEncounterBudget {
  /** The step this game's difficulty plays at, and what the party may meet at it. */
  step: { id: string; label: string };
  worth: number;
  /** What a fight with a boss in it may be worth: the next step up, or this one at the top. */
  bossWorth: number;
  members: number;
  levels: number[];
}

/** What a fight may be worth for a party of these levels at this game difficulty. Null when the
 *  ruleset has no budget, or nobody in the party has a level to read. */
export function rulesetEncounterBudget(
  definition: RulesetDefinition,
  levels: readonly number[],
  difficulty: GameDifficulty,
): RulesetEncounterBudget | null {
  const budget = definition.combat?.threat?.budget;
  const counted = levels.filter((level) => level > 0);
  if (!budget || counted.length === 0) return null;
  const said = budget.forGame?.[difficulty];
  const at = said
    ? budget.steps.findIndex((step) => step.id === said)
    : Math.min(GAME_DIFFICULTIES.indexOf(difficulty), budget.steps.length - 1);
  const index = at < 0 ? 0 : at;
  const row = (level: number) =>
    budget.byLevel.reduce((best, one) => (one.level <= level ? one : best), budget.byLevel[0]!);
  const sum = (step: number) => counted.reduce((total, level) => total + (row(level).worth[step] ?? 0), 0);
  return {
    step: { id: budget.steps[index]!.id, label: budget.steps[index]!.label },
    worth: sum(index),
    bossWorth: sum(Math.min(index + 1, budget.steps.length - 1)),
    members: counted.length,
    levels: counted,
  };
}

/** How many times its opponents' worth a fight counts for: the `crowd` row its number of opponents
 *  reaches, a row up for a party smaller than `smallParty` and a row down for one larger than
 *  `largeParty`. 1 with no `crowd`. */
export function rulesetCrowdTimes(definition: RulesetDefinition, opponents: number, members: number) {
  const budget = definition.combat?.threat?.budget;
  const crowd = budget?.crowd;
  if (!crowd || opponents <= 0) return 1;
  let index = -1;
  crowd.forEach((row, at) => {
    if (row.from <= opponents) index = at;
  });
  if (index < 0) return 1;
  if (budget.smallParty !== undefined && members < budget.smallParty) index = Math.min(crowd.length - 1, index + 1);
  if (budget.largeParty !== undefined && members > budget.largeParty) index = Math.max(0, index - 1);
  return crowd[index]!.times;
}

/** What opponents of these tiers are worth together, crowd counted. A tier this ruleset does not have,
 *  or one with no `worth`, counts nothing. */
export function rulesetFightWorth(
  definition: RulesetDefinition,
  tiers: ReadonlyArray<string | undefined>,
  members: number,
) {
  const scale = definition.combat?.threat?.tiers ?? [];
  const base = tiers.reduce((sum, id) => sum + (scale.find((tier) => tier.id === id)?.worth ?? 0), 0);
  return Math.round(base * rulesetCrowdTimes(definition, tiers.length, members));
}

/**
 * The tiers a fight's opponents are brought to so the fight is worth no more than `allowed`: the one
 * that may move and is worth the most goes a rung down, and again, until it fits or none can move.
 * One `kept` (a bestiary creature, one that comes back) is counted and never moved; nothing goes
 * below the lowest rung. The tiers come back as they were when the fight already fits.
 */
export function rulesetBudgetedTiers(
  definition: RulesetDefinition,
  foes: ReadonlyArray<{ tier: string | undefined; kept: boolean }>,
  allowed: number,
  members: number,
): { tiers: Array<string | undefined>; worth: { before: number; after: number } } {
  const scale = definition.combat?.threat?.tiers ?? [];
  const tiers = foes.map((foe) => foe.tier);
  const before = rulesetFightWorth(definition, tiers, members);
  let after = before;
  const rung = (id: string | undefined) => scale.findIndex((tier) => tier.id === id);
  while (after > allowed) {
    let pick = -1;
    foes.forEach((foe, index) => {
      const at = rung(tiers[index]);
      if (foe.kept || at <= 0) return;
      if (pick < 0 || (scale[at]!.worth ?? 0) > (scale[rung(tiers[pick])]!.worth ?? 0)) pick = index;
    });
    if (pick < 0) break;
    tiers[pick] = scale[rung(tiers[pick]) - 1]!.id;
    after = rulesetFightWorth(definition, tiers, members);
  }
  return { tiers, worth: { before, after } };
}
