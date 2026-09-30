// Using one of a ruleset's items outside a fight: the Use button and the Game Master's
// `[inventory: action="use"]`.
//
// What the item's `use` does to its user lands on their sheet, with the Engine's dice: health given
// back, temporary points, a pool restored and the conditions it puts on. What it does to somebody
// else is left to the story, since outside a fight nobody else has a place on the board to be hit
// in: the item is still used, and the words say what it does. Either way it takes one off its stack
// or spends its charges, through the same write a fight uses.

import type { GameInventoryJournalEntry } from "../../utils/game-inventory-ops.js";
import type { GameInventoryStack } from "../../utils/game-inventory-stacks.js";
import type { RulesetDefinition, RulesetSheetBuild } from "../../schemas/ruleset.schema.js";
import { applyRulesetFightItemChanges } from "../ruleset-combat/ammo.js";
import { parseRulesetCombatDice } from "../ruleset-combat/dice.js";
import type { RulesetItemBookEntry } from "./item-book.js";
import { rulesetItemFacts, rulesetItemUseDoes } from "./item-book.js";
import { applyRulesetSheetOp, type RulesetLiveState, type RulesetSheetOp } from "./live-state.js";

/** Why an item could not be used. */
export type RulesetItemUseRefusal =
  /** No stack of that id in the bag. */
  | "no-stack"
  /** The stack is a plain item, or one of an item the ruleset no longer has. */
  | "not-ruleset-item"
  /** The item has no `use`. */
  | "no-use"
  /** It takes a slot or binds, and is not worn (and bound). */
  | "not-worn"
  /** None of its charges are left, or not as many as one use spends. */
  | "none-left";

/** One thing a use did to its user's sheet. */
export interface RulesetItemUsePart {
  kind: "heal" | "temporary" | "restore" | "condition";
  /** What was rolled and added up, for everything but a condition. */
  amount?: number;
  rolls?: number[];
  /** The pool's or the condition's label. */
  label?: string;
  /** The sheet's own words for where it now stands ("Grit 6/11"). */
  now?: string;
}

export interface RulesetItemUseSaid {
  user: string;
  item: string;
  parts: RulesetItemUsePart[];
  /** What it does to somebody else, which the Engine leaves to the story. */
  aimed?: string;
  /** What is left of it: how many in the stack, or its charges. */
  left: { count: number } | { charges: number; max: number };
}

export type RulesetItemUseOutcome =
  | {
      ok: true;
      stacks: GameInventoryStack[];
      journal: GameInventoryJournalEntry[];
      live: RulesetLiveState;
      said: RulesetItemUseSaid;
    }
  | { ok: false; reason: RulesetItemUseRefusal };

/**
 * Use the item on one stack, for whoever carries it. `live` is that character's stored live state and
 * `build` their sheet; `roll` throws one die of the given sides. Nothing is changed on a refusal.
 */
