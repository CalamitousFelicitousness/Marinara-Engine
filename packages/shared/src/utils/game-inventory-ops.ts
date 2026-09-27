/**
 * Every change to Game Mode's inventory as one operation, applied by one function.
 *
 * The inventory screen sends these to the server, and the server applies the Game Master's
 * `[inventory: ...]` tags as these too, so the stacks, the detailed inventory on the game state and
 * the journal are all worked out in one place and saved together. Pure: nothing here reads or
 * writes storage.
 */
import { z } from "zod";
import type { InventoryItem } from "../types/game-state.js";
import {
  GAME_INVENTORY_HOLDER_MAX_LENGTH,
  GAME_INVENTORY_MAX_QUANTITY,
  addToGameInventory,
  cleanGameInventoryHolder,
  gameInventoryBagKey,
  gameInventoryCount,
  gameInventoryNameKey,
  gameInventoryTotals,
  giveGameInventoryStack,
  mergeGameInventoryStacks,
  newGameInventoryStackId,
  renameGameInventoryStack,
  setGameInventoryStackQuantity,
  splitGameInventoryStack,
  swapGameInventoryStacks,
  takeFromGameInventory,
  type GameInventoryStack,
} from "./game-inventory-stacks.js";

/** The longest item name an operation carries. */
export const GAME_INVENTORY_NAME_MAX_LENGTH = 120;
/** The most operations one request applies. */
export const GAME_INVENTORY_MAX_OPS = 40;

const stackId = z.string().trim().min(1).max(80);
const itemName = z.string().trim().min(1).max(GAME_INVENTORY_NAME_MAX_LENGTH);
const holder = z.string().trim().min(1).max(GAME_INVENTORY_HOLDER_MAX_LENGTH);
const amount = z.number().int().min(1).max(GAME_INVENTORY_MAX_QUANTITY);

export const gameInventoryOpSchema = z.discriminatedUnion("op", [
  /** Into one bag by name: the player's when `holder` is absent. `log` writes "acquired" in the journal. */
  z
    .object({
      op: z.literal("add"),
      name: itemName,
      count: amount,
      holder: holder.optional(),
      log: z.boolean().optional(),
    })
    .strict(),
  /** Out by name, from one bag when `from` is given and otherwise the player's first. `as` is what the
   *  journal calls it; without it nothing is written there. Not held to one stack's bound. */
  z
    .object({
      op: z.literal("take"),
      name: itemName,
      count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      from: z.object({ holder: holder.optional() }).strict().optional(),
      as: z.enum(["lost", "used", "removed"]).optional(),
    })
    .strict(),
  /** One stack set to a count; 0 removes it. A smaller count is written in the journal as removed. */
  z
    .object({ op: z.literal("set"), id: stackId, quantity: z.number().int().min(0).max(GAME_INVENTORY_MAX_QUANTITY) })
    .strict(),
  z.object({ op: z.literal("split"), id: stackId, size: amount }).strict(),
  z.object({ op: z.literal("merge"), from: stackId, into: stackId }).strict(),
  z.object({ op: z.literal("rename"), id: stackId, name: itemName }).strict(),
  z.object({ op: z.literal("swap"), first: stackId, second: stackId }).strict(),
  /** Some or all of one stack (all of it without `count`) to another bag: the player's without `to`. */
  z.object({ op: z.literal("give"), id: stackId, to: holder.optional(), count: amount.optional() }).strict(),
]);

export type GameInventoryOp = z.infer<typeof gameInventoryOpSchema>;

export const gameInventoryOpsRequestSchema = z
  .object({
    chatId: z.string().trim().min(1).max(200),
    ops: z.array(gameInventoryOpSchema).min(1).max(GAME_INVENTORY_MAX_OPS),
  })
  .strict();

/** Why an operation changed nothing. */
export type GameInventoryOpRefusal = "missing-stack" | "none-held" | "refused";

export type GameInventoryOpResult =
  | {
      ok: true;
      /** The stack the operation left the item in: the one added to, the new half of a split, the
       *  stack a rename or a gift ended in. */
      id?: string;
      /** How many really moved: added, taken or given. */
      count?: number;
      /** How many of the item that bag holds afterwards (the party's total for a take from anyone). */
      now?: number;
    }
  | { ok: false; reason: GameInventoryOpRefusal };

