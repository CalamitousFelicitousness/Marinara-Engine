// Using one of a ruleset's items outside a fight: the Use button and the Game Master's
// `[inventory: action="use"]`.
//
// What the item's `use` does to its user lands on their sheet, with the Engine's dice: health given
// back, temporary points, a pool restored and the conditions it puts on. What it does to somebody
// else is left to the story, since outside a fight nobody else has a place on the board to be hit
// in: the item is still used, and the words say what it does. Either way it takes one off its stack
// or spends its charges, through the same write a fight uses.

import type { GameInventoryJournalEntry } from "../../utils/game-inventory-ops.js";
import {
  gameInventoryBagKey,
  gameInventoryWearMet,
  gameInventoryWearNeeds,
  type GameInventoryStack,
} from "../../utils/game-inventory-stacks.js";
import type {
  RulesetCatalogItem,
  RulesetDefinition,
  RulesetItemRechargeRule,
  RulesetSheetBuild,
} from "../../schemas/ruleset.schema.js";
import { applyRulesetFightItemChanges } from "../ruleset-combat/ammo.js";
import { parseRulesetCombatDice, rulesetChargesStart, rulesetOwnUsesMax } from "../ruleset-combat/dice.js";
import { rulesetPoolMaxSuccesses } from "../../schemas/ruleset.schema.js";
import {
  rollRulesetCheckModifiers,
  rulesetCheckEffects,
  rulesetCheckRollMode,
  rulesetCheckSources,
  rulesetItemGateCheck,
  rulesetTierAddsProficiency,
} from "./check-effects.js";
import type { RulesetItemBookEntry } from "./item-book.js";
import { rulesetItemFacts, rulesetItemGateDifficulty, rulesetItemUseDoes, rulesetSheetItems } from "./item-book.js";
import {
  applyRulesetSheetOp,
  evaluateRulesetSheetLive,
  raiseRulesetLiveAbilities,
  readRulesetLive,
  readRulesetWoundPenalty,
  type RulesetLiveState,
  type RulesetSheetOp,
} from "./live-state.js";
import {
  resolveRulesetValueRef,
  rulesetSymbolPoolRatings,
  rollSymbolPoolCheck,
  rollDiceHighestCheck,
  rollDicePoolCheck,
  rollDiceSumCheck,
} from "./sheet-math.js";

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
  | "none-left"
  /** A condition its user holds forbids using it (1.472): Feeblemind's magic items. */
  | "forbidden";

