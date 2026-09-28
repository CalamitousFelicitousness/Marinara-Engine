/**
 * Game Mode's inventory as stacks.
 *
 * The inventory is a list of stacks, and two stacks may hold the same item: a player can split 300
 * apples into 200 and 100, and both stay apart until the player merges them again. So every stack
 * has an id, and everything that points at ONE stack (the inventory screen) uses it.
 *
 * Every stack is also some ITEM, and every stack of an item agrees on which (`gameInventoryItemId`).
 * A stack keeps the item's own name, the name it was made with, and a rename only gives it a
 * `nickname` to be shown by instead. So identity, merging, totals and fights never follow what the
 * player calls a stack. What names an item (the Game Master's `[inventory: ...]` tag, a fight
 * spending one) finds it by its own name or by any nickname a stack of it has.
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
  /** The item's own name, as it was made. A rename never changes it. */
  name: string;
  /** What this stack is called instead, when the player renamed it. Never the own name again. */
  nickname?: string;
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

/** The longest item name or nickname kept. */
export const GAME_INVENTORY_NAME_MAX_LENGTH = 120;

/** The most one stack may hold. Far past any real pile, and small enough to stay an exact integer
 *  through every sum a screen or a prompt makes of it. */
export const GAME_INVENTORY_MAX_QUANTITY = 999_999;

/** The one spelling two names are compared by: trimmed, single-spaced, any case. */
export function gameInventoryNameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** The name a stack is shown by: its nickname, or the item's own name when it has none. */
export function gameInventoryStackLabel(stack: { name: string; nickname?: string }): string {
  return stack.nickname ?? stack.name;
}

/** A short, stable fingerprint of a name, for ids that cannot be spelled out (FNV-1a). */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * The id of the item a name makes: `plain:` and the name in lowercase letters and digits of any
 * script, joined by dashes, so "Rope", "rope" and "ROPE!" are one item and "Меч" keeps its letters.
 * A name with no letter or digit (an emoji, "???") gets a fingerprint instead, and a very long one
 * keeps its start and a fingerprint of the whole, so two names never share an id by being cut short.
 */
export function gameInventoryPlainItemId(name: string): string {
  // Accents come off Latin, Greek and Cyrillic letters only ("Épée" is "epee"); in other scripts a mark
  // is part of the letter (a Japanese dakuten, a Devanagari vowel sign), so it stays.
  const key = gameInventoryNameKey(name)
    .normalize("NFKD")
    .replace(/([\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}])\p{M}+/gu, "$1")
    .normalize("NFC");
  // A sign in front of a number is part of the name, so "Sword +1" and "Sword -1" stay two items; a
  // dash right after a letter or digit is only a hyphen. Every other mark between words is a dash.
  const dashed = key
    .replace(/(\+)(?=\p{N})|(?<![\p{L}\p{N}\p{M}])([-\u2212])(?=\p{N})|[^\p{L}\p{N}\p{M}]/gu, (_, plus, minus) =>
      plus ? "-+" : minus ? "-\u2212" : "-",
    )
    .replace(/-+/g, "-");
  // Leading and trailing dashes are trimmed by walking in from each end, not by an anchored pattern,
  // which could backtrack over a long run of dashes in a name the player typed.
  let start = 0;
  let end = dashed.length;
  while (start < end && dashed[start] === "-") start += 1;
  while (end > start && dashed[end - 1] === "-") end -= 1;
  const spelled = [...dashed.slice(start, end)];
  if (spelled.length === 0) return `plain:~${fingerprint(key)}`;
  if (spelled.length > 40) return `plain:${spelled.slice(0, 32).join("")}-${fingerprint(key)}`;
  return `plain:${spelled.join("")}`;
}

/** Which item a stack is. Every stack of an item agrees, whatever its nickname. */
export function gameInventoryItemId(stack: { name: string }): string {
  return gameInventoryPlainItemId(stack.name);
}

