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
  GAME_INVENTORY_NAME_MAX_LENGTH,
  addToGameInventoryNamed,
  cleanGameInventoryHolder,
  gameInventoryBagKey,
  gameInventoryCount,
  gameInventoryItemId,
  gameInventoryNameKey,
  gameInventoryStackLabel,
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

/** The most operations one request applies. */
export const GAME_INVENTORY_MAX_OPS = 40;

const stackId = z.string().trim().min(1).max(80);
const itemName = z.string().trim().min(1).max(GAME_INVENTORY_NAME_MAX_LENGTH);
const holder = z.string().trim().min(1).max(GAME_INVENTORY_HOLDER_MAX_LENGTH);
const amount = z.number().int().min(1).max(GAME_INVENTORY_MAX_QUANTITY);

export const gameInventoryOpSchema = z.discriminatedUnion("op", [
  /** Into one bag by name, onto the item that name finds (a new one when it finds none): the player's
   *  bag when `holder` is absent. `log` writes "acquired" in the journal. */
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
  /** One stack's nickname; the item's own name clears it. */
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

export interface GameInventoryOpsOutcome {
  stacks: GameInventoryStack[];
  results: GameInventoryOpResult[];
  journal: GameInventoryJournalEntry[];
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
  const makeId = () => (newId ? newId() : newGameInventoryStackId(current));
  const refuse = (reason: GameInventoryOpRefusal) => results.push({ ok: false, reason });
  const stackOf = (id: string) => current.find((stack) => stack.id === id);

  for (const op of ops) {
    switch (op.op) {
      case "add": {
        const bag = { holder: cleanGameInventoryHolder(op.holder) };
        const added = addToGameInventoryNamed(current, op.name, op.count, makeId, bag.holder);
        if (!added) {
          refuse("refused");
          break;
        }
        current = added.stacks;
        // How many of the item it went onto the bag now holds: the name may have found that item by
        // a nickname in another bag, which the bag's own count by name would not see.
        const item = gameInventoryItemId(current.find((stack) => stack.id === added.id)!);
        const now = current
          .filter(
            (stack) =>
              gameInventoryItemId(stack) === item &&
              gameInventoryBagKey(stack.holder) === gameInventoryBagKey(bag.holder),
          )
          .reduce((total, stack) => total + stack.quantity, 0);
        results.push({ ok: true, id: added.id, count: op.count, now });
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
          journal.push({ item: gameInventoryStackLabel(stack), action: "removed", quantity: stack.quantity - after });
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
  return { stacks: current, results, journal };
}

/**
 * The detailed inventory on the game state, kept in step with the stacks: one entry per item, its
 * quantity what the player's own bag holds, since everything that reads it (the sheet, the trackers,
 * an encounter's prompt) reads it as the player's. Entries follow items, not names: each carries the
 * id of the item it follows (`item`), so a rename only changes the name an entry shows, and an entry
 * keeps its description and where it is kept through a rename or a gift. An entry written without an
 * id (by a tracker, or before entries had them) is matched by name once and then keeps one. Only the
 * difference is applied. Returns the same array when nothing it tracks changed.
 */
export function followGameInventoryDetails(
  detailed: readonly InventoryItem[] | null | undefined,
  before: readonly GameInventoryStack[],
  after: readonly GameInventoryStack[],
): InventoryItem[] {
  const source = Array.isArray(detailed) ? detailed : [];
  let items = source.slice();
  /** The player's own bag, one line per item: how many, and the names its first stack goes by. */
  const ownItems = (stacks: readonly GameInventoryStack[]) => {
    const lines = new Map<string, { quantity: number; label: string; own: string }>();
    for (const stack of stacks) {
      if (gameInventoryBagKey(stack.holder) !== "") continue;
      const item = gameInventoryItemId(stack);
      const line = lines.get(item);
      if (line) line.quantity += stack.quantity;
      else lines.set(item, { quantity: stack.quantity, label: gameInventoryStackLabel(stack), own: stack.name });
    }
    return lines;
  };
  const was = ownItems(before);
  const now = ownItems(after);

  for (const item of new Set([...was.keys(), ...now.keys()])) {
    const then = was.get(item);
    const current = now.get(item);
    const difference = (current?.quantity ?? 0) - (then?.quantity ?? 0);
    if (difference === 0 && then?.label === current?.label) continue;
    // The entries this item has: those carrying its id, or, for one written without an id, its name
    // as the item was or is shown, or its own name.
    const names = new Set(
      [then?.label, then?.own, current?.label, current?.own].flatMap((name) =>
        name ? [gameInventoryNameKey(name)] : [],
      ),
    );
    const follows = (entry: InventoryItem) =>
      entry.item === item || (entry.item === undefined && names.has(gameInventoryNameKey(entry.name)));
    const shown = current?.label;
    if (difference >= 0) {
      const carried = items.findIndex((entry) => entry.item === item);
      const index = carried >= 0 ? carried : items.findIndex(follows);
      if (index >= 0) {
        const entry = items[index]!;
        items[index] = { ...entry, item, name: shown ?? entry.name, quantity: entry.quantity + difference };
      } else if (difference > 0) {
        items.push({ item, name: shown!, description: "", quantity: difference, location: "on_person" });
      }
      continue;
    }
    // Taken from the entries that carry the item's id first, then from ones found by name, and only
    // the entries something was taken from change.
    let left = -difference;
    const takeAt = new Map<number, number>();
    for (const drains of [(entry: InventoryItem) => entry.item === item, follows]) {
      items.forEach((entry, index) => {
        if (left < 1 || takeAt.has(index) || !drains(entry)) return;
        const take = Math.min(left, entry.quantity);
        left -= take;
        takeAt.set(index, take);
      });
    }
    items = items.flatMap((entry, index) => {
      const take = takeAt.get(index);
      if (take === undefined) return [entry];
      const rest = entry.quantity - take;
      return rest > 0 ? [{ ...entry, item, name: shown ?? entry.name, quantity: rest }] : [];
    });
  }
  const unchanged =
    items.length === source.length &&
    items.every((item, index) => JSON.stringify(item) === JSON.stringify(source[index]));
  return unchanged ? (source as InventoryItem[]) : items;
}
