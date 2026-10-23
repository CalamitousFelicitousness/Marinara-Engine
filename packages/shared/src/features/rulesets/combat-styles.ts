// Which combat styles a game on a ruleset may play (Capability API 1.379): `combat.styles`.
//
// A ruleset whose rules need a board (areas, reach, cover) loses them when its fights are played
// without one, so it may name the styles its games play. Everything here is pure and reads only the
// definition; a ruleset that names none allows every style, exactly as before.

import type { RulesetDefinition } from "../../schemas/ruleset.schema.js";
import type { GameCombatStyle } from "../../types/game.js";

/** The styles this ruleset allows, in its own order, or null when it allows every one. */
export function rulesetCombatStyles(definition: RulesetDefinition | null | undefined): readonly string[] | null {
  const styles = definition?.combat?.styles;
  return styles?.length ? styles : null;
}

/** Whether a game on this ruleset may play `style`. A game that names no style plays classic. */
export function rulesetAllowsCombatStyle(
  definition: RulesetDefinition | null | undefined,
  style: GameCombatStyle | null | undefined,
): boolean {
  const styles = rulesetCombatStyles(definition);
  return !styles || styles.includes(style || "classic");
}

/**
 * The style a game on this ruleset plays when `style` is what it saved: that style when the ruleset
 * allows it, otherwise the first style the ruleset lists that `known` has (a client passes the styles
 * it can draw), or simply the first it lists.
 */
export function rulesetCombatStyle(
  definition: RulesetDefinition | null | undefined,
  style: GameCombatStyle | null | undefined,
  known?: readonly string[],
): GameCombatStyle {
  const styles = rulesetCombatStyles(definition);
  const asked = style || "classic";
  if (!styles || styles.includes(asked)) return asked;
  return (known && styles.find((id) => known.includes(id))) ?? styles[0]!;
}