/** A holder as it is kept: cleaned, and absent for nobody in particular. */
export function cleanGameInventoryHolder(holder: unknown): string | undefined {
  if (typeof holder !== "string") return undefined;
  const cleaned = cleanName(holder).slice(0, GAME_INVENTORY_HOLDER_MAX_LENGTH);
  // A name with no letter or digit in it keys to nothing, which cannot be told apart from the
  // player's own bag, so it is the player's.
  return cleaned && normalizeCharacterLookupName(cleaned) ? cleaned : undefined;
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

/** A stack as it is kept: the nickname only when it is not the item's own name. */
function makeStack(
  id: string,
  name: string,
  nickname: string | undefined,
  quantity: number,
  holder: string | undefined,
): GameInventoryStack {
  const named = nickname && gameInventoryNameKey(nickname) !== gameInventoryNameKey(name) ? { nickname } : {};
  return { id, name, ...named, quantity, ...(holder ? { holder } : {}) };
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
 * is missing, broken or below one reads as one, as it always has. A nickname that is the item's own
 * name again, in any case, is dropped.
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
    const nickname =
      typeof source.nickname === "string"
        ? cleanName(source.nickname).slice(0, GAME_INVENTORY_NAME_MAX_LENGTH) || undefined
        : undefined;
    return [{ name, nickname, quantity, stored, holder: cleanGameInventoryHolder(source.holder) }];
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
    if (keeps[index]) return makeStack(entry.stored, entry.name, entry.nickname, entry.quantity, entry.holder);
    let id = `st-${slug(entry.name)}-${occurrence}`;
    while (used.has(id)) id = `${id}-x`;
    used.add(id);
    return makeStack(id, entry.name, entry.nickname, entry.quantity, entry.holder);
  });
}

/**
 * The items a name means among `stacks`: the item whose own name it is, when a stack of it is there;
 * otherwise every item a stack of which is nicknamed that, ignoring case; otherwise the item the name
 * would make. So an item's own name always wins over another item's nickname.
 */
function itemsNamed(stacks: readonly GameInventoryStack[], name: string): Set<string> {
  if (!gameInventoryNameKey(name)) return new Set();
  const own = gameInventoryPlainItemId(name);
  if (stacks.some((stack) => gameInventoryItemId(stack) === own)) return new Set([own]);
  const key = gameInventoryNameKey(name);
  const nicknamed = stacks.filter((stack) => stack.nickname && gameInventoryNameKey(stack.nickname) === key);
  return new Set(nicknamed.length > 0 ? nicknamed.map(gameInventoryItemId) : [own]);
}

/**
 * The items a name means, read against one bag's stacks when `from` is given (as a take or a give by
 * name reads it). Settled before a change, so what the change did can be counted afterwards by item,
 * even once the stacks the name was found on are gone.
 */
export function gameInventoryItemsNamed(
  stacks: readonly GameInventoryStack[],
  name: string,
  from?: GameInventoryBagRef,
): Set<string> {
  return itemsNamed(from ? stacks.filter((stack) => inBag(stack, from)) : stacks, name);
}

/** How many stacks of these items hold, across every bag or in one bag's. */
export function gameInventoryCountItems(
  stacks: readonly GameInventoryStack[],
  items: ReadonlySet<string>,
  from?: GameInventoryBagRef,
): number {
  return stacks.reduce(
    (total, stack) =>
      total + (items.has(gameInventoryItemId(stack)) && (!from || inBag(stack, from)) ? stack.quantity : 0),
    0,
  );
}

/** One line of `gameInventoryTotals`: an item, the name it is shown by, and how many there are. */
export interface GameInventoryTotal {
  name: string;
  quantity: number;
  /** The item's own name, when `name` is a nickname a player gave it. */
  ownName?: string;
}

/** One line per item: every stack of an item added together, in the order the items first appear,
 *  shown by the first stack's name. What the Game Master and a fight read, since a split is the
 *  player's own arrangement. */
export function gameInventoryTotals(stacks: readonly GameInventoryStack[]): GameInventoryTotal[] {
  const totals = new Map<string, GameInventoryTotal>();
  for (const stack of stacks) {
    const item = gameInventoryItemId(stack);
    const existing = totals.get(item);
    if (existing) existing.quantity += stack.quantity;
    else
      totals.set(item, {
        name: gameInventoryStackLabel(stack),
        quantity: stack.quantity,
        ...(stack.nickname ? { ownName: stack.name } : {}),
      });
  }
  return [...totals.values()];
}

/** One line a fight lists: a total, under a name no other line has. */
export interface GameInventoryFightLine extends GameInventoryTotal {
  /** The name the item is shown by in the inventory, before anything was added to keep `name` unique. */
  shown: string;
}

/**
 * The lines a fight lists: `gameInventoryTotals`, each under a name no other line has, since a fight
 * tells items apart by name. A nickname that another line also goes by is shown with the item's own
 * name, such as "Potion (Cord)" beside a real "Potion", and a name still taken after that gets a
 * number. `ownName` stays what a spend is taken by.
 */