export interface GameInventoryJournalEntry {
  item: string;
  action: "acquired" | "lost" | "used" | "removed";
  quantity: number;
}

/** A rename that went through, and whose bag the stack was in (absent for the player's own). */
export interface GameInventoryRename {
  from: string;
  to: string;
  holder?: string;
}

export interface GameInventoryOpsOutcome {
  stacks: GameInventoryStack[];
  results: GameInventoryOpResult[];
  journal: GameInventoryJournalEntry[];
  /** Renames that went through, oldest first, so the detailed inventory can keep an entry's notes. */
  renames: GameInventoryRename[];
}

/**
 * Every operation in order, each on the stacks the one before it left. One that cannot happen is
 * refused and changes nothing, and the rest still apply, the way the Game Master's sheet commands do.
 */
export function applyGameInventoryOps(
  stacks: GameInventoryStack[],
  ops: readonly GameInventoryOp[],
  newId?: () => string,
): GameInventoryOpsOutcome {
  let current = stacks;
  const results: GameInventoryOpResult[] = [];
  const journal: GameInventoryJournalEntry[] = [];
  const renames: GameInventoryRename[] = [];
  const makeId = () => (newId ? newId() : newGameInventoryStackId(current));
  const refuse = (reason: GameInventoryOpRefusal) => results.push({ ok: false, reason });
  const stackOf = (id: string) => current.find((stack) => stack.id === id);

  for (const op of ops) {
    switch (op.op) {
      case "add": {
        const bag = { holder: cleanGameInventoryHolder(op.holder) };
        const next = addToGameInventory(current, op.name, op.count, makeId, bag.holder);
        if (next === current) {
          refuse("refused");
          break;
        }
        current = next;
        const key = gameInventoryNameKey(op.name);
        const id = current.find(
          (stack) =>
            gameInventoryNameKey(stack.name) === key &&
            gameInventoryBagKey(stack.holder) === gameInventoryBagKey(bag.holder),
        )?.id;
        results.push({ ok: true, id, count: op.count, now: gameInventoryCount(current, op.name, bag) });
        if (op.log) journal.push({ item: op.name.trim(), action: "acquired", quantity: op.count });
        break;
      }
      case "take": {
        const from = op.from ? { holder: cleanGameInventoryHolder(op.from.holder) } : undefined;
        const taken = takeFromGameInventory(current, op.name, op.count, from);
        if (taken.taken === 0) {
          refuse("none-held");
          break;
        }
        current = taken.stacks;
        results.push({ ok: true, count: taken.taken, now: gameInventoryCount(current, op.name, from) });
        if (op.as) journal.push({ item: op.name.trim(), action: op.as, quantity: taken.taken });
        break;
      }
      case "set": {
        const stack = stackOf(op.id);
        if (!stack) {
          refuse("missing-stack");
          break;
        }
        current = setGameInventoryStackQuantity(current, op.id, op.quantity);
        const after = stackOf(op.id)?.quantity ?? 0;
        results.push({
          ok: true,
          ...(after > 0 ? { id: op.id } : {}),
          count: Math.abs(after - stack.quantity),
          now: after,
        });
        if (after < stack.quantity)
          journal.push({ item: stack.name, action: "removed", quantity: stack.quantity - after });
        break;
      }
      case "split": {
        const index = current.findIndex((stack) => stack.id === op.id);
        const next = splitGameInventoryStack(current, op.id, op.size, makeId);
        if (index < 0 || next === current) {
          refuse(index < 0 ? "missing-stack" : "refused");
          break;
        }
        current = next;
        results.push({ ok: true, id: current[index + 1]!.id, count: op.size });
        break;
      }
      case "merge": {
        const next = mergeGameInventoryStacks(current, op.from, op.into);
        if (next === current) {
          refuse(stackOf(op.from) && stackOf(op.into) ? "refused" : "missing-stack");
          break;
        }
        current = next;
        results.push({ ok: true, id: op.into });
        break;
      }
      case "rename": {
        const stack = stackOf(op.id);
        const renamed = stack ? renameGameInventoryStack(current, op.id, op.name) : null;
        if (!stack || !renamed) {
          refuse(stack ? "refused" : "missing-stack");
          break;
        }
        if (renamed.stacks !== current) {
          const to = renamed.stacks.find((entry) => entry.id === renamed.id)?.name ?? op.name;
          renames.push({ from: stack.name, to, ...(stack.holder ? { holder: stack.holder } : {}) });
        }
        current = renamed.stacks;
        results.push({ ok: true, id: renamed.id });
        break;
      }
      case "swap": {
        if (!stackOf(op.first) || !stackOf(op.second)) {
          refuse("missing-stack");
          break;
        }
        current = swapGameInventoryStacks(current, op.first, op.second);
        results.push({ ok: true });
        break;
      }
      case "give": {
        const stack = stackOf(op.id);
        const given = stack ? giveGameInventoryStack(current, op.id, op.to, op.count, makeId) : null;
        if (!stack || !given) {
          refuse(stack ? "refused" : "missing-stack");
          break;
        }
        current = given.stacks;
        const to = { holder: cleanGameInventoryHolder(op.to) };
        results.push({
          ok: true,
          id: given.id,
          count: op.count ?? stack.quantity,
          now: gameInventoryCount(current, stack.name, to),
        });
        break;
      }
    }
  }
  return { stacks: current, results, journal, renames };
}