/** One thing a use did to its user's sheet. */
export interface RulesetItemUsePart {
  kind: "heal" | "temporary" | "restore" | "condition" | "raise";
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
  /** What is left of it: how many in the stack, its charges, or the uses of its own (1.466). */
  left: { count: number } | { charges: number; max: number } | { uses: number; max: number };
  /** It spent its last charge and its `breaksOn` die said it breaks: the face rolled. */
  broke?: number;
  /** It spent its last charge and its `breaksOn` die gave some back (1.271): the face, and how many. */
  recharged?: { roll: number; amount: number };
  /** It spent its last charge and became another item (1.272): that item's name, and the face. */
  becomes?: { name: string; roll: number };
  /** Its gate, when its user rolled one: what was rolled, the total (a pool's successes) against the
   *  difficulty, and whether it passed. Failed, nothing it does happened. */
  gate?: { check: string; total: number; difficulty: number; success: boolean; rolls: number[] };
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
  /** One of its further uses (1.267), by its place in `moreUses` from 1; its first use without it. */
  more?: number;
}): RulesetItemUseOutcome {
  const { definition, stacks, user, roll } = input;
  const stack = stacks.find((each) => each.id === input.stackId);
  if (!stack) return { ok: false, reason: "no-stack" };
  const entry = stack.item ? input.itemOf(stack.item) : undefined;
  const item = entry?.entry.item;
  if (!stack.item || !item) return { ok: false, reason: "not-ruleset-item" };
  // One of its further uses, as its own menu choice in a fight is (1.267).
  const chosen = input.more !== undefined ? item.moreUses?.[input.more - 1] : undefined;
  if (input.more !== undefined && (!chosen || !item.use)) return { ok: false, reason: "no-use" };
  const use = chosen?.use ?? item.use;
  if (!use) return { ok: false, reason: "no-use" };
  // Used while worn where it takes a slot or binds, as a fight uses it; worn means bound too there.
  if (!gameInventoryWearMet(stack, gameInventoryWearNeeds(item))) return { ok: false, reason: "not-worn" };
  // Nor while a condition they hold forbids it (1.472), as a fight keeps it off the menu.
  const holding = readRulesetLive(definition, user.build, user.live).conditions.filter((one) => one.active);
  const forbidding = (definition.combat?.conditions ?? []).some(
    (entry) =>
      !!entry.forbids?.items &&
      holding.some((one) => one.id === entry.condition) &&
      (!entry.forbids.items.tags || entry.forbids.items.tags.some((tag) => item.tags?.includes(tag))),
  );
  if (forbidding) return { ok: false, reason: "forbidden" };
  const facts = rulesetItemFacts(definition, chosen ? { ...item, use } : item).use;
  const max = facts?.charges?.max;
  if (use.charges !== undefined) {
    if (max === undefined) return { ok: false, reason: "none-left" };
    // A stack found with rolled charges (1.520) holds that many until something changes them.
    const now = Math.min(max, stack.charges ?? rulesetChargesStart(facts!.charges!, max, stack.id));
    if (now < use.charges) return { ok: false, reason: "none-left" };
  }
  // Its own uses (1.466), kept on the stack by its place.
  const own = chosen?.uses;
  // Its most, rolled for this stack where it is (1.483).
  const ownMax = own ? rulesetOwnUsesMax(own, stack.id, input.more!) : undefined;
  const ownNow = own ? Math.min(ownMax!, stack.usesLeft?.[String(input.more)] ?? ownMax!) : undefined;
  if (ownNow !== undefined && ownNow < 1) return { ok: false, reason: "none-left" };

  // Its gate first, as a fight rolls it once the item is spent: failed, the item is spent below and
  // nothing it does happens. A difficulty read off a stat the item does not give is a use the Engine
  // cannot make, as a fight leaves it off the menu.
  const gate = rollRulesetItemGate({ ...input, holder: stack.holder, item });
  if (gate === undefined) return { ok: false, reason: "no-use" };
  const works = gate?.success !== false;

  // What it does to its user: a heal or a buff not aimed at the other side. Anything else is for
  // somebody else, and outside a fight that is the story's to tell.
  const onUser = works && (use.kind === "heal" || use.kind === "buff") && use.targets !== "enemy";
  let live = user.live;
  const parts: RulesetItemUsePart[] = [];
  const sheetValue = (ref: Parameters<typeof resolveRulesetValueRef>[2]) =>
    Math.trunc(
      resolveRulesetValueRef(
        definition,
        user.build,
        ref,
        evaluateRulesetSheetLive(
          definition,
          user.build,
          live,
          rulesetSheetItems({ itemOf: input.itemOf }, stacks, stack.holder),
        ),
      ),
    );
  const sheetWithin = (bounds: NonNullable<NonNullable<typeof use.applies>[number]["when"]>) => {
    const held = rulesetSheetItems({ itemOf: input.itemOf }, stacks, stack.holder);
    const value = resolveRulesetValueRef(
      definition,
      user.build,
      bounds.value,
      evaluateRulesetSheetLive(definition, user.build, live, held),
    );
    return (
      (bounds.atLeast === undefined || value >= bounds.atLeast) &&
      (bounds.atMost === undefined || value <= bounds.atMost)
    );
  };
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
    const healed = use.kind === "heal" ? rolled(use.amount) : null;
    // What its holder's sheet adds (1.271): a Staff of Healing's spellcasting modifier.
    const added = healed && use.amountAdd ? sheetValue(use.amountAdd) : 0;
    const heal = healed ? { ...healed, total: Math.max(0, healed.total + (Number.isFinite(added) ? added : 0)) } : null;
    if (heal && health) {
      // A wound track clears one mark, as a heal in a fight does; a pool takes the amount.
      const now =
        "track" in health
          ? heal.total > 0
            ? write({ op: "damage", track: health.track, kind: "", amount: -1 })
            : undefined
          : heal.total > 0
            ? named(
                health.pool,
                write({
                  op: "restore",
                  pool: health.pool,
                  amount: heal.total,
                  // A potion tagged magical is a magical heal (1.261), as its use in a fight is.
                  ...(item.tags?.includes("magical") ? { magical: true as const } : {}),
                }),
              )
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
    // Abilities raised for good (1.463): a manual read, a tome studied.
    if (use.raises) {
      live = raiseRulesetLiveAbilities(live, use.raises);
      const scores = evaluateRulesetSheetLive(definition, user.build, live).abilityScores;
      for (const [id, raise] of Object.entries(use.raises)) {
        const ability = definition.sheet.abilities.find((entry) => entry.id === id);
        parts.push({ kind: "raise", amount: raise.by, label: ability?.label ?? id, now: String(scores[id]) });
      }
    }
    for (const applies of use.applies ?? []) {
      // Read off the user as it applies (1.167), what came before it included.
      if (applies.when && !sheetWithin(applies.when)) continue;
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
  // The last charge spent: an item that may break rolls for it, as it would in a fight.
  const breaks = charges === 0 ? item.charges?.breaksOn : undefined;
  const face = breaks ? roll(breaks.die) : undefined;
  // A high face gives charges back instead (1.271), as it would in a fight.
  const regained =
    breaks?.regains && face !== undefined && face >= breaks.regains.atLeast ? rolled(breaks.regains.amount) : null;
  const recharged = regained && max !== undefined ? { roll: face!, amount: Math.min(max, regained.total) } : undefined;
  const cracked =
    !recharged && breaks?.atMost !== undefined && face !== undefined && face <= breaks.atMost ? face : undefined;
  // Or it becomes another item instead (1.272).
  const turnsInto = cracked !== undefined && breaks?.becomes ? input.itemOf(breaks.becomes) : undefined;
  const becomes = turnsInto && breaks?.becomes ? { ref: breaks.becomes, name: turnsInto.name } : undefined;
  const broke = becomes ? undefined : cracked;
  const after = recharged ? recharged.amount : charges;
  const spent = applyRulesetFightItemChanges(stacks, [
    {
      stack: { id: stack.id, ref: stack.item, ...(stack.holder ? { holder: stack.holder } : {}) },
      name: stack.name,
      taken: use.consumes || broke !== undefined ? 1 : 0,
      ...(after !== undefined ? { charges: after } : {}),
      ...(ownNow !== undefined ? { usesLeft: { [String(input.more)]: ownNow - 1 } } : {}),
      ...(broke !== undefined ? { broke: true as const } : {}),
      ...(becomes ? { becomes } : {}),
    },
  ]);
  if (!spent) return { ok: false, reason: "no-stack" };
  // Charges spent write no journal line of their own, so the use is said as one.
  const journal =
    spent.journal.length > 0 ? spent.journal : [{ item: stack.name, action: "used" as const, quantity: 1 }];
  const aimed = works && !onUser && facts ? rulesetItemUseDoes(facts).join(", ") : undefined;
  return {
    ok: true,
    stacks: spent.stacks,
    journal,
    live: live as RulesetLiveState,
    said: {
      user: user.name,
      item: chosen ? `${entry.name}: ${chosen.label}` : entry.name,
      parts,
      ...(aimed ? { aimed } : {}),
      ...(broke !== undefined ? { broke } : {}),
      ...(recharged ? { recharged } : {}),
      ...(becomes ? { becomes: { name: becomes.name, roll: cracked! } } : {}),
      ...(gate ? { gate } : {}),
      left:
        ownNow !== undefined && own
          ? { uses: ownNow - 1, max: ownMax! }
          : after !== undefined && max !== undefined
            ? { charges: after, max }
            : { count: use.consumes ? stack.quantity - 1 : stack.quantity },
    },
  };
}

/**
 * The check one of the ruleset's items asks before it works (`gate`), rolled for its user as a check
 * is outside a fight: from the Use button, and when the item is used in the Engine's own Classic and
 * Tactical battles (#6909), which have no dice of the ruleset's own. Null when the item asks none, or
 * its `unless` holds; undefined when its difficulty is read off a stat the item does not give, a use
 * the Engine cannot make. `holder` is the bag whose worn items count toward the check.
 */
export function rollRulesetItemGate(input: {
  definition: RulesetDefinition;
  itemOf: (ref: string) => RulesetItemBookEntry | undefined;
  stacks: readonly GameInventoryStack[];
  holder: string | undefined;
  item: RulesetCatalogItem;
  user: { build: RulesetSheetBuild; live: unknown };
  roll: (sides: number) => number;
}): RulesetItemUseSaid["gate"] | null | undefined {
  const { definition, item, user } = input;
  const gate = item.use?.gate;
  if (!gate) return null;
  const difficulty = rulesetItemGateDifficulty(item, gate);
  if (difficulty === undefined) return undefined;
  const held = rulesetSheetItems({ itemOf: input.itemOf }, input.stacks, input.holder);
  const evaluated = evaluateRulesetSheetLive(definition, user.build, user.live, held);
  const ask = rulesetItemGateCheck(definition, user.build, evaluated, gate, difficulty);
  if (!ask) return null;
  const check = rulesetItemFacts(definition, item).use?.gate?.check ?? "";
  return { check, ...rollGateOutsideFight(definition, user, held, ask, input.roll) };
}

/** A gate rolled as a check is outside a fight: the ruleset's own dice with the sheet's number, the
 *  user's wound penalty and what their conditions and items do to that check, and the lean they give
 *  it. A pool's difficulty is the successes it needs, never fewer than one nor more than it can count. */
function rollGateOutsideFight(
  definition: RulesetDefinition,
  user: { build: RulesetSheetBuild; live: unknown },
  held: ReturnType<typeof rulesetSheetItems>,
  ask: NonNullable<ReturnType<typeof rulesetItemGateCheck>>,
  roll: (sides: number) => number,
): Omit<NonNullable<RulesetItemUseSaid["gate"]>, "check"> {
  const resolution = definition.resolution;
  // The sheet as it stands, for what a change reads off it (1.376).
  const evaluated = evaluateRulesetSheetLive(definition, user.build, user.live, held);
  const trained =
    ask.target?.type === "skill" && rulesetTierAddsProficiency(definition, evaluated.skillTiers[ask.target.id]);
  const effects = rulesetCheckEffects(
    rulesetCheckSources(definition, user.build, user.live, held),
    ask.target,
    trained,
  );
  const penalty = resolution.penaltyFrom
    ? readRulesetWoundPenalty(definition, user.build, user.live, resolution.penaltyFrom)
    : 0;
  const modifier =
    ask.modifier +
    penalty +
    rollRulesetCheckModifiers(effects.modifiers, roll, (ref) =>
      resolveRulesetValueRef(definition, user.build, ref, evaluated),
    ).total;
  if (resolution.kind === "dice-pool") {
    const required = Math.min(rulesetPoolMaxSuccesses(resolution), Math.max(1, ask.difficulty));
    const rolled = rollDicePoolCheck(definition, { modifier, required, isSave: false }, roll);
    return { total: rolled.total, difficulty: required, success: rolled.success, rolls: rolled.rolls };
  }
  if (resolution.kind === "dice-highest") {
    const dc = Math.min(resolution.keep * resolution.die.sides, Math.max(1, ask.difficulty));
    const rolled = rollDiceHighestCheck(definition, { modifier, dc, isSave: false }, roll);
    return { total: rolled.total, difficulty: dc, success: rolled.success, rolls: rolled.rolls };
  }
  if (resolution.kind === "symbol-pool") {
    const ratings = rulesetSymbolPoolRatings(
      definition,
      evaluateRulesetSheetLive(definition, user.build, user.live, held),
      ask.target,
    );
    const difficulty = Math.min(resolution.difficulty.max, Math.max(0, ask.difficulty));
    const rolled = rollSymbolPoolCheck(
      definition,
      {
        ...ratings,
        difficulty,
        isSave: false,
        bonusDice: modifier - ratings.ability - ratings.rank,
      },
      roll,
    );
    return { total: rolled.total, difficulty, success: rolled.success, rolls: rolled.rolls };
  }
  const mode = rulesetCheckRollMode({}, effects);
  const rolled = rollDiceSumCheck(
    definition,
    {
      modifier,
      dc: ask.difficulty,
      isSave: false,
      advantage: mode === "advantage",
      disadvantage: mode === "disadvantage",
    },
    roll,
  );
  return { total: rolled.total, difficulty: ask.difficulty, success: rolled.success, rolls: rolled.rolls };
}

/** What happened, in one line for the Game Master: "Juno uses Poultice: heals 4 (Grit 6/11). 1 left." */
export function rulesetItemUseLine(said: RulesetItemUseSaid): string {
  const parts = said.parts.map((part) => {
    const now = part.now ? ` (${part.now})` : "";
    if (part.kind === "heal") return `heals ${part.amount}${now}`;
    if (part.kind === "temporary") return `${part.amount} temporary points${now}`;
    if (part.kind === "restore") return `restores ${part.amount} ${part.label}${now}`;
    if (part.kind === "raise") return `raises ${part.label} by ${part.amount} for good${now}`;
    return `${part.label}`;
  });
  const gate = said.gate
    ? `${said.gate.check} check ${said.gate.total} against ${said.gate.difficulty}, ${said.gate.success ? "passed" : "failed"}; `
    : "";
  const does =
    said.gate?.success === false
      ? "it is used up for nothing"
      : said.aimed
        ? `aimed at somebody else, so nothing was applied: ${said.aimed}`
        : parts.length > 0
          ? parts.join(", ")
          : "nothing changed";
  const left =
    said.broke !== undefined
      ? `Its last charge spent, it breaks (a ${said.broke} on its die).`
      : said.becomes
        ? `Its last charge spent, it becomes ${said.becomes.name} (a ${said.becomes.roll} on its die).`
        : said.recharged
          ? `Its last charge spent, it gets ${said.recharged.amount} back (a ${said.recharged.roll} on its die).`
          : "charges" in said.left
            ? `${said.left.charges} of ${said.left.max} charges left.`
            : "uses" in said.left
              ? `${said.left.uses} of ${said.left.max} uses of it left.`
              : said.left.count > 0
                ? `${said.left.count} left.`
                : "None left.";
  return `${said.user} uses ${said.item}: ${gate}${does}. ${left}`;
}

/** What a rest gave back to one item. */
export interface RulesetItemRecharge {
  item: string;
  now: number;
  max: number;
  /** A further use's own uses (1.466), not the item's charges. */
  uses?: true;
}

/**
 * The charges a rest brings back to the items one character carries: each item in their bag whose
 * `charges.recharge` names that rest regains all of them (`"max"`) or an amount rolled with `roll`,
 * never past its most. A full item is left alone, and a count back at its most is dropped from the
 * stack, which reads as full. `holder` is the bag's, absent for the player's own.
 */
export function rechargeRulesetItems(input: {
  definition: RulesetDefinition;
  itemOf: (ref: string) => RulesetItemBookEntry | undefined;
  stacks: readonly GameInventoryStack[];
  holder: string | undefined;
  rest: string;
  roll: (sides: number) => number;
}): { stacks: GameInventoryStack[]; recharged: RulesetItemRecharge[] } {
  const bag = gameInventoryBagKey(input.holder);
  const recharged: RulesetItemRecharge[] = [];
  const stacks = input.stacks.map((stack) => {
    if (!stack.item || gameInventoryBagKey(stack.holder) !== bag) return stack;
    const entry = input.itemOf(stack.item);
    const item = entry?.entry.item;
    if (!item) return stack;
    const gain = (amount: "max" | { dice?: string; flat?: number }, max: number) => {
      if (amount === "max") return max;
      const dice = amount.dice ? parseRulesetCombatDice(amount.dice) : null;
      const rolls = Array.from({ length: dice?.count ?? 0 }, () => input.roll(dice!.sides));
      return rolls.reduce((sum, face) => sum + face, 0) + (dice?.flat ?? 0) + (amount.flat ?? 0);
    };
    let next = stack;
    // Each further use's own uses (1.466), on the rests its own recharge names.
    item.moreUses?.forEach((more, n) => {
      const own = more.uses;
      const key = String(n + 1);
      if (!own?.recharge?.rests.includes(input.rest)) return;
      // Back to its stack's own count, rolled where it is (1.483).
      const most = rulesetOwnUsesMax(own, stack.id, n + 1);
      const before = Math.min(most, next.usesLeft?.[key] ?? most);
      if (before >= most) return;
      const now = Math.max(before, Math.min(most, before + gain(own.recharge.amount, most)));
      if (now === before) return;
      recharged.push({ item: `${entry!.name}: ${more.label}`, now, max: most, uses: true });
      const { [key]: _was, ...others } = next.usesLeft ?? {};
      const usesLeft = now >= most ? others : { ...others, [key]: now };
      const { usesLeft: _usesLeft, ...plain } = next;
      next = Object.keys(usesLeft).length > 0 ? { ...plain, usesLeft } : plain;
    });
    // And each hit's own uses (1.481), under "h" and its place among the spends.
    item.attack?.spends?.forEach((spend, n) => {
      const own = spend.uses;
      const key = `h${n + 1}`;
      if (!own?.recharge?.rests.includes(input.rest)) return;
      const before = Math.min(own.max, next.usesLeft?.[key] ?? own.max);
      if (before >= own.max) return;
      const now = Math.max(before, Math.min(own.max, before + gain(own.recharge.amount, own.max)));
      if (now === before) return;
      recharged.push({ item: `${entry!.name}: ${spend.label}`, now, max: own.max, uses: true });
      const { [key]: _was, ...others } = next.usesLeft ?? {};
      const usesLeft = now >= own.max ? others : { ...others, [key]: now };
      const { usesLeft: _usesLeft, ...plain } = next;
      next = Object.keys(usesLeft).length > 0 ? { ...plain, usesLeft } : plain;
    });
    const recharge = item.charges?.recharge;
    if (!recharge?.rests.includes(input.rest)) return next;
    const facts = rulesetItemFacts(input.definition, item).use?.charges;
    const max = facts?.max;
    if (max === undefined) return next;
    const before = Math.min(max, next.charges ?? rulesetChargesStart(facts!, max, next.id));
    if (before >= max) return next;
    const now = Math.max(before, Math.min(max, before + gain(recharge.amount, max)));
    if (now === before) return next;
    recharged.push({ item: entry!.name, now, max });
    const { charges: _charges, ...rest } = withoutOveruse(next);
    return now >= max ? rest : { ...rest, charges: now };
  });
  return { stacks: recharged.length > 0 ? stacks : [...input.stacks], recharged };
}

/** A stack whose charges came back counts its uses on none from nothing again (1.571). */
function withoutOveruse(stack: GameInventoryStack): GameInventoryStack {
  if (stack.usesLeft?.o === undefined) return stack;
  const { o: _o, ...others } = stack.usesLeft;
  const { usesLeft: _usesLeft, ...plain } = stack;
  return Object.keys(others).length > 0 ? { ...plain, usesLeft: others } : plain;
}

/** How long a wait counted in game time runs, in minutes (1.503), its hours rolled where they are
 *  dice. */
function rulesetItemWaitMinutes(
  after: NonNullable<RulesetItemRechargeRule["after"]>,
  roll: (sides: number) => number,
): number {
  const dice = after.hours?.dice ? parseRulesetCombatDice(after.hours.dice) : null;
  const hours =
    Array.from({ length: dice?.count ?? 0 }, () => roll(dice!.sides)).reduce((sum, face) => sum + face, 0) +
    (dice?.flat ?? 0) +
    (after.hours?.flat ?? 0);
  return Math.max(1, (after.days ?? 0) * 24 * 60 + Math.max(0, hours) * 60);
}

/**
 * What `minutes` of game time passing brings back to the items in every bag (1.503): charges, or a
 * use's own uses, whose `recharge` comes back `after` a wait. A count run out starts waiting the first
 * time game time passes, its wait rolled then; once it has waited it all, it gets back its `amount`
 * (all of them for `"max"`). A count that is no longer out (a rest or the Game Master gave some
 * back) waits no more.
 */
export function passRulesetItemTime(input: {
  definition: RulesetDefinition;
  itemOf: (ref: string) => RulesetItemBookEntry | undefined;
  stacks: readonly GameInventoryStack[];
  minutes: number;
  roll: (sides: number) => number;
}): { stacks: GameInventoryStack[]; recharged: RulesetItemRecharge[]; changed: boolean } {
  const recharged: RulesetItemRecharge[] = [];
  let changed = false;
  const minutes = Math.max(0, Math.floor(input.minutes));
  const stacks = input.stacks.map((stack) => {
    if (!stack.item || stack.quantity !== 1) return stack;
    const entry = input.itemOf(stack.item);
    const item = entry?.entry.item;
    if (!item) return stack;
    const counts: Array<{ key: string; rule: RulesetItemRechargeRule; max: number; label: string; uses?: true }> = [];
    const charges = item.charges?.recharge;
    const chargesMax = rulesetItemFacts(input.definition, item).use?.charges?.max;
    if (charges?.after && chargesMax !== undefined)
      counts.push({ key: "charges", rule: charges, max: chargesMax, label: entry!.name });
    item.moreUses?.forEach((more, n) => {
      if (more.uses?.recharge?.after)
        counts.push({
          key: String(n + 1),
          rule: more.uses.recharge,
          max: rulesetOwnUsesMax(more.uses, stack.id, n + 1),
          label: `${entry!.name}: ${more.label}`,
          uses: true,
        });
    });
    item.attack?.spends?.forEach((spend, n) => {
      if (spend.uses?.recharge?.after)
        counts.push({
          key: `h${n + 1}`,
          rule: spend.uses.recharge,
          max: spend.uses.max,
          label: `${entry!.name}: ${spend.label}`,
          uses: true,
        });
    });
    if (counts.length === 0 && !stack.waits) return stack;
    let next = stack;
    const waits = { ...(stack.waits ?? {}) };
    // What its call still keeps out past a fight (1.559): a wait from its departure starts after it.
    const roundSeconds = input.definition.combat?.roundSeconds;
    const outRounds = stack.callRoll?.outRounds ?? 0;
    const stayMinutes = roundSeconds && outRounds > 0 ? Math.ceil((outRounds * roundSeconds) / 60) : 0;
    const stayed = Math.min(stayMinutes, minutes);
    if (stayMinutes > 0) {
      const { outRounds: _out, ...rest } = next.callRoll ?? {};
      const left = Math.ceil(((stayMinutes - stayed) * 60) / roundSeconds!);
      const callRoll = left > 0 ? { ...rest, outRounds: left } : rest;
      const { callRoll: _was, ...plain } = next;
      next = Object.keys(callRoll).length > 0 ? { ...plain, callRoll } : plain;
    }
    for (const count of counts) {
      const left = Math.min(
        count.max,
        (count.key === "charges" ? next.charges : next.usesLeft?.[count.key]) ?? count.max,
      );
      if (left > 0) {
        delete waits[count.key];
        continue;
      }
      const wait = waits[count.key] ?? { waited: 0, for: rulesetItemWaitMinutes(count.rule.after!, input.roll) };
      // Counted only from the departure of what it called (1.559).
      const passing = count.rule.after?.fromDeparture ? minutes - stayed : minutes;
      if (passing <= 0) continue;
      const waited = Math.min(wait.for, wait.waited + passing);
      if (waited < wait.for) {
        waits[count.key] = { waited, for: wait.for };
        continue;
      }
      delete waits[count.key];
      const amount = count.rule.amount;
      const dice = amount !== "max" && amount.dice ? parseRulesetCombatDice(amount.dice) : null;
      const gained =
        amount === "max"
          ? count.max
          : Array.from({ length: dice?.count ?? 0 }, () => input.roll(dice!.sides)).reduce(
              (sum, face) => sum + face,
              0,
            ) +
            (dice?.flat ?? 0) +
            (amount.flat ?? 0);
      const now = Math.max(0, Math.min(count.max, gained));
      if (now === 0) continue;
      recharged.push({ item: count.label, now, max: count.max, ...(count.uses ? { uses: true as const } : {}) });
      if (count.key === "charges") {
        const { charges: _charges, ...rest } = withoutOveruse(next);
        next = now >= count.max ? rest : { ...rest, charges: now };
      } else {
        const { [count.key]: _was, ...others } = next.usesLeft ?? {};
        const usesLeft = now >= count.max ? others : { ...others, [count.key]: now };
        const { usesLeft: _usesLeft, ...plain } = next;
        next = Object.keys(usesLeft).length > 0 ? { ...plain, usesLeft } : plain;
      }
    }
    // Only what still waits, and only on what has a wait.
    for (const key of Object.keys(waits)) if (!counts.some((count) => count.key === key)) delete waits[key];
    const { waits: _waits, ...plain } = next;
    const after = Object.keys(waits).length > 0 ? { ...plain, waits } : plain;
    if (JSON.stringify(after) === JSON.stringify(stack)) return stack;
    changed = true;
    return after;
  });
  return { stacks: changed ? stacks : [...input.stacks], recharged, changed };
}

/** What a rest gave back, in words for the Game Master: "Dawn bell regains its charges (3 of 3)". */
export function rulesetItemRechargeLine(recharged: readonly RulesetItemRecharge[]): string {
  return recharged
    .map((entry) => `${entry.item} regains ${entry.uses ? "uses" : "charges"} (${entry.now} of ${entry.max})`)
    .join(", ");
}