export function useRulesetItemOutsideFight(input: {
  definition: RulesetDefinition;
  itemOf: (ref: string) => RulesetItemBookEntry | undefined;
  stacks: readonly GameInventoryStack[];
  stackId: string;
  user: { name: string; build: RulesetSheetBuild; live: unknown };
  roll: (sides: number) => number;
}): RulesetItemUseOutcome {
  const { definition, stacks, user, roll } = input;
  const stack = stacks.find((each) => each.id === input.stackId);
  if (!stack) return { ok: false, reason: "no-stack" };
  const entry = stack.item ? input.itemOf(stack.item) : undefined;
  const item = entry?.entry.item;
  if (!stack.item || !item) return { ok: false, reason: "not-ruleset-item" };
  const use = item.use;
  if (!use) return { ok: false, reason: "no-use" };
  // Used while worn where it takes a slot or binds, as a fight uses it; worn means bound too there.
  const takesSlots = Object.values(item.slots ?? {}).some((count) => count > 0);
  if ((takesSlots && !stack.equipped) || (item.binds && !stack.bound)) return { ok: false, reason: "not-worn" };
  const facts = rulesetItemFacts(definition, item).use;
  const max = facts?.charges?.max;
  if (use.charges !== undefined) {
    if (max === undefined) return { ok: false, reason: "none-left" };
    const now = Math.min(max, stack.charges ?? max);
    if (now < use.charges) return { ok: false, reason: "none-left" };
  }

  // What it does to its user: a heal or a buff not aimed at the other side. Anything else is for
  // somebody else, and outside a fight that is the story's to tell.
  const onUser = (use.kind === "heal" || use.kind === "buff") && use.targets !== "enemy";
  let live = user.live;
  const parts: RulesetItemUsePart[] = [];
  const write = (op: RulesetSheetOp): string | undefined => {
    const result = applyRulesetSheetOp(definition, user.build, live, op);
    if (!result.ok) return undefined;
    live = result.live;
    return result.now;
  };
  const rolled = (amount: { dice?: string; flat?: number } | undefined) => {
    if (!amount) return null;
    const dice = amount.dice ? parseRulesetCombatDice(amount.dice) : null;
    if (!dice && amount.flat === undefined) return null;
    const rolls = Array.from({ length: dice?.count ?? 0 }, () => roll(dice!.sides));
    return {
      rolls,
      total: Math.max(0, rolls.reduce((sum, face) => sum + face, 0) + (dice?.flat ?? 0) + (amount.flat ?? 0)),
    };
  };
  if (onUser) {
    const health = definition.combat?.health ?? definition.battle?.health;
    // A pool's own words are only its numbers, so they are said with its name ("Grit 6/11").
    const named = (pool: string, now: string | undefined) =>
      now === undefined
        ? undefined
        : `${definition.sheet.live.pools.find((entry) => entry.id === pool)?.label ?? pool} ${now}`;
    const heal = use.kind === "heal" ? rolled(use.amount) : null;
    if (heal && health) {
      // A wound track clears one mark, as a heal in a fight does; a pool takes the amount.
      const now =
        "track" in health
          ? heal.total > 0
            ? write({ op: "damage", track: health.track, kind: "", amount: -1 })
            : undefined
          : heal.total > 0
            ? named(health.pool, write({ op: "restore", pool: health.pool, amount: heal.total }))
            : undefined;
      // Only what landed is said: a heal of nothing, or one the sheet refused, says nothing.
      if (now !== undefined) parts.push({ kind: "heal", amount: heal.total, rolls: heal.rolls, now });
    }
    const temporary = rolled(use.temporary);
    if (temporary && health && "pool" in health) {
      const now =
        temporary.total > 0
          ? named(health.pool, write({ op: "temp", pool: health.pool, amount: temporary.total }))
          : undefined;
      // A pool with no temporary buffer takes none.
      if (now !== undefined) parts.push({ kind: "temporary", amount: temporary.total, rolls: temporary.rolls, now });
    }
    const restore = use.restore ? rolled(use.restore.amount) : null;
    if (restore && use.restore) {
      const now =
        restore.total > 0 ? write({ op: "restore", pool: use.restore.pool, amount: restore.total }) : undefined;
      if (now !== undefined) {
        parts.push({
          kind: "restore",
          amount: restore.total,
          rolls: restore.rolls,
          label: facts?.restore?.pool ?? use.restore.pool,
          now,
        });
      }
    }
    for (const applies of use.applies ?? []) {
      if (!write({ op: "condition", condition: applies.condition, active: true })) continue;
      const label =
        definition.sheet.live.conditions.find((condition) => condition.id === applies.condition)?.label ??
        applies.condition;
      parts.push({ kind: "condition", label });
    }
  }

  // Spent the way a fight spends it, on the stack by its id.
  const charges =
    use.charges !== undefined && max !== undefined ? Math.min(max, stack.charges ?? max) - use.charges : undefined;
  const spent = applyRulesetFightItemChanges(stacks, [
    {
      stack: { id: stack.id, ref: stack.item, ...(stack.holder ? { holder: stack.holder } : {}) },
      name: stack.name,
      taken: use.consumes ? 1 : 0,
      ...(charges !== undefined ? { charges } : {}),
    },
  ]);
  if (!spent) return { ok: false, reason: "no-stack" };
  // Charges spent write no journal line of their own, so the use is said as one.
  const journal =
    spent.journal.length > 0 ? spent.journal : [{ item: stack.name, action: "used" as const, quantity: 1 }];
  const aimed = !onUser && facts ? rulesetItemUseDoes(facts).join(", ") : undefined;
  return {
    ok: true,
    stacks: spent.stacks,
    journal,
    live: live as RulesetLiveState,
    said: {
      user: user.name,
      item: entry.name,
      parts,
      ...(aimed ? { aimed } : {}),
      left:
        charges !== undefined && max !== undefined
          ? { charges, max }
          : { count: use.consumes ? stack.quantity - 1 : stack.quantity },
    },
  };
}

/** What happened, in one line for the Game Master: "Juno uses Poultice: heals 4 (Grit 6/11). 1 left." */
export function rulesetItemUseLine(said: RulesetItemUseSaid): string {
  const parts = said.parts.map((part) => {
    const now = part.now ? ` (${part.now})` : "";
    if (part.kind === "heal") return `heals ${part.amount}${now}`;
    if (part.kind === "temporary") return `${part.amount} temporary points${now}`;
    if (part.kind === "restore") return `restores ${part.amount} ${part.label}${now}`;
    return `${part.label}`;
  });
  const does = said.aimed
    ? `aimed at somebody else, so nothing was applied: ${said.aimed}`
    : parts.length > 0
      ? parts.join(", ")
      : "nothing changed";
  const left =
    "charges" in said.left
      ? `${said.left.charges} of ${said.left.max} charges left.`
      : said.left.count > 0
        ? `${said.left.count} left.`
        : "None left.";
  return `${said.user} uses ${said.item}: ${does}. ${left}`;
}
