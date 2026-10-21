import type { CombatMind, CombatRole } from "../combat-minds.js";
import type { RulesetCombatBehavior, RulesetDefinition } from "../../schemas/ruleset.schema.js";
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

/**
 * How a combatant goes about a fight (Capability API 1.710), as its own data says: the ruleset's
 * `combat.behavior`, its type's over that, and its stat block's over both, each key on its own.
 * Undefined when nothing says.
 */
export function rulesetCombatantBehavior(
  definition: RulesetDefinition,
  combatant: RulesetCombatant,
): RulesetCombatBehavior | undefined {
  const kind = rulesetCreatureKind(definition, combatant);
  const typed =
    kind.type !== undefined
      ? definition.combat?.creatureTypes?.types.find((one) => one.id === kind.type)?.behavior
      : undefined;
  const layers = [definition.combat?.behavior, typed, combatant.block?.behavior].filter(
    (one): one is RulesetCombatBehavior => !!one,
  );
  return layers.length > 0 ? Object.assign({}, ...layers) : undefined;
}

/**
 * Whether an action is a spell, as far as a fight can tell: cast with words, gestures or things
 * (`components`), innately, from an item that casts, or held by concentration. A class feature (Second
 * Wind), a creature's own blow and a torch lit are none of these.
 */
export function rulesetActionIsSpell(action: RulesetCombatant["actions"][number]): boolean {
  return (
    !!action.components?.length ||
    !!action.innate ||
    action.castLevel !== undefined ||
    !!action.casts ||
    !!action.concentration
  );
}

/**
 * What a combatant is for in a fight, read off what it can do, for one whose data names no `role`:
 * one that heals others a `supporter`, one with spells that only put things on people a
 * `controller`, one with spells a `spellcaster`, one whose best blow is a shot a `marksman`, a hard
 * one to hit a `bulwark`, and anybody else a `bruiser`.
 */
export function rulesetCombatantRole(combatant: RulesetCombatant): CombatRole {
  // Not what a condition would give it: those are on every list, offered only while held, and are no
  // part of what it is (5e's Potion of Animal Friendship would make everybody a controller).
  const actions = combatant.actions.filter((action) => !action.whileHolds);
  if (actions.some((action) => action.heal && action.targets.side !== "self")) return "supporter";
  const spells = actions.filter(rulesetActionIsSpell);
  if (spells.length > 0)
    return spells.filter((action) => action.applies?.length && !action.damage).length * 2 >= spells.length
      ? "controller"
      : "spellcaster";
  const average = (action: (typeof actions)[number]) =>
    action.damage ? action.damage.count * ((action.damage.sides + 1) / 2) + action.damage.flat : 0;
  const best = [...actions].filter((action) => action.damage).sort((a, b) => average(b) - average(a))[0];
  if (best?.range && !best.reach) return "marksman";
  if ((combatant.defense ?? 0) >= 17) return "bulwark";
  return "bruiser";
}
