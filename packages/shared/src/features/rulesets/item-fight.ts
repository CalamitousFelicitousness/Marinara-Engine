// A ruleset's items in the Engine's own fights (Classic and Tactical), for a ruleset that does not
// resolve its fights itself (#6905). A model used to guess what every item does when a fight began;
// one of the ruleset's items already says it in its `use`, so that is what the fight reads, on the
// same scale the combat bridge reads a catalog entry's numbers. An item of the ruleset that cannot be
// used is not offered, and the model only guesses for the items that are not the ruleset's.

import type { CombatItemEffect } from "../../types/combat-encounter.js";
import {
  gameInventoryFightEffects,
  gameInventoryNameKey,
  type GameInventoryFightLine,
} from "../../utils/game-inventory-stacks.js";
import { AVERAGE_AMOUNT_PER_POWER, averageAmount } from "./combat-bridge.js";
import { rulesetItemUseDoes, type RulesetItemBook, type RulesetItemBookEntry } from "./item-book.js";

/** The share of its maximum health that one typical hit takes in the Engine's own fights, whose
 *  combatants carry around 60 hit points and deal 11 to 15 a hit (see `carryHealthShare`). An item that
 *  heals or harms `AVERAGE_AMOUNT_PER_POWER` on average, as a basic weapon does, is one such hit. */
const TYPICAL_HIT_SHARE = 0.22;

/**
 * What one of the ruleset's items does in the Engine's own fights, from its `use`, under the name the
 * fight lists it by; null for an item those fights cannot use. A heal heals and an attack harms, by the
 * share of the target's maximum health its dice come to, with its damage type as the element; the
 * first condition it puts on becomes a status by the ruleset's own name, and a buff or debuff is that
 * status alone. An item used up is spent; one that is not stays. What the Engine's fights have no
 * place for (a roll to hit, a save, an area, temporary points, a pool restored) is left to the
 * description, as the combat bridge leaves it for a catalog entry.
 */
export function rulesetItemFightEffect(
  name: string,
  read: Pick<RulesetItemBookEntry, "entry" | "facts"> | undefined,
): CombatItemEffect | null {
  const use = read?.entry.item?.use;
  const said = read?.facts.use;
  // ponytail: an item that spends charges or asks a check first is left out of these fights, as the
  // bridge leaves out a skill whose cost it cannot charge; spending charges and rolling the gate here
  // is slice I8-2.
  if (!use || !said || use.charges !== undefined || use.gate) return null;
  const average = averageAmount(use.amount);
  const power =
    average === null
      ? undefined
      : Math.min(1, Math.max(0.05, Math.round((average / AVERAGE_AMOUNT_PER_POWER) * TYPICAL_HIT_SHARE * 100) / 100));
  const condition = said.applies?.[0];
  // Nothing the Engine could do: a heal with no amount, or an attack with neither harm nor a condition.
  if (use.kind === "heal" && power === undefined) return null;
  if (use.kind === "attack" && power === undefined && !condition) return null;
  const applied = use.applies?.[0];
  const rounds = applied && typeof applied.duration === "object" ? applied.duration.rounds : undefined;
  const helps = use.kind === "heal" || use.kind === "buff";
  return {
    name,
    target: use.targets ?? (helps ? "ally" : "enemy"),
    type: use.kind === "attack" ? (power === undefined ? "status" : "damage") : use.kind,
    description: rulesetItemUseDoes(said).join(", ") || name,
    ...(power !== undefined && (use.kind === "heal" || use.kind === "attack") ? { power } : {}),
    ...(use.damageType ? { element: use.damageType } : {}),
    ...(condition ? { status: { name: condition, emoji: helps ? "✨" : "💢", duration: rounds ?? 2 } } : {}),
    consumes: use.consumes === true,
    ruleset: true,
  };
}

/**
 * The items one of the Engine's fights offers, and what each does: the ruleset's own items by their
 * `use` (and not at all when they have none), and the rest by what a model guessed, while the ruleset
 * leaves Game Mode's own items on. A guess made for one of the ruleset's items is dropped, and so is
 * any guess that claims to be the ruleset's. Without a book (a game with no ruleset items) every item
 * is guessed at, as before.
 */
export function gameFightItems(
  lines: readonly GameInventoryFightLine[],
  book: Pick<RulesetItemBook, "itemOf"> | undefined,
  native: boolean,
  guessed: readonly CombatItemEffect[],
): { lines: GameInventoryFightLine[]; effects: CombatItemEffect[] } {
  const offered: GameInventoryFightLine[] = [];
  const worked: CombatItemEffect[] = [];
  for (const line of lines) {
    if (!line.item || !book) {
      if (native) offered.push(line);
      continue;
    }
    const effect = rulesetItemFightEffect(line.name, book.itemOf(line.item));
    if (!effect) continue;
    offered.push(line);
    worked.push(effect);
  }
  const theirs = new Set(lines.flatMap((line) => (line.item && book ? [gameInventoryNameKey(line.name)] : [])));
  const guesses = native
    ? guessed.filter((effect) => !effect.ruleset && !theirs.has(gameInventoryNameKey(effect.name)))
    : [];
  return {
    lines: offered,
    effects: [
      ...worked,
      ...gameInventoryFightEffects(
        offered.filter((line) => !line.item || !book),
        guesses,
      ),
    ],
  };
}
