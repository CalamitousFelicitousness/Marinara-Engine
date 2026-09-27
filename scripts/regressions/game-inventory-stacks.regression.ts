/**
 * Game Mode inventory stacks (#6759): ids, any amount, splitting, merging, and the named operations
 * the Game Master's tag and a fight use when one item sits in several stacks.
 *
 * Pinned here:
 *   - A saved inventory with no ids reads with the same ids every time, two stacks of one name apart.
 *   - Adding by name goes onto the first stack of that name only; taking by name runs top to bottom
 *     across stacks, removes the ones it empties, and never takes more than there is.
 *   - Setting a count, splitting (300 by 100 is 200 and 100, beside each other), merging (same item
 *     only, into the target's place), and renaming one stack, with every refused change returning
 *     the same array.
 *   - A new session keeps every stack and id (the old carry-over kept only the first of a name).
 *   - The amount field: a count, or +N / -N, bounded like a stack.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  addToGameInventory,
  carryGameInventory,
  GAME_INVENTORY_MAX_QUANTITY,
  gameInventoryCount,
  gameInventoryItemId,
  gameInventoryPlainItemId,
  gameInventoryStackLabel,
  gameInventoryTotals,
  mergeGameInventoryStacks,
  normalizeGameInventoryStacks,
  renameGameInventoryStack,
  setGameInventoryStackQuantity,
  splitGameInventoryStack,
  takeFromGameInventory,
  type GameInventoryStack,
} from "../../packages/shared/src/index.js";
import {
  defaultInventorySplitSize,
  parseInventoryAmount,
} from "../../packages/client/src/lib/game-inventory-amount.js";

const ids = (stacks: GameInventoryStack[]) => stacks.map((stack) => stack.id);
const piles = (stacks: GameInventoryStack[]) => stacks.map((stack) => [gameInventoryStackLabel(stack), stack.quantity]);
const fixedId = (id: string) => () => id;

// ── Reading a saved inventory ──
{
  const saved = [
    { name: " Apple ", quantity: 300 },
    { name: "Rope", quantity: "2" },
    { name: "apple", quantity: 5 },
    { name: "", quantity: 1 },
    null,
    { name: "Coin", quantity: 0 },
    { name: "Hoard", quantity: GAME_INVENTORY_MAX_QUANTITY + 50 },
  ];
  const once = normalizeGameInventoryStacks(saved);
  const twice = normalizeGameInventoryStacks(saved);
  assert.deepEqual(ids(once), ids(twice), "the same saved list reads with the same ids");
  assert.equal(new Set(ids(once)).size, once.length, "every stack has its own id");
  assert.deepEqual(piles(once), [
    ["Apple", 300],
    ["Rope", 2],
    ["apple", 5],
    ["Coin", 1],
    ["Hoard", GAME_INVENTORY_MAX_QUANTITY],
  ]);
  // Stored ids are kept; a duplicated stored id is replaced on the second entry only.
  const stored = normalizeGameInventoryStacks([
    { id: "st-a", name: "Apple", quantity: 1 },
    { id: "st-a", name: "Apple", quantity: 2 },
  ]);
  assert.equal(stored[0]!.id, "st-a");
  assert.notEqual(stored[1]!.id, "st-a");
  assert.deepEqual(normalizeGameInventoryStacks("not a list"), []);
  // A worked-out id trims dashes from both ends, and a name that is a long run of them stays quick.
  assert.equal(normalizeGameInventoryStacks([{ name: " --Apple-- ", quantity: 1 }])[0]!.id, "st-apple-0");
  const started = performance.now();
  const dashes = normalizeGameInventoryStacks([{ name: `${"-".repeat(100_000)}x`, quantity: 1 }]);
  assert.equal(dashes[0]!.id, "st-x-0");
  assert.ok(performance.now() - started < 200, "a long run of dashes is read in linear time");
  // Stored ids are reserved first: an entry saved without an id never takes a later entry's id.
  const reserved = normalizeGameInventoryStacks([
    { name: "Apple", quantity: 1 },
    { id: "st-apple-0", name: "Apple", quantity: 2 },
  ]);
  assert.equal(reserved[1]!.id, "st-apple-0", "the stack saved with the id keeps it");
  assert.notEqual(reserved[0]!.id, "st-apple-0");
}

const apples = (): GameInventoryStack[] => [
  { id: "a1", name: "Apple", quantity: 200 },
  { id: "r1", name: "Rope", quantity: 1 },
  { id: "a2", name: "Apple", quantity: 100 },
];

// ── Adding by name ──
{
  const added = addToGameInventory(apples(), "  apple ", 5);
  assert.deepEqual(
    piles(added),
    [
      ["Apple", 205],
      ["Rope", 1],
      ["Apple", 100],
    ],
    "onto the first stack of that name, and no other",
  );
  const fresh = addToGameInventory(apples(), "Lantern", 2, fixedId("new"));
  assert.deepEqual(fresh.at(-1), { id: "new", name: "Lantern", quantity: 2 });
  // What the first stack cannot hold starts a new stack; nothing added is lost.
  const nearlyFull: GameInventoryStack[] = [{ id: "c1", name: "Coin", quantity: GAME_INVENTORY_MAX_QUANTITY - 5 }];
  assert.deepEqual(addToGameInventory(nearlyFull, "coin", 20, fixedId("c2")), [
    { id: "c1", name: "Coin", quantity: GAME_INVENTORY_MAX_QUANTITY },
    { id: "c2", name: "Coin", quantity: 15 },
  ]);
  const full: GameInventoryStack[] = [{ id: "c1", name: "Coin", quantity: GAME_INVENTORY_MAX_QUANTITY }];
  assert.deepEqual(piles(addToGameInventory(full, "Coin", 3, fixedId("c2"))), [
    ["Coin", GAME_INVENTORY_MAX_QUANTITY],
    ["Coin", 3],
  ]);
  const same = apples();
  assert.equal(addToGameInventory(same, "Apple", 0), same, "adding nothing changes nothing");
  for (const count of [Number.NaN, Number.POSITIVE_INFINITY, GAME_INVENTORY_MAX_QUANTITY + 1]) {
    assert.equal(addToGameInventory(same, "Apple", count), same, `adding ${count} is refused`);
    assert.equal(addToGameInventory(same, "Lantern", count), same, `a new stack of ${count} is refused`);
  }
  assert.equal(addToGameInventory(same, "   ", 3), same);
}

// ── Taking by name ──
{
  const partly = takeFromGameInventory(apples(), "Apple", 50);
  assert.equal(partly.taken, 50);
  assert.deepEqual(piles(partly.stacks), [
    ["Apple", 150],
    ["Rope", 1],
    ["Apple", 100],
  ]);
  const across = takeFromGameInventory(apples(), "apple", 250);
  assert.equal(across.taken, 250);
  assert.deepEqual(ids(across.stacks), ["r1", "a2"], "the emptied stack is removed");
  assert.deepEqual(piles(across.stacks), [
    ["Rope", 1],
    ["Apple", 50],
  ]);
  const everything = takeFromGameInventory(apples(), "Apple", 9999);
  assert.equal(everything.taken, 300, "more than there is takes all of it, and says how many");
  assert.deepEqual(ids(everything.stacks), ["r1"]);
  // Taking is not held to one stack's bound: several full stacks can be emptied at once.
  const hoard: GameInventoryStack[] = [
    { id: "h1", name: "Coin", quantity: GAME_INVENTORY_MAX_QUANTITY },
    { id: "h2", name: "Coin", quantity: GAME_INVENTORY_MAX_QUANTITY },
  ];
  const bigTake = takeFromGameInventory(hoard, "Coin", GAME_INVENTORY_MAX_QUANTITY + 10);
  assert.equal(bigTake.taken, GAME_INVENTORY_MAX_QUANTITY + 10);
  assert.deepEqual(piles(bigTake.stacks), [["Coin", GAME_INVENTORY_MAX_QUANTITY - 10]]);
  const same = apples();
  const none = takeFromGameInventory(same, "Lantern", 1);
  assert.equal(none.stacks, same);
  assert.equal(none.taken, 0);
  assert.equal(gameInventoryCount(apples(), " APPLE"), 300);
  assert.deepEqual(gameInventoryTotals(apples()), [
    { name: "Apple", quantity: 300 },
    { name: "Rope", quantity: 1 },
  ]);
}

// ── One stack's count ──
{
  const same = apples();
  assert.deepEqual(piles(setGameInventoryStackQuantity(same, "a2", 150)).at(-1), ["Apple", 150]);
  assert.deepEqual(ids(setGameInventoryStackQuantity(same, "r1", 0)), ["a1", "a2"], "zero removes the stack");
  assert.equal(setGameInventoryStackQuantity(same, "a1", 200), same);
  assert.equal(setGameInventoryStackQuantity(same, "missing", 3), same);
  assert.equal(setGameInventoryStackQuantity(same, "a1", Number.NaN), same);
  assert.equal(
    setGameInventoryStackQuantity(same, "a1", GAME_INVENTORY_MAX_QUANTITY * 2)[0]!.quantity,
    GAME_INVENTORY_MAX_QUANTITY,
  );
}

// ── Splitting ──
{
  const pile: GameInventoryStack[] = [
    { id: "a", name: "Apple", quantity: 300 },
    { id: "r", name: "Rope", quantity: 1 },
  ];
  const split = splitGameInventoryStack(pile, "a", 100, fixedId("b"));
  assert.deepEqual(
    split,
    [
      { id: "a", name: "Apple", quantity: 200 },
      { id: "b", name: "Apple", quantity: 100 },
      { id: "r", name: "Rope", quantity: 1 },
    ],
    "300 split by 100 is 200 and 100, side by side",
  );
  for (const size of [0, 300, 301, -1, 1.5, Number.NaN]) {
    assert.equal(splitGameInventoryStack(pile, "a", size), pile, `a split of ${size} changes nothing`);
  }
  assert.equal(splitGameInventoryStack(pile, "r", 1), pile, "a single item cannot be split");
  const fresh = splitGameInventoryStack(pile, "a", 1);
  assert.equal(new Set(ids(fresh)).size, 3, "a split without a given id still makes a new one");
}

// ── Merging ──
{
  const same = apples();
  const merged = mergeGameInventoryStacks(same, "a2", "a1");
  assert.deepEqual(
    merged,
    [
      { id: "a1", name: "Apple", quantity: 300 },
      { id: "r1", name: "Rope", quantity: 1 },
    ],
    "into the target, which keeps its place",
  );
  assert.equal(mergeGameInventoryStacks(same, "r1", "a1"), same, "two different items never merge");
  assert.equal(mergeGameInventoryStacks(same, "a1", "a1"), same);
  assert.equal(mergeGameInventoryStacks(same, "a1", "missing"), same);
  const full: GameInventoryStack[] = [
    { id: "x", name: "Coin", quantity: GAME_INVENTORY_MAX_QUANTITY },
    { id: "y", name: "Coin", quantity: 1 },
  ];
  assert.equal(mergeGameInventoryStacks(full, "y", "x"), full, "a merge past one stack's bound is refused");
}

// ── Renaming one stack: a nickname, never another item ──
{
  const same = apples();
  const renamed = renameGameInventoryStack(same, "a2", "Green apple")!;
  assert.equal(renamed.id, "a2");
  assert.deepEqual(
    renamed.stacks[2],
    { id: "a2", name: "Apple", nickname: "Green apple", quantity: 100 },
    "only that stack is called something else, and it is still an apple",
  );
  assert.equal(gameInventoryItemId(renamed.stacks[2]!), gameInventoryItemId(same[0]!));
  assert.equal(gameInventoryCount(renamed.stacks, "Apple"), 300, "named by its own name");
  assert.equal(gameInventoryCount(renamed.stacks, "green APPLE"), 300, "or by the nickname, any case");
  assert.deepEqual(gameInventoryTotals(renamed.stacks), [
    { name: "Apple", quantity: 300 },
    { name: "Rope", quantity: 1 },
  ]);
  const into = renameGameInventoryStack(same, "r1", "Apple")!;
  assert.equal(into.id, "r1", "a rope called Apple is never poured into the apples");
  assert.deepEqual(piles(into.stacks), [
    ["Apple", 200],
    ["Apple", 1],
    ["Apple", 100],
  ]);
  assert.equal(gameInventoryCount(into.stacks, "rope"), 1, "it is still a rope");
  assert.equal(mergeGameInventoryStacks(into.stacks, "r1", "a1"), into.stacks, "and never merges with them");
  const back = renameGameInventoryStack(renamed.stacks, "a2", "  APPLE ")!;
  assert.deepEqual(back.stacks[2], same[2], "the item's own name, in any case, clears the nickname");
  assert.equal(renameGameInventoryStack(same, "a2", "APPLE")!.stacks, same, "which is nothing to clear here");
  assert.equal(renameGameInventoryStack(same, "a1", "Apple")!.stacks, same);
  assert.equal(renameGameInventoryStack(renamed.stacks, "a2", "Green apple")!.stacks, renamed.stacks);
  assert.equal(renameGameInventoryStack(same, "missing", "X"), null);
  assert.equal(renameGameInventoryStack(same, "a1", "   "), null);
  // Nicknames read back as they were saved, and one that is the own name again is dropped.
  assert.deepEqual(
    normalizeGameInventoryStacks([
      { id: "x", name: "Rope", nickname: "  Grandpa's   rope ", quantity: 2 },
      { id: "y", name: "Rope", nickname: "ROPE", quantity: 1 },
      { id: "z", name: "Rope", nickname: 7, quantity: 1 },
    ]),
    [
      { id: "x", name: "Rope", nickname: "Grandpa's rope", quantity: 2 },
      { id: "y", name: "Rope", quantity: 1 },
      { id: "z", name: "Rope", quantity: 1 },
    ],
  );
}

// ── Which item a name makes ──
{
  assert.equal(gameInventoryPlainItemId("Rope"), "plain:rope");
  assert.equal(gameInventoryPlainItemId("  ROPE!! "), "plain:rope", "case, spacing and punctuation aside");
  assert.equal(gameInventoryPlainItemId("Health Potion"), "plain:health-potion");
  assert.equal(gameInventoryPlainItemId("Épée"), "plain:epee", "accents aside");
  assert.equal(gameInventoryPlainItemId("Меч"), "plain:меч", "every script keeps its letters");
  assert.notEqual(gameInventoryPlainItemId("Меч"), gameInventoryPlainItemId("Щит"), "so two such items stay two");
  assert.match(gameInventoryPlainItemId("🍎"), /^plain:~[0-9a-z]+$/, "no letters at all: a fingerprint");
  assert.notEqual(gameInventoryPlainItemId("🍎"), gameInventoryPlainItemId("🍐"));
  const long = `${"a".repeat(50)}1`;
  assert.notEqual(gameInventoryPlainItemId(long), gameInventoryPlainItemId(`${"a".repeat(50)}2`), "not cut into one");
  assert.ok(gameInventoryPlainItemId(long).length <= 48);
}

// ── A new session carries every stack ──
{
  const carried = carryGameInventory(
    [
      { id: "st-a", name: "Apple", quantity: 200 },
      { id: "st-b", name: "Apple", quantity: 100 },
    ],
    [
      { name: "apple", description: "", quantity: 300, location: "on_person" },
      { name: "Map", description: "Of the valley", quantity: 1, location: "on_person" },
    ],
  );
  assert.deepEqual(
    piles(carried),
    [
      ["Apple", 200],
      ["Apple", 100],
      ["Map", 1],
    ],
    "both apple stacks survive, and the detailed inventory adds only what no stack holds",
  );
  assert.deepEqual(ids(carried).slice(0, 2), ["st-a", "st-b"]);
  // Nicknames carry over, and an entry that follows an item by id is that item under any name.
  assert.deepEqual(
    carryGameInventory(
      [{ id: "st-r", name: "Rope", nickname: "Grandpa's rope", quantity: 2 }],
      [
        { item: gameInventoryPlainItemId("Rope"), name: "Old faithful", description: "", quantity: 2, location: "" },
        { name: "grandpa's rope", description: "", quantity: 2, location: "" },
      ],
    ),
    [{ id: "st-r", name: "Rope", nickname: "Grandpa's rope", quantity: 2 }],
  );
  assert.deepEqual(piles(carryGameInventory(undefined, [{ name: "Map", quantity: 1 }])), [["Map", 1]]);
  assert.deepEqual(
    piles(
      carryGameInventory(
        [],
        [
          { name: "Map", quantity: 1 },
          { name: "map", quantity: 2 },
        ],
      ),
    ),
    [["Map", 3]],
    "two detailed entries of a name no stack holds both count",
  );
}

// ── The amount field ──
{
  assert.equal(parseInventoryAmount("300", 10), 300);
  assert.equal(parseInventoryAmount(" +100 ", 300), 400);
  assert.equal(parseInventoryAmount("-50", 300), 250);
  assert.equal(parseInventoryAmount("- 500", 300), 0, "taking more than there is empties the stack");
  assert.equal(parseInventoryAmount("0", 300), 0);
  for (const text of ["", "abc", "1.5", "+", "3e2", "--5"]) {
    assert.equal(parseInventoryAmount(text, 300), null, `"${text}" is not an amount`);
  }
  assert.equal(parseInventoryAmount(String(GAME_INVENTORY_MAX_QUANTITY + 1), 0), null);
  assert.equal(parseInventoryAmount("+1", GAME_INVENTORY_MAX_QUANTITY), null);
  assert.equal(defaultInventorySplitSize(300), 150);
  assert.equal(defaultInventorySplitSize(3), 1);
  assert.equal(defaultInventorySplitSize(2), 1);
}

console.log("game-inventory-stacks regression passed");
