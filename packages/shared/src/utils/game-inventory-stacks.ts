/**
 * Game Mode's inventory as stacks.
 *
 * The inventory is a list of stacks, and two stacks may hold the same item: a player can split 300
 * apples into 200 and 100, and both stay apart until the player merges them again. So every stack
 * has an id, and everything that points at ONE stack (the inventory screen) uses it. What names an
 * ITEM instead (the Game Master's `[inventory: ...]` tag, a fight spending one) goes through the
 * named operations below, which read every stack of that name.
 *
 * Every stack is in somebody's bag. `holder` names the party member who carries it, as their card
 * names them; a stack without one is the player's own, which is every stack saved before there were
 * bags. The whole list is the shared view, so a bag is simply the stacks with one holder.
 *
 * Every function is pure and returns the same array when nothing changed, so a caller can tell a
 * refused change from an accepted one by reference.
 */

import { normalizeCharacterLookupName } from "./character-lookup-name.js";

export interface GameInventoryStack {
  id: string;
  name: string;
  quantity: number;
  /** The party member who carries it. Absent for the player's own character. */
  holder?: string;
}

/** Whose bag: `holder` as a stack has it, so `{}` is the player's own. */
export interface GameInventoryBagRef {
  holder?: string;
}

/** The longest holder name kept, as long as any name a card may have. */
export const GAME_INVENTORY_HOLDER_MAX_LENGTH = 80;

/** The most one stack may hold. Far past any real pile, and small enough to stay an exact integer
 *  through every sum a screen or a prompt makes of it. */
export const GAME_INVENTORY_MAX_QUANTITY = 999_999;

/** The one spelling two stacks are compared by: trimmed, single-spaced, any case. */
export function gameInventoryNameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** A holder as it is kept: cleaned, and absent for nobody in particular. */
export function cleanGameInventoryHolder(holder: unknown): string | undefined {
  if (typeof holder !== "string") return undefined;
  const cleaned = cleanName(holder).slice(0, GAME_INVENTORY_HOLDER_MAX_LENGTH);
  return cleaned || undefined;
}

/** The key two bags are compared by, matched the way a `who=` is: case and accents aside. The
 *  player's own bag is the empty key. */
export function gameInventoryBagKey(holder: string | undefined): string {
  return holder ? normalizeCharacterLookupName(holder) : "";
}

function inBag(stack: GameInventoryStack, bag: GameInventoryBagRef): boolean {
  return gameInventoryBagKey(stack.holder) === gameInventoryBagKey(bag.holder);
}

function withHolder<T extends GameInventoryStack>(stack: T, holder: string | undefined): T {
  const { holder: _dropped, ...rest } = stack;
  return (holder ? { ...rest, holder } : rest) as T;
}

function clampQuantity(quantity: number): number {
  return Math.max(0, Math.min(GAME_INVENTORY_MAX_QUANTITY, Math.floor(quantity)));
}

function slug(name: string): string {
  const dashed = gameInventoryNameKey(name).replace(/[^a-z0-9]+/g, "-");
  // Leading and trailing dashes are trimmed by walking in from each end, not by an anchored pattern,
  // which could backtrack over a long run of dashes in a name the player typed.
  let start = 0;
  let end = dashed.length;
  while (start < end && dashed[start] === "-") start += 1;
  while (end > start && dashed[end - 1] === "-") end -= 1;
  return dashed.slice(start, Math.min(end, start + 40)) || "item";
}