export function gameInventoryFightLines(stacks: readonly GameInventoryStack[]): GameInventoryFightLine[] {
  const totals = gameInventoryTotals(stacks);
  const uses = new Map<string, number>();
  for (const line of totals) {
    const key = gameInventoryNameKey(line.name);
    uses.set(key, (uses.get(key) ?? 0) + 1);
  }
  const taken = new Set<string>();
  return totals.map((line) => {
    const base =
      line.ownName && (uses.get(gameInventoryNameKey(line.name)) ?? 0) > 1
        ? `${line.name} (${line.ownName})`
        : line.name;
    let name = base;
    for (let n = 2; taken.has(gameInventoryNameKey(name)); n += 1) name = `${base} ${n}`;
    taken.add(gameInventoryNameKey(name));
    // A line listed under anything but the item's own name says what that own name is, which is what
    // a spend is taken by.
    const ownName = line.ownName ?? (name === line.name ? undefined : line.name);
    return { ...line, name, ...(ownName ? { ownName } : {}), shown: line.name };
  });
}

/**
 * A fight's item effects, each under the name of the line it belongs to. Every line first takes the
 * effect named by its item's own name, since a line's listed name may be one another item really
 * goes by (a cord nicknamed "Potion" is listed as "Potion (Cord)" beside an item called that). A
 * line with none then takes one named as it is listed or shown, unless another line took that effect
 * by its own name. Effects no line takes are kept as they are.
 */
export function gameInventoryFightEffects<T extends { name: string }>(
  lines: readonly GameInventoryFightLine[],
  effects: readonly T[],
): T[] {
  const byName = (name: string | undefined) =>
    name ? effects.find((effect) => gameInventoryNameKey(effect.name) === gameInventoryNameKey(name)) : undefined;
  const given = new Map<string, T>();
  for (const line of lines) {
    const effect = byName(line.ownName ?? line.shown);
    if (effect) given.set(line.name, effect);
  }
  const claimed = new Set(given.values());
  for (const line of lines) {
    if (given.has(line.name)) continue;
    const effect = [line.name, line.shown].map(byName).find((found) => found && !claimed.has(found));
    if (effect) given.set(line.name, effect);
  }
  const used = new Set(given.values());
  return [
    ...lines.flatMap((line) => {
      const effect = given.get(line.name);
      return effect ? [effect.name === line.name ? effect : { ...effect, name: line.name }] : [];
    }),
    ...effects.filter((effect) => !used.has(effect)),
  ];
}

/** Each bag's own totals, the player's first and then in the order a holder first appears. Only bags
 *  that hold something are listed. */
export function gameInventoryBags(
  stacks: readonly GameInventoryStack[],
): Array<{ holder?: string; items: GameInventoryTotal[] }> {
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
  const scope = from ? stacks.filter((stack) => inBag(stack, from)) : stacks;
  const items = itemsNamed(scope, name);
  return scope.reduce((total, stack) => total + (items.has(gameInventoryItemId(stack)) ? stack.quantity : 0), 0);
}

/**
 * `amount` of the item `like` is into one bag: onto the bag's first stack of that item, or a new
 * stack at the end called what `like` is called. What the first stack cannot hold starts a new stack
 * at the end, so nothing added is ever lost. `id` is the stack it went onto first.
 */
function addLike(
  stacks: GameInventoryStack[],
  like: { name: string; nickname?: string },
  amount: number,
  holder: string | undefined,
  makeId: () => string,
): { stacks: GameInventoryStack[]; id: string } {
  const item = gameInventoryItemId(like);
  const bag = { holder };
  const index = stacks.findIndex((stack) => gameInventoryItemId(stack) === item && inBag(stack, bag));
  if (index < 0) {
    const fresh = makeStack(makeId(), like.name, like.nickname, amount, holder);
    return { stacks: [...stacks, fresh], id: fresh.id };
  }
  const target = stacks[index]!;
  const topUp = Math.min(Math.max(0, GAME_INVENTORY_MAX_QUANTITY - target.quantity), amount);
  const next =
    topUp > 0
      ? stacks.map((stack, i) => (i === index ? { ...stack, quantity: stack.quantity + topUp } : stack))
      : stacks;
  if (amount === topUp) return { stacks: next, id: target.id };
  return {
    stacks: [...next, makeStack(makeId(), target.name, target.nickname, amount - topUp, holder)],
    id: target.id,
  };
}

/**
 * Adding by name into one bag (the player's when `holder` is absent). The name finds its item as
 * every name does; the bag's first stack of it takes the addition, and when the bag has none, a new
 * stack of it is made at the end, called by the item's own name. A name that finds no item makes a
 * new one. One addition is at most one stack's worth; a count past that, or one that is not a number,
 * is refused and changes nothing. `id` is the stack it went onto.
 */