/**
 * The detailed inventory on the game state, kept in step with the stacks: one entry per item, its
 * quantity what the player's own bag holds, since everything that reads it (the sheet, the trackers,
 * an encounter's prompt) reads it as the player's. Only the difference is applied, so an entry keeps
 * its description and where it is kept, and a rename of the item's only stack renames the entry
 * rather than starting a blank one. Returns the same array when nothing it tracks changed.
 */
export function followGameInventoryDetails(
  detailed: readonly InventoryItem[] | null | undefined,
  before: readonly GameInventoryStack[],
  after: readonly GameInventoryStack[],
  renames: readonly GameInventoryRename[] = [],
): InventoryItem[] {
  const source = Array.isArray(detailed) ? detailed : [];
  let items = source.slice();
  const totalsOf = (stacks: readonly GameInventoryStack[]) =>
    new Map(
      gameInventoryTotals(stacks.filter((stack) => gameInventoryBagKey(stack.holder) === "")).map((entry) => [
        gameInventoryNameKey(entry.name),
        entry,
      ]),
    );
  const beforeTotals = totalsOf(before);
  const afterTotals = totalsOf(after);
  const settled = new Set<string>();

  // A rename of a stack in the player's own bag that emptied the old name into a name the bag did not
  // hold renames the entry in place. A companion's rename is theirs, even when the player's bag
  // changes the same names in the same batch.
  for (const { from, to, holder } of renames) {
    if (gameInventoryBagKey(holder) !== "") continue;
    const fromKey = gameInventoryNameKey(from);
    const toKey = gameInventoryNameKey(to);
    const renamedTo = afterTotals.get(toKey);
    if (
      !renamedTo ||
      settled.has(fromKey) ||
      settled.has(toKey) ||
      !beforeTotals.has(fromKey) ||
      afterTotals.has(fromKey) ||
      beforeTotals.has(toKey)
    )
      continue;
    const index = items.findIndex((item) => gameInventoryNameKey(item.name) === fromKey);
    if (index < 0 || items.some((item) => gameInventoryNameKey(item.name) === toKey)) continue;
    items[index] = { ...items[index]!, name: renamedTo.name, quantity: renamedTo.quantity };
    settled.add(fromKey);
    settled.add(toKey);
  }

  for (const key of new Set([...beforeTotals.keys(), ...afterTotals.keys()])) {
    if (settled.has(key)) continue;
    const difference = (afterTotals.get(key)?.quantity ?? 0) - (beforeTotals.get(key)?.quantity ?? 0);
    if (difference > 0) {
      const index = items.findIndex((item) => gameInventoryNameKey(item.name) === key);
      if (index >= 0) items[index] = { ...items[index]!, quantity: items[index]!.quantity + difference };
      else
        items.push({ name: afterTotals.get(key)!.name, description: "", quantity: difference, location: "on_person" });
    } else if (difference < 0) {
      let left = -difference;
      items = items.flatMap((item) => {
        if (left === 0 || gameInventoryNameKey(item.name) !== key) return [item];
        const take = Math.min(left, item.quantity);
        left -= take;
        return item.quantity - take > 0 ? [{ ...item, quantity: item.quantity - take }] : [];
      });
    }
  }
  const unchanged =
    items.length === source.length &&
    items.every((item, index) => JSON.stringify(item) === JSON.stringify(source[index]));
  return unchanged ? (source as InventoryItem[]) : items;
}
