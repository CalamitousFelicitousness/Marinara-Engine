import type { CombatMind } from "../combat-minds.js";
import type { RulesetDefinition } from "../../schemas/ruleset.schema.js";
import { rulesetAbilityScore, rulesetCreatureKind } from "./encounter.js";
import type { RulesetCombatant } from "./types.js";

/**
 * How much thought a combatant puts into a fight (Capability API 1.708), as its own data says: its
 * stat block's `mind`, else its type's (`combat.creatureTypes.types[].mind`), else the tier its
 * `combat.minds` ability score reaches. One that takes legendary actions or has Legendary Resistance
 * is a `genius` where it would be `tactical`. A ruleset that says nothing of minds still knows an
 * animal and a thing that never thinks by the type ids every bestiary uses for them. Undefined when
 * nothing says, and the combatant is played as it always was.
 */
export function rulesetCombatantMind(
  definition: RulesetDefinition,
  combatant: RulesetCombatant,
): CombatMind | undefined {
  const own = combatant.block?.mind;
  if (own) return own;
  const kind = rulesetCreatureKind(definition, combatant);
  const types = definition.combat?.creatureTypes?.types ?? [];
  const typed = kind.type !== undefined ? types.find((one) => one.id === kind.type)?.mind : undefined;
  if (typed) return typed;
  const minds = definition.combat?.minds;
  const score = minds ? rulesetAbilityScore(definition, combatant, minds.ability) : undefined;
  let reached: CombatMind | undefined;
  if (minds && score !== undefined) for (const tier of minds.tiers) if (score >= tier.atLeast) reached = tier.mind;
  if (reached === undefined && !types.some((one) => one.mind) && kind.type !== undefined) {
    const id = kind.type.toLowerCase();
    if (id === "beast" || id === "animal") reached = "instinct";
    else if (id === "construct" || id === "ooze") reached = "mindless";
  }
  const legendary =
    combatant.block?.legendaryResistance !== undefined ||
    combatant.signature !== undefined ||
    combatant.actions.some((action) => action.signature !== undefined);
  if (reached === "tactical" && legendary) return "genius";
  return reached;
}