export function addToGameInventoryNamed(
  stacks: GameInventoryStack[],
  name: string,
  count: number,
  newId?: () => string,
  holder?: string,
): { stacks: GameInventoryStack[]; id: string } | null {
  const cleaned = cleanName(name).slice(0, GAME_INVENTORY_NAME_MAX_LENGTH);
  if (!cleaned || !Number.isFinite(count)) return null;
  const amount = Math.floor(count);
  if (amount < 1 || amount > GAME_INVENTORY_MAX_QUANTITY) return null;
  const makeId = newId ?? (() => newGameInventoryStackId(stacks));
  const bag = { holder: cleanGameInventoryHolder(holder) };
  const items = itemsNamed(stacks, cleaned);
  const known =
    stacks.find((stack) => items.has(gameInventoryItemId(stack)) && inBag(stack, bag)) ??
    stacks.find((stack) => items.has(gameInventoryItemId(stack)));
  return addLike(stacks, known ? { name: known.name } : { name: cleaned }, amount, bag.holder, makeId);
}

/** `addToGameInventoryNamed`, for a caller that only needs the stacks. */
export function addToGameInventory(
  stacks: GameInventoryStack[],
  name: string,
  count: number,
  newId?: () => string,
  holder?: string,
): GameInventoryStack[] {
  return addToGameInventoryNamed(stacks, name, count, newId, holder)?.stacks ?? stacks;
}

/** The stacks a name finds, in the order they are taken or given from: with `from`, only that bag's
 *  (and the name is read against that bag); without, the player's own bag first and then the rest of
 *  the party's, top to bottom. */
function stacksNamed(
  stacks: readonly GameInventoryStack[],
  name: string,
  from?: GameInventoryBagRef,
): Array<{ stack: GameInventoryStack; index: number }> {
  const items = itemsNamed(from ? stacks.filter((stack) => inBag(stack, from)) : stacks, name);
  return stacks
    .map((stack, index) => ({ stack, index }))
    .filter(({ stack }) => items.has(gameInventoryItemId(stack)) && (!from || inBag(stack, from)))
    .sort(
      (a, b) => (from ? 0 : Number(Boolean(a.stack.holder)) - Number(Boolean(b.stack.holder))) || a.index - b.index,
    );
}

/**
 * Taking by name: from the stacks of the item it finds, in `stacksNamed` order, until `count` is met,
 * removing each one it empties. Asking for more than there is takes all of it; `taken` says how many
 * really went.
 */