/** A fresh id no stack in `stacks` has. */
export function newGameInventoryStackId(stacks: readonly { id?: string }[]): string {
  const taken = new Set(stacks.map((stack) => stack.id));
  for (;;) {
    const id = `st-${Math.random().toString(36).slice(2, 10)}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * Stacks as they are stored, read tolerantly. An entry with no name is dropped, and a quantity that
 * is missing, broken or below one reads as one, as it always has.
 *
 * An entry saved before stacks had ids gets one here, worked out from its name and how many entries
 * of that name came before it. The same saved list therefore reads with the same ids every time,
 * which keeps a selection on screen across a reload, and the id is stored with the next change.
 */
export function normalizeGameInventoryStacks(raw: unknown): GameInventoryStack[] {
  if (!Array.isArray(raw)) return [];
  const entries = raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const source = entry as Record<string, unknown>;
    const name = typeof source.name === "string" ? cleanName(source.name) : "";
    if (!name) return [];
    const parsed =
      typeof source.quantity === "number" ? source.quantity : Number.parseInt(String(source.quantity ?? ""), 10);
    const quantity =
      Number.isFinite(parsed) && parsed > 0 ? Math.min(GAME_INVENTORY_MAX_QUANTITY, Math.floor(parsed)) : 1;
    const stored = typeof source.id === "string" ? source.id.trim() : "";
    return [{ name, quantity, stored, holder: cleanGameInventoryHolder(source.holder) }];
  });
  // Every stored id is reserved before any is worked out, so an entry saved without one can never
  // take the id of a stack saved after it. A stored id that repeats is kept by its first holder only.
  const used = new Set<string>();
  const keeps = entries.map((entry) => {
    if (!entry.stored || used.has(entry.stored)) return false;
    used.add(entry.stored);
    return true;
  });
  const seenByName = new Map<string, number>();
  return entries.map((entry, index) => {
    const key = gameInventoryNameKey(entry.name);
    const occurrence = seenByName.get(key) ?? 0;
    seenByName.set(key, occurrence + 1);
    const holder = entry.holder ? { holder: entry.holder } : {};
    if (keeps[index]) return { id: entry.stored, name: entry.name, quantity: entry.quantity, ...holder };
    let id = `st-${slug(entry.name)}-${occurrence}`;
    while (used.has(id)) id = `${id}-x`;
    used.add(id);
    return { id, name: entry.name, quantity: entry.quantity, ...holder };
  });
}

/** One line per item: every stack of a name added together, in the order the names first appear.
 *  What the Game Master and a fight read, since a split is the player's own arrangement. */
export function gameInventoryTotals(stacks: readonly GameInventoryStack[]): Array<{ name: string; quantity: number }> {
  const totals = new Map<string, { name: string; quantity: number }>();
  for (const stack of stacks) {
    const key = gameInventoryNameKey(stack.name);
    const existing = totals.get(key);
    if (existing) existing.quantity += stack.quantity;
    else totals.set(key, { name: stack.name, quantity: stack.quantity });
  }
  return [...totals.values()];
}

/** Each bag's own totals, the player's first and then in the order a holder first appears. Only bags
 *  that hold something are listed. */
export function gameInventoryBags(
  stacks: readonly GameInventoryStack[],
): Array<{ holder?: string; items: Array<{ name: string; quantity: number }> }> {
  const bags = new Map<string, { holder?: string; stacks: GameInventoryStack[] }>([["", { stacks: [] }]]);
  for (const stack of stacks) {
    const key = gameInventoryBagKey(stack.holder);
    const bag = bags.get(key) ?? { ...(stack.holder ? { holder: stack.holder } : {}), stacks: [] };
    bag.stacks.push(stack);
    bags.set(key, bag);
  }
  return [...bags.values()]
    .filter((bag) => bag.stacks.length > 0)
    .map((bag) => ({ ...(bag.holder ? { holder: bag.holder } : {}), items: gameInventoryTotals(bag.stacks) }));
}

/** How many of an item there are, across all its stacks, or in one bag's. */
export function gameInventoryCount(
  stacks: readonly GameInventoryStack[],
  name: string,
  from?: GameInventoryBagRef,
): number {
  const key = gameInventoryNameKey(name);
  return stacks.reduce(
    (total, stack) =>
      total + (gameInventoryNameKey(stack.name) === key && (!from || inBag(stack, from)) ? stack.quantity : 0),
    0,
  );
}

/**
 * Adding by name into one bag (the player's when `holder` is absent): onto that bag's first stack of
 * the name, or a new stack at the end when it has none. What the first stack cannot hold starts a new
 * stack at the end, so nothing added is ever lost. One addition is at most one stack's worth; a count
 * past that, or one that is not a number, is refused and changes nothing.
 */
export function addToGameInventory(
  stacks: GameInventoryStack[],
  name: string,
  count: number,
  newId?: () => string,
  holder?: string,
): GameInventoryStack[] {
  const cleaned = cleanName(name);
  if (!cleaned || !Number.isFinite(count)) return stacks;
  const amount = Math.floor(count);
  if (amount < 1 || amount > GAME_INVENTORY_MAX_QUANTITY) return stacks;
  const makeId = newId ?? (() => newGameInventoryStackId(stacks));
  const bag = { holder: cleanGameInventoryHolder(holder) };
  const fresh = (stackName: string, quantity: number) =>
    withHolder({ id: makeId(), name: stackName, quantity }, bag.holder);
  const key = gameInventoryNameKey(cleaned);
  const index = stacks.findIndex((stack) => gameInventoryNameKey(stack.name) === key && inBag(stack, bag));
  if (index < 0) return [...stacks, fresh(cleaned, amount)];
  const target = stacks[index]!;
  const topUp = Math.min(Math.max(0, GAME_INVENTORY_MAX_QUANTITY - target.quantity), amount);
  const next =
    topUp > 0
      ? stacks.map((stack, i) => (i === index ? { ...stack, quantity: stack.quantity + topUp } : stack))
      : stacks;
  return amount > topUp ? [...next, fresh(target.name, amount - topUp)] : next;
}

/**
 * Taking by name: from the stacks of that name top to bottom until `count` is met, removing each one
 * it empties. With `from`, only that bag's stacks; without, the player's own bag first and then the
 * rest of the party's, top to bottom. Asking for more than there is takes all of it; `taken` says how
 * many really went.
 */
export function takeFromGameInventory(
  stacks: GameInventoryStack[],
  name: string,
  count: number,
  from?: GameInventoryBagRef,
): { stacks: GameInventoryStack[]; taken: number } {
  const key = gameInventoryNameKey(name);
  // Not held to one stack's bound: the stacks of an item together may hold more than one stack can.
  let left = Number.isFinite(count) ? Math.floor(count) : 0;
  if (!key || left < 1) return { stacks, taken: 0 };
  const matches = (stack: GameInventoryStack) =>
    gameInventoryNameKey(stack.name) === key && (!from || inBag(stack, from));
  // The order stacks are taken in: the player's own first when no bag is named.
  const order = stacks
    .map((stack, index) => ({ stack, index }))
    .filter(({ stack }) => matches(stack))
    .sort(
      (a, b) => (from ? 0 : Number(Boolean(a.stack.holder)) - Number(Boolean(b.stack.holder))) || a.index - b.index,
    );
  const takeAt = new Map<number, number>();
  let taken = 0;
  for (const { stack, index } of order) {
    if (left < 1) break;
    const take = Math.min(left, stack.quantity);
    left -= take;
    taken += take;
    takeAt.set(index, take);
  }
  if (taken === 0) return { stacks, taken: 0 };
  const next = stacks.flatMap((stack, index) => {
    const take = takeAt.get(index) ?? 0;
    if (take === 0) return [stack];
    return stack.quantity - take > 0 ? [{ ...stack, quantity: stack.quantity - take }] : [];
  });
  return { stacks: next, taken };
}

/**
 * Some or all of one stack handed to another party member (`to` absent for the player): taken off
 * that stack and added to their bag as any addition is, onto their first stack of the item. Giving
 * to the bag it is already in, or a count that is not from 1 to the stack's size, changes nothing.
 * `id` is the stack that received it, so a screen can follow it.
 */
export function giveGameInventoryStack(
  stacks: GameInventoryStack[],
  id: string,
  to: string | undefined,
  count?: number,
  newId?: () => string,
): { stacks: GameInventoryStack[]; id: string } | null {
  const source = stacks.find((stack) => stack.id === id);
  if (!source) return null;
  const amount = count === undefined ? source.quantity : count;
  if (!Number.isInteger(amount) || amount < 1 || amount > source.quantity) return null;
  const receiver = { holder: cleanGameInventoryHolder(to) };
  if (inBag(source, receiver)) return { stacks, id };
  const makeId = newId ?? (() => newGameInventoryStackId(stacks));
  const rest =
    amount === source.quantity
      ? stacks.filter((stack) => stack.id !== id)
      : stacks.map((stack) => (stack.id === id ? { ...stack, quantity: stack.quantity - amount } : stack));
  const key = gameInventoryNameKey(source.name);
  const existing = rest.find((stack) => gameInventoryNameKey(stack.name) === key && inBag(stack, receiver));
  // A whole stack given to somebody with none of it keeps its id, so a selection follows it.
  if (!existing && amount === source.quantity) {
    const index = stacks.findIndex((stack) => stack.id === id);
    return {
      stacks: stacks.map((stack, i) => (i === index ? withHolder(stack, receiver.holder) : stack)),
      id,
    };
  }
  const next = addToGameInventory(rest, source.name, amount, makeId, receiver.holder);
  if (next === rest) return null;
  const received = next.find((stack) => gameInventoryNameKey(stack.name) === key && inBag(stack, receiver));
  return received ? { stacks: next, id: received.id } : null;
}

/** Two stacks trading places, wherever they are in the list. */
export function swapGameInventoryStacks(
  stacks: GameInventoryStack[],
  firstId: string,
  secondId: string,
): GameInventoryStack[] {
  const first = stacks.findIndex((stack) => stack.id === firstId);
  const second = stacks.findIndex((stack) => stack.id === secondId);
  if (first < 0 || second < 0 || first === second) return stacks;
  const next = stacks.slice();
  [next[first], next[second]] = [next[second]!, next[first]!];
  return next;
}

/** One stack set to a count. Zero removes it; anything else stays inside one stack's bound. */
export function setGameInventoryStackQuantity(
  stacks: GameInventoryStack[],
  id: string,
  quantity: number,
): GameInventoryStack[] {
  const index = stacks.findIndex((stack) => stack.id === id);
  if (index < 0 || !Number.isFinite(quantity)) return stacks;
  const next = clampQuantity(quantity);
  if (next === stacks[index]!.quantity) return stacks;
  if (next === 0) return stacks.filter((_, i) => i !== index);
  return stacks.map((stack, i) => (i === index ? { ...stack, quantity: next } : stack));
}

/**
 * Part of a stack moved into a new stack right after it. The size has to leave something behind and
 * move something, so it is at least one and less than the stack; anything else changes nothing. The
 * total never changes.
 */
export function splitGameInventoryStack(
  stacks: GameInventoryStack[],
  id: string,
  size: number,
  newId: () => string = () => newGameInventoryStackId(stacks),
): GameInventoryStack[] {
  const index = stacks.findIndex((stack) => stack.id === id);
  if (index < 0 || !Number.isInteger(size)) return stacks;
  const stack = stacks[index]!;
  if (size < 1 || size >= stack.quantity) return stacks;
  return [
    ...stacks.slice(0, index),
    { ...stack, quantity: stack.quantity - size },
    { ...stack, id: newId(), quantity: size },
    ...stacks.slice(index + 1),
  ];
}

/** One stack poured into another of the same item, which keeps its place and its bag, so pouring into
 *  a stack in somebody else's bag hands it over. Two different items never merge, and a stack never
 *  merges into itself. A merge that would pass one stack's bound is refused. */
export function mergeGameInventoryStacks(
  stacks: GameInventoryStack[],
  fromId: string,
  intoId: string,
): GameInventoryStack[] {
  if (fromId === intoId) return stacks;
  const from = stacks.find((stack) => stack.id === fromId);
  const into = stacks.find((stack) => stack.id === intoId);
  if (!from || !into || gameInventoryNameKey(from.name) !== gameInventoryNameKey(into.name)) return stacks;
  if (from.quantity + into.quantity > GAME_INVENTORY_MAX_QUANTITY) return stacks;
  return stacks
    .filter((stack) => stack.id !== fromId)
    .map((stack) => (stack.id === intoId ? { ...stack, quantity: stack.quantity + from.quantity } : stack));
}

/**
 * One stack renamed. Renaming it to an item its bag already has pours it into that bag's first stack
 * of the item, exactly as renaming did before stacks could be split. `id` is the stack that holds the
 * result, so a screen can keep it selected.
 */
export function renameGameInventoryStack(
  stacks: GameInventoryStack[],
  id: string,
  nextName: string,
): { stacks: GameInventoryStack[]; id: string } | null {
  const cleaned = cleanName(nextName);
  const source = stacks.find((stack) => stack.id === id);
  if (!source || !cleaned) return null;
  if (source.name === cleaned) return { stacks, id };
  const key = gameInventoryNameKey(cleaned);
  const target = stacks.find(
    (stack) => stack.id !== id && gameInventoryNameKey(stack.name) === key && inBag(stack, source),
  );
  if (!target || gameInventoryNameKey(source.name) === key) {
    return { stacks: stacks.map((stack) => (stack.id === id ? { ...stack, name: cleaned } : stack)), id };
  }
  if (target.quantity + source.quantity > GAME_INVENTORY_MAX_QUANTITY) return null;
  return {
    stacks: stacks
      .filter((stack) => stack.id !== id)
      .map((stack) => (stack.id === target.id ? { ...stack, quantity: stack.quantity + source.quantity } : stack)),
    id: target.id,
  };
}

/**
 * The inventory a new session starts with: every stack the last one ended with, ids, splits and bags
 * kept, plus anything the detailed inventory on its last game state names that no stack holds, which
 * goes to the player.
 */
export function carryGameInventory(gameInventory: unknown, detailedInventory: unknown): GameInventoryStack[] {
  let stacks = normalizeGameInventoryStacks(gameInventory);
  // Read against the stacks as saved, so two detailed entries of a name no stack holds both count.
  const held = new Set(stacks.map((stack) => gameInventoryNameKey(stack.name)));
  for (const item of normalizeGameInventoryStacks(detailedInventory)) {
    if (!held.has(gameInventoryNameKey(item.name))) stacks = addToGameInventory(stacks, item.name, item.quantity);
  }
  return stacks;
}
