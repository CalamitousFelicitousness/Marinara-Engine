/**
 * Game Mode's inventory as stacks.
 *
 * The inventory is a list of stacks, and two stacks may hold the same item: a player can split 300
 * apples into 200 and 100, and both stay apart until the player merges them again. So every stack
 * has an id, and everything that points at ONE stack (the inventory screen) uses it. What names an
 * ITEM instead (the Game Master's `[inventory: ...]` tag, a fight spending one) goes through the
 * named operations below, which read every stack of that name.
 *
 * Every function is pure and returns the same array when nothing changed, so a caller can tell a
 * refused change from an accepted one by reference.
 */

export interface GameInventoryStack {
  id: string;
  name: string;
  quantity: number;
}

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

function clampQuantity(quantity: number): number {
  return Math.max(0, Math.min(GAME_INVENTORY_MAX_QUANTITY, Math.floor(quantity)));
}

function slug(name: string): string {
  return (
    gameInventoryNameKey(name)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "item"
  );
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
    return [{ name, quantity, stored }];
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
    if (keeps[index]) return { id: entry.stored, name: entry.name, quantity: entry.quantity };
    let id = `st-${slug(entry.name)}-${occurrence}`;
    while (used.has(id)) id = `${id}-x`;
    used.add(id);
    return { id, name: entry.name, quantity: entry.quantity };
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

/** How many of an item there are, across all its stacks. */
export function gameInventoryCount(stacks: readonly GameInventoryStack[], name: string): number {
  const key = gameInventoryNameKey(name);
  return stacks.reduce((total, stack) => total + (gameInventoryNameKey(stack.name) === key ? stack.quantity : 0), 0);
}

/**
 * Adding by name: onto the first stack of that name, or a new stack at the end when there is none.
 * What the first stack cannot hold starts a new stack at the end, so nothing added is ever lost. One
 * addition is at most one stack's worth; a count past that, or one that is not a number, is refused
 * and changes nothing.
 */
export function addToGameInventory(
  stacks: GameInventoryStack[],
  name: string,
  count: number,
  newId?: () => string,
): GameInventoryStack[] {
  const cleaned = cleanName(name);
  if (!cleaned || !Number.isFinite(count)) return stacks;
  const amount = Math.floor(count);
  if (amount < 1 || amount > GAME_INVENTORY_MAX_QUANTITY) return stacks;
  const makeId = newId ?? (() => newGameInventoryStackId(stacks));
  const key = gameInventoryNameKey(cleaned);
  const index = stacks.findIndex((stack) => gameInventoryNameKey(stack.name) === key);
  if (index < 0) return [...stacks, { id: makeId(), name: cleaned, quantity: amount }];
  const target = stacks[index]!;
  const topUp = Math.min(Math.max(0, GAME_INVENTORY_MAX_QUANTITY - target.quantity), amount);
  const next =
    topUp > 0
      ? stacks.map((stack, i) => (i === index ? { ...stack, quantity: stack.quantity + topUp } : stack))
      : stacks;
  return amount > topUp ? [...next, { id: makeId(), name: target.name, quantity: amount - topUp }] : next;
}

/**
 * Taking by name: from the stacks of that name top to bottom until `count` is met, removing each one
 * it empties. Asking for more than there is takes all of it; `taken` says how many really went.
 */
export function takeFromGameInventory(
  stacks: GameInventoryStack[],
  name: string,
  count: number,
): { stacks: GameInventoryStack[]; taken: number } {
  const key = gameInventoryNameKey(name);
  // Not held to one stack's bound: the stacks of an item together may hold more than one stack can.
  let left = Number.isFinite(count) ? Math.floor(count) : 0;
  if (!key || left < 1) return { stacks, taken: 0 };
  let taken = 0;
  const next: GameInventoryStack[] = [];
  for (const stack of stacks) {
    if (left > 0 && gameInventoryNameKey(stack.name) === key) {
      const take = Math.min(left, stack.quantity);
      left -= take;
      taken += take;
      if (stack.quantity - take > 0) next.push({ ...stack, quantity: stack.quantity - take });
      continue;
    }
    next.push(stack);
  }
  return taken > 0 ? { stacks: next, taken } : { stacks, taken: 0 };
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

/** One stack poured into another of the same item, which keeps its place. Two different items never
 *  merge, and a stack never merges into itself. A merge that would pass one stack's bound is refused. */
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
 * One stack renamed. Renaming it to an item the inventory already has pours it into that item's
 * first stack, exactly as renaming did before stacks could be split. `id` is the stack that holds the
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
  const target = stacks.find((stack) => stack.id !== id && gameInventoryNameKey(stack.name) === key);
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
 * The inventory a new session starts with: every stack the last one ended with, ids and splits kept,
 * plus anything the detailed inventory on its last game state names that no stack holds.
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