export function takeFromGameInventory(
  stacks: GameInventoryStack[],
  name: string,
  count: number,
  from?: GameInventoryBagRef,
): { stacks: GameInventoryStack[]; taken: number } {
  // Not held to one stack's bound: the stacks of an item together may hold more than one stack can.
  let left = Number.isFinite(count) ? Math.floor(count) : 0;
  if (!gameInventoryNameKey(name) || left < 1) return { stacks, taken: 0 };
  const takeAt = new Map<number, number>();
  let taken = 0;
  for (const { stack, index } of stacksNamed(stacks, name, from)) {
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
 * that stack and added to their bag onto their first stack of the same item, or as a new stack
 * called what this one is called. Giving to the bag it is already in, or a count that is not from 1
 * to the stack's size, changes nothing. `id` is the stack that received it, so a screen can follow it.
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
  const item = gameInventoryItemId(source);
  const rest =
    amount === source.quantity
      ? stacks.filter((stack) => stack.id !== id)
      : stacks.map((stack) => (stack.id === id ? { ...stack, quantity: stack.quantity - amount } : stack));
  const existing = rest.find((stack) => gameInventoryItemId(stack) === item && inBag(stack, receiver));
  // A whole stack given to somebody with none of it keeps its id, so a selection follows it.
  if (!existing && amount === source.quantity) {
    const index = stacks.findIndex((stack) => stack.id === id);
    return {
      stacks: stacks.map((stack, i) => (i === index ? withHolder(stack, receiver.holder) : stack)),
      id,
    };
  }
  return addLike(rest, source, amount, receiver.holder, makeId);
}

/**
 * Giving by name: `count` of the item a name finds, out of one bag (the player's when `from` is
 * absent) and into another's (`to`), stack by stack in the bag's order, each as
 * `giveGameInventoryStack` hands it over, so nicknames travel with the stacks they are on. Giving
 * into the same bag, or when the bag holds none, changes nothing. `given` says how many went.
 */
export function giveFromGameInventoryNamed(
  stacks: GameInventoryStack[],
  name: string,
  count: number,
  from: GameInventoryBagRef,
  to: string | undefined,
  newId?: () => string,
): { stacks: GameInventoryStack[]; given: number } {
  let left = Number.isFinite(count) ? Math.floor(count) : 0;
  const receiver = { holder: cleanGameInventoryHolder(to) };
  if (left < 1 || gameInventoryBagKey(from.holder) === gameInventoryBagKey(receiver.holder)) {
    return { stacks, given: 0 };
  }
  let current = stacks;
  let given = 0;
  for (const { stack } of stacksNamed(stacks, name, from)) {
    if (left < 1) break;
    const amount = Math.min(left, stack.quantity);
    const next = giveGameInventoryStack(current, stack.id, receiver.holder, amount, newId);
    if (!next) break;
    current = next.stacks;
    left -= amount;
    given += amount;
  }
  return given > 0 ? { stacks: current, given } : { stacks, given: 0 };
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
 * Part of a stack moved into a new stack right after it, with the same item and nickname. The size
 * has to leave something behind and move something, so it is at least one and less than the stack;
 * anything else changes nothing. The total never changes.
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

/** One stack poured into another of the same item, which keeps its place, its bag and its nickname,
 *  so pouring into a stack in somebody else's bag hands it over. Two different items never merge,
 *  whatever they are called, and a stack never merges into itself. A merge that would pass one
 *  stack's bound is refused. */
export function mergeGameInventoryStacks(
  stacks: GameInventoryStack[],
  fromId: string,
  intoId: string,
): GameInventoryStack[] {
  if (fromId === intoId) return stacks;
  const from = stacks.find((stack) => stack.id === fromId);
  const into = stacks.find((stack) => stack.id === intoId);
  if (!from || !into || gameInventoryItemId(from) !== gameInventoryItemId(into)) return stacks;
  if (from.quantity + into.quantity > GAME_INVENTORY_MAX_QUANTITY) return stacks;
  return stacks
    .filter((stack) => stack.id !== fromId)
    .map((stack) => (stack.id === intoId ? { ...stack, quantity: stack.quantity + from.quantity } : stack));
}

/**
 * One stack called something else: its nickname, which is all a rename changes. Renaming it back to
 * the item's own name, in any case, clears the nickname. A rename never changes which item it is and
 * never merges it into anything. An empty name is refused.
 */
export function renameGameInventoryStack(
  stacks: GameInventoryStack[],
  id: string,
  nextName: string,
): { stacks: GameInventoryStack[]; id: string } | null {
  const cleaned = cleanName(nextName).slice(0, GAME_INVENTORY_NAME_MAX_LENGTH);
  const source = stacks.find((stack) => stack.id === id);
  if (!source || !cleaned) return null;
  const renamed = makeStack(source.id, source.name, cleaned, source.quantity, source.holder);
  if (gameInventoryStackLabel(renamed) === gameInventoryStackLabel(source)) return { stacks, id };
  return { stacks: stacks.map((stack) => (stack.id === id ? renamed : stack)), id };
}

/**
 * The inventory a new session starts with: every stack the last one ended with, ids, splits, bags and
 * nicknames kept, plus anything the detailed inventory on its last game state names that no stack
 * holds, which goes to the player.
 */
export function carryGameInventory(gameInventory: unknown, detailedInventory: unknown): GameInventoryStack[] {
  let stacks = normalizeGameInventoryStacks(gameInventory);
  // Read against the stacks as saved, so two detailed entries of an item no stack holds both count.
  const saved = stacks;
  const held = new Set(saved.map(gameInventoryItemId));
  for (const raw of Array.isArray(detailedInventory) ? detailedInventory : []) {
    const [entry] = normalizeGameInventoryStacks([raw]);
    if (!entry) continue;
    const item = (raw as { item?: unknown }).item;
    // An entry that follows an item by id is held exactly when that item is; only one without an id
    // is judged by its name.
    if (typeof item === "string" ? held.has(item) : gameInventoryCount(saved, entry.name) > 0) continue;
    // An entry whose name is not its item's own (a nickname) comes back as that item, its own name
    // read off the id and the entry's name kept as the nickname, rather than as whatever that name
    // finds. Only an own name that makes that same id again is trusted: one cut short and
    // fingerprinted cannot be read back, and comes back by name.
    const own =
      typeof item === "string" && item.startsWith("plain:") ? item.slice("plain:".length).replace(/-/g, " ") : "";
    if (own && gameInventoryPlainItemId(own) === item && gameInventoryPlainItemId(entry.name) !== item) {
      const makeId = () => newGameInventoryStackId(stacks);
      stacks = addLike(stacks, { name: own, nickname: entry.name }, entry.quantity, undefined, makeId).stacks;
      continue;
    }
    stacks = addToGameInventory(stacks, entry.name, entry.quantity);
  }
  return stacks;
}
