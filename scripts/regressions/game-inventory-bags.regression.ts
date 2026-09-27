/**
 * Game Mode's inventory, slice I2: a bag per party member, one route for every change, and the Game
 * Master's tags applied on the server.
 *
 * What is pinned here:
 *   - A stack's `holder` names who carries it; none is the player, so a saved game reads unchanged.
 *     Adding and renaming stay inside one bag, taking by name without a bag takes the player's own
 *     first, giving moves some or all of a stack into another bag, and a merge follows its target.
 *   - Every change is one operation, applied in order by one function, a refused one changing nothing
 *     and stopping nothing; the detailed inventory follows by difference and keeps its notes.
 *   - The `[inventory:]` grammar: every form the browser read before, plus `who`, `to` and `give`; a
 *     `result` the Game Master writes is never believed, and each item is answered on its own.
 *   - Applying a reply's tags: who and to are matched like a sheet command's who, a refusal says why,
 *     and the journal hears of what was gained and lost.
 *   - The route saves the stacks, the detailed inventory and the journal together, and refuses a
 *     malformed request whole.
 *   - A tracker rebuilding a turn's row keeps that turn's detailed inventory.
 *   - The Game Master sees who carries what once anyone but the player carries something.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addToGameInventory,
  applyGameInventoryOps,
  applyGameInventoryTags,
  carryGameInventory,
  followGameInventoryDetails,
  gameInventoryBags,
  gameInventoryForTelling,
  gameInventoryTellingStart,
  readGameInventoryTurn,
  recordGameInventoryTelling,
  sameGameInventory,
  gameInventoryCount,
  giveGameInventoryStack,
  mergeGameInventoryStacks,
  normalizeGameInventoryStacks,
  parseInventoryTagBody,
  readResolvedInventoryTags,
  refuseGameInventoryTags,
  renameGameInventoryStack,
  replaceTrailingInventoryTags,
  resolveGameInventoryHolder,
  serializeInventoryTag,
  swapGameInventoryStacks,
  takeFromGameInventory,
  type GameInventoryStack,
  type InventoryItem,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-inventory-bags-"));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");

let counter = 0;
const nextId = () => `st-new-${++counter}`;
const bag = (): GameInventoryStack[] => [
  { id: "a", name: "Rope", quantity: 2 },
  { id: "b", name: "Arrow", quantity: 10, holder: "Bram" },
  { id: "c", name: "Arrow", quantity: 5 },
  { id: "d", name: "Torch", quantity: 1, holder: "Cass" },
];

try {
  // ── Holders are read, kept and compared like a name on a card ──
  {
    const read = normalizeGameInventoryStacks([
      { id: "x", name: "Rope", quantity: 1, holder: "  Bram   Stoker " },
      { id: "y", name: "Map", quantity: 1, holder: "   " },
      { id: "z", name: "Coin", quantity: 3, holder: 42 },
      // No letter or digit keys to nothing, which is the player's bag, so it is kept as the player's.
      { id: "w", name: "Gem", quantity: 1, holder: "???" },
    ]);
    assert.deepEqual(read, [
      { id: "x", name: "Rope", quantity: 1, holder: "Bram Stoker" },
      { id: "y", name: "Map", quantity: 1 },
      { id: "z", name: "Coin", quantity: 3 },
      { id: "w", name: "Gem", quantity: 1 },
    ]);
    // A saved game from before bags is the player's own bag, byte for byte.
    const legacy = [{ id: "st-rope-0", name: "Rope", quantity: 2 }];
    assert.deepEqual(normalizeGameInventoryStacks(legacy), legacy);
    assert.deepEqual(
      carryGameInventory(bag(), [{ name: "Lantern", quantity: 1 }]).map((stack) => stack.holder ?? "player"),
      ["player", "Bram", "player", "Cass", "player"],
      "the next session keeps every bag, and a detailed-only item goes to the player",
    );
  }

  // ── Adding stays inside one bag ──
  {
    const toBram = addToGameInventory(bag(), "arrow", 3, nextId, "bram");
    assert.equal(toBram.find((stack) => stack.id === "b")?.quantity, 13, "Bram's arrows, matched any case");
    assert.equal(toBram.find((stack) => stack.id === "c")?.quantity, 5, "the player's arrows untouched");
    const toCass = addToGameInventory(bag(), "Rope", 1, nextId, "Cass");
    assert.deepEqual(toCass.at(-1), { id: `st-new-${counter}`, name: "Rope", quantity: 1, holder: "Cass" });
    assert.equal(toCass.find((stack) => stack.id === "a")?.quantity, 2, "the player's rope is not Cass's");
    const toPlayer = addToGameInventory(bag(), "Torch", 1, nextId);
    assert.equal(toPlayer.at(-1)?.holder, undefined, "no holder is the player's own bag");
  }

  // ── Taking by name: one bag, or the player's own first ──
  {
    const anyone = takeFromGameInventory(bag(), "Arrow", 7);
    assert.equal(anyone.taken, 7);
    assert.equal(
      anyone.stacks.find((stack) => stack.id === "c"),
      undefined,
      "the player's 5 went first",
    );
    assert.equal(anyone.stacks.find((stack) => stack.id === "b")?.quantity, 8, "then 2 of Bram's");
    const bramOnly = takeFromGameInventory(bag(), "Arrow", 99, { holder: "BRAM" });
    assert.equal(bramOnly.taken, 10);
    assert.equal(bramOnly.stacks.find((stack) => stack.id === "c")?.quantity, 5);
    assert.equal(takeFromGameInventory(bag(), "Torch", 1, {}).taken, 0, "the player has no torch");
    assert.equal(gameInventoryCount(bag(), "arrow"), 15);
    assert.equal(gameInventoryCount(bag(), "arrow", { holder: "Bram" }), 10);
    assert.equal(gameInventoryCount(bag(), "arrow", {}), 5);
  }

  // ── Bags for the Game Master: the player's first, empty ones left out ──
  {
    assert.deepEqual(gameInventoryBags(bag()), [
      {
        items: [
          { name: "Rope", quantity: 2 },
          { name: "Arrow", quantity: 5 },
        ],
      },
      { holder: "Bram", items: [{ name: "Arrow", quantity: 10 }] },
      { holder: "Cass", items: [{ name: "Torch", quantity: 1 }] },
    ]);
    assert.deepEqual(gameInventoryBags([{ id: "q", name: "Map", quantity: 1, holder: "Bram" }]), [
      { holder: "Bram", items: [{ name: "Map", quantity: 1 }] },
    ]);
    // The player's own bag leads even when a companion's stack is listed first.
    assert.deepEqual(
      gameInventoryBags([
        { id: "q", name: "Map", quantity: 1, holder: "Bram" },
        { id: "r", name: "Rope", quantity: 1 },
      ]).map((entry) => entry.holder ?? "player"),
      ["player", "Bram"],
    );
  }

  // ── Giving, swapping, renaming and merging across bags ──
  {
    const whole = giveGameInventoryStack(bag(), "a", "Bram", undefined, nextId);
    assert.deepEqual(whole?.stacks[0], { id: "a", name: "Rope", quantity: 2, holder: "Bram" }, "keeps its id");
    const part = giveGameInventoryStack(bag(), "c", "Bram", 2, nextId);
    assert.equal(part?.id, "b", "onto the receiver's own stack of the item");
    assert.equal(part?.stacks.find((stack) => stack.id === "b")?.quantity, 12);
    assert.equal(part?.stacks.find((stack) => stack.id === "c")?.quantity, 3);
    const back = giveGameInventoryStack(bag(), "d", undefined, undefined, nextId);
    assert.equal(back?.stacks.find((stack) => stack.id === "d")?.holder, undefined, "to the player");
    const unnamed = giveGameInventoryStack(bag(), "d", "…", undefined, nextId);
    assert.equal(unnamed?.stacks.find((stack) => stack.id === "d")?.holder, undefined, "a name keying to nothing too");
    const same = bag();
    assert.equal(giveGameInventoryStack(same, "b", "bram")?.stacks, same, "into its own bag changes nothing");
    for (const count of [0, 11, 1.5, Number.NaN]) {
      assert.equal(giveGameInventoryStack(bag(), "b", "Cass", count), null, `a count of ${count} is refused`);
    }
    assert.equal(giveGameInventoryStack(bag(), "missing", "Cass"), null);

    const swapped = swapGameInventoryStacks(bag(), "a", "d");
    assert.deepEqual(
      swapped.map((stack) => stack.id),
      ["d", "b", "c", "a"],
    );
    assert.equal(swapGameInventoryStacks(same, "a", "nope"), same);

    // Renaming pours only into the same bag's stack of the new name.
    const renamed = renameGameInventoryStack(bag(), "c", "Rope");
    assert.equal(renamed?.id, "a", "the player's arrows poured into the player's rope");
    const notAcross = renameGameInventoryStack(bag(), "d", "Rope");
    assert.equal(notAcross?.id, "d", "Cass's torch renamed, not poured into the player's rope");
    assert.equal(notAcross?.stacks.find((stack) => stack.id === "d")?.name, "Rope");

    // A merge follows its target, so dropping onto another bag's stack hands it over.
    const merged = mergeGameInventoryStacks(bag(), "c", "b");
    assert.deepEqual(
      merged.find((stack) => stack.id === "b"),
      {
        id: "b",
        name: "Arrow",
        quantity: 15,
        holder: "Bram",
      },
    );
  }

  // ── Operations: in order, results each, refusals change nothing and stop nothing ──
  {
    const outcome = applyGameInventoryOps(
      bag(),
      [
        { op: "add", name: "Map", count: 1, holder: "Cass", log: true },
        { op: "take", name: "Lantern", count: 1 },
        { op: "give", id: "b", to: "Cass", count: 4 },
        { op: "set", id: "a", quantity: 1 },
        { op: "split", id: "b", size: 2 },
        { op: "merge", from: "missing", into: "a" },
        { op: "rename", id: "d", name: "Brand" },
        { op: "swap", first: "a", second: "c" },
        { op: "take", name: "Arrow", count: 3, as: "used" },
      ],
      nextId,
    );
    assert.deepEqual(
      outcome.results.map((result) => (result.ok ? "ok" : result.reason)),
      ["ok", "none-held", "ok", "ok", "ok", "missing-stack", "ok", "ok", "ok"],
    );
    assert.deepEqual(outcome.results[0], {
      ok: true,
      id: outcome.results[0]!.ok ? outcome.results[0]!.id : "",
      count: 1,
      now: 1,
    });
    assert.equal(outcome.results[2]!.ok && outcome.results[2]!.now, 4, "Cass now holds 4 arrows");
    assert.deepEqual(outcome.journal, [
      { item: "Map", action: "acquired", quantity: 1 },
      { item: "Rope", action: "removed", quantity: 1 },
      { item: "Arrow", action: "used", quantity: 3 },
    ]);
    assert.deepEqual(outcome.renames, [{ from: "Torch", to: "Brand" }]);
    assert.equal(gameInventoryCount(outcome.stacks, "Arrow", {}), 2, "the player's arrows went first");
    // Nothing that was refused moved anything.
    const untouched = bag();
    const refused = applyGameInventoryOps(untouched, [
      { op: "set", id: "nope", quantity: 3 },
      { op: "split", id: "d", size: 1 },
      { op: "give", id: "a", to: "Bram", count: 3 },
    ]);
    assert.equal(refused.stacks, untouched);
    assert.deepEqual(
      refused.results.map((result) => (result.ok ? "ok" : result.reason)),
      ["missing-stack", "refused", "refused"],
    );
  }

  // ── The detailed inventory is the player's own bag, followed by difference ──
  {
    const detailed: InventoryItem[] = [
      { name: "Rope", description: "Hemp", quantity: 2, location: "pack" },
      { name: "Arrow", description: "", quantity: 5, location: "on_person" },
    ];
    const before = bag();
    // What a companion carries is theirs, however it changes.
    const betweenCompanions = applyGameInventoryOps(before, [{ op: "give", id: "b", to: "Cass" }]);
    assert.equal(
      followGameInventoryDetails(detailed, before, betweenCompanions.stacks),
      detailed,
      "a gift between two",
    );
    const bramGains = applyGameInventoryOps(before, [{ op: "add", name: "Arrow", count: 4, holder: "Bram" }]);
    assert.equal(followGameInventoryDetails(detailed, before, bramGains.stacks), detailed, "a companion's gain");
    const withTorch = [...detailed, { name: "Torch", description: "Pitch", quantity: 1, location: "pack" }];
    const cassRenames = applyGameInventoryOps(before, [{ op: "rename", id: "d", name: "Brand" }]);
    assert.equal(
      followGameInventoryDetails(withTorch, before, cassRenames.stacks, cassRenames.renames),
      withTorch,
      "a companion's rename leaves an entry of the old name alone",
    );
    // The player's own arrows, given away, leave it.
    const given = applyGameInventoryOps(before, [{ op: "give", id: "c", to: "Cass" }]);
    assert.deepEqual(followGameInventoryDetails(detailed, before, given.stacks), [detailed[0]]);
    const renamed = applyGameInventoryOps(before, [{ op: "rename", id: "a", name: "Hemp rope" }]);
    assert.deepEqual(followGameInventoryDetails(detailed, before, renamed.stacks, renamed.renames)[0], {
      name: "Hemp rope",
      description: "Hemp",
      quantity: 2,
      location: "pack",
    });
    // Taking takes the player's own first, and only that part leaves the player's list.
    const changed = applyGameInventoryOps(before, [
      { op: "take", name: "Arrow", count: 15 },
      { op: "add", name: "Map", count: 2 },
    ]);
    assert.deepEqual(followGameInventoryDetails(detailed, before, changed.stacks), [
      { name: "Rope", description: "Hemp", quantity: 2, location: "pack" },
      { name: "Map", description: "", quantity: 2, location: "on_person" },
    ]);
  }

  // ── The grammar: every old form, plus who, to and give ──
  {
    const forms: Array<[string, ReturnType<typeof parseInventoryTagBody>]> = [
      [
        ` action="add" item="Bronze Key, Health Potion"`,
        { action: "add", items: ["Bronze Key", "Health Potion"], count: 1 },
      ],
      [` add item="Bronze Key"`, { action: "add", items: ["Bronze Key"], count: 1 }],
      [` item="Bronze Key" action=add`, { action: "add", items: ["Bronze Key"], count: 1 }],
      [` items="Bronze Key, Map"`, { action: "add", items: ["Bronze Key", "Map"], count: 1 }],
      [` remove item=Bronze Key`, { action: "remove", items: ["Bronze Key"], count: 1 }],
      [
        ` action=remove item=Bronze Key who=Bram qty=3`,
        { action: "remove", items: ["Bronze Key"], count: 3, who: "Bram" },
      ],
      [
        ` action="give" item="Rope" count="2" who="Ada" to="Bram"`,
        { action: "give", items: ["Rope"], count: 2, who: "Ada", to: "Bram" },
      ],
      [` give item="Rope" to="Bram"`, { action: "give", items: ["Rope"], count: 1, to: "Bram" }],
      [` action="add" item="Gold" quantity="50000"`, { action: "add", items: ["Gold"], count: 9999 }],
      [` action="add" item="Gold" count="-3"`, { action: "add", items: ["Gold"], count: 1 }],
      [` action="remove" note="nothing named"`, null],
    ];
    for (const [body, expected] of forms) assert.deepEqual(parseInventoryTagBody(body), expected, body);
    // What the Game Master claims happened is not part of the request.
    assert.deepEqual(parseInventoryTagBody(` action="add" item="Gold" result="ok" now="999"`), {
      action: "add",
      items: ["Gold"],
      count: 1,
    });
    assert.equal(
      serializeInventoryTag(
        { action: "add", item: `Odd "Name" [x]`, count: 2, who: "Bram" },
        { ok: true, count: 2, now: 4 },
      ),
      `[inventory: action="add" item="Odd Name x" count="2" who="Bram" result="ok" now="4"]`,
    );
    assert.deepEqual(
      readResolvedInventoryTags(
        `A [inventory: action="remove" item="Rope" count="1" result="refused" reason="none-held"] b [inventory: action="add" item="Map"]`,
      ),
      [{ action: "remove", item: "Rope", count: 1, ok: false, reason: "none-held" }],
      "only answered tags are announced",
    );
  }

  // ── A count typed into the Give and Split rows is digits only ──
  {
    const { parseInventoryCount } = await import("../../packages/client/src/lib/game-inventory-amount.js");
    assert.equal(parseInventoryCount(" 2 ", 3), 2);
    assert.equal(parseInventoryCount("3", 3), 3);
    for (const text of ["2abc", "1.5", "", "0", "4", "-1", "+2", "1e2"]) {
      assert.equal(parseInventoryCount(text, 3), null, `"${text}" is not a count up to 3`);
    }
  }

  // ── Correcting a saved reply's answers: only the tags this telling added ──
  {
    const earlier = `[inventory: action="add" item="Map" count="1" result="ok" now="1"]`;
    const said = `[inventory: action="remove" item="Rope" count="1" result="ok" now="0"]`;
    const really = `[inventory: action="remove" item="Rope" count="1" result="refused" reason="none-held"]`;
    assert.equal(
      replaceTrailingInventoryTags(`${earlier} The rope snaps. ${said}`, [really]),
      `${earlier} The rope snaps. ${really}`,
      "a continuation keeps what its earlier part already said",
    );
    assert.equal(replaceTrailingInventoryTags(said, []), said);
    assert.equal(
      replaceTrailingInventoryTags(`no tags`, [really]),
      `no tags`,
      "more answers than tags changes nothing",
    );
  }

  // ── The browser announces answered tags only, as the player reaches them ──
  {
    const { parseGmTags, parseSegmentInventoryUpdates } =
      await import("../../packages/client/src/lib/game-tag-parser.js");
    const saved = [
      `The chest creaks open.`,
      `[inventory: action="add" item="Map" count="1" result="ok" now="1"]`,
      ``,
      `Bram pockets a coin. [inventory: action="add" item="Coin" count="1" who="Bram" result="ok" now="3"]`,
      `A stray request nobody answered. [inventory: action="add" item="Gold"]`,
    ].join("\n");
    const tags = parseGmTags(saved);
    assert.deepEqual(
      tags.inventoryUpdates.map((tag) => `${tag.item} ${tag.who ?? "player"}`),
      ["Map player", "Coin Bram"],
    );
    assert.doesNotMatch(tags.cleanContent, /\[inventory:/, "every tag, answered or not, is kept out of the narration");
    assert.deepEqual(
      parseSegmentInventoryUpdates(saved).map((entry) => `${entry.segment} ${entry.update.item}`),
      ["0 Map", "1 Coin"],
    );
  }

  // ── The tellings of one turn (#6774) ──
  {
    const start = [{ id: "r", name: "Rope", quantity: 1 }];
    const withSword = [...start, { id: "s", name: "Sword", quantity: 1 }];
    const withShield = [...start, { id: "h", name: "Shield", quantity: 1 }];
    const told = `[inventory: action="add" item="Sword" count="1" result="ok" now="1"]`;
    const turn = recordGameInventoryTelling("m1", start, {}, 0, withSword);
    assert.deepEqual(readGameInventoryTurn(JSON.parse(JSON.stringify(turn))), turn, "stored and read back");
    assert.equal(readGameInventoryTurn({ messageId: "", before: [] }), null);

    // A retelling starts where the turn began while the stacks are what the telling it replaces left.
    const again = gameInventoryTellingStart(turn, withSword, {
      kind: "regenerate",
      messageId: "m1",
      replaced: 0,
      replacedContent: told,
    });
    assert.deepEqual(again.start, start);
    assert.deepEqual(Object.keys(again.swipes), ["0"], "the replaced telling can still be swiped back to");
    // Changed since: it builds on the stacks as they are, and forgets what it can no longer undo.
    const edited = [...withSword, { id: "m", name: "Map", quantity: 1 }];
    const onTop = gameInventoryTellingStart(turn, edited, {
      kind: "regenerate",
      messageId: "m1",
      replaced: 0,
      replacedContent: told,
    });
    assert.equal(onTop.start, edited);
    assert.deepEqual(onTop.swipes, {});
    // A telling that changed nothing left the stacks as the turn began, whatever the record says.
    const quiet = gameInventoryTellingStart(null, start, {
      kind: "regenerate",
      messageId: "m2",
      replaced: 0,
      replacedContent: `[inventory: action="remove" item="Crown" count="1" result="refused" reason="none-held"]`,
    });
    assert.equal(quiet.start, start);
    assert.deepEqual(quiet.swipes, { "0": start });
    // A continuation adds to the telling, and a new turn starts fresh.
    const continued = gameInventoryTellingStart(turn, withSword, {
      kind: "continue",
      messageId: "m1",
      replaced: 0,
      replacedContent: told,
    });
    assert.equal(continued.start, withSword);
    assert.deepEqual(continued.before, start);
    assert.deepEqual(gameInventoryTellingStart(turn, withSword, { kind: "new" }).swipes, {});

    // Switching tellings shows what the other one left, only while nothing changed the stacks.
    const two = recordGameInventoryTelling("m1", start, turn.swipes, 1, withShield);
    assert.deepEqual(gameInventoryForTelling(two, withShield, "m1", 1, 0), withSword);
    assert.equal(gameInventoryForTelling(two, edited, "m1", 0, 1), null, "changed since: left alone");
    assert.equal(gameInventoryForTelling(two, withShield, "m2", 1, 0), null, "another turn: left alone");
    assert.equal(gameInventoryForTelling(two, withShield, "m1", 1, 7), null, "a telling it never saw");
    assert.ok(sameGameInventory(withSword, JSON.parse(JSON.stringify(withSword))));
    assert.ok(!sameGameInventory(withSword, withShield));
    // Only the newest tellings are kept.
    let many = recordGameInventoryTelling("m1", start, {}, 0, start);
    for (let swipe = 1; swipe < 30; swipe += 1)
      many = recordGameInventoryTelling("m1", start, many.swipes, swipe, start);
    assert.equal(Object.keys(many.swipes).length, 20);
    assert.equal(Object.keys(many.swipes)[0], "10");
  }

  // ── Who and to, matched like a sheet command's who ──
  {
    const party = { player: "Ada Lovelace", members: ["Bram", "Cass", "Cass"] };
    assert.deepEqual(resolveGameInventoryHolder(undefined, party), { ok: true, bag: undefined });
    assert.deepEqual(resolveGameInventoryHolder("party", party), { ok: true, bag: undefined });
    assert.deepEqual(resolveGameInventoryHolder("ada lovelace", party), { ok: true, bag: {} });
    assert.deepEqual(resolveGameInventoryHolder("BRAM", party), { ok: true, bag: { holder: "Bram" } });
    assert.deepEqual(resolveGameInventoryHolder("Cass", party), { ok: false, reason: "ambiguous-character" });
    assert.deepEqual(resolveGameInventoryHolder("Dmitri", party), { ok: false, reason: "unknown-character" });
    // Somebody who left the party but still carries something can still be named.
    assert.deepEqual(
      resolveGameInventoryHolder("dmitri", party, [{ id: "q", name: "Map", quantity: 1, holder: "Dmitri" }]),
      { ok: true, bag: { holder: "Dmitri" } },
    );
  }

  // ── A reply's tags, applied and answered ──
  {
    const party = { player: "Ada", members: ["Bram", "Cass"] };
    const reply = [
      `Ada pockets a map. [inventory: action="add" item="Map, Compass" count="2"]`,
      `Bram shoulders the rope. [inventory: action="give" item="Rope" count="1" to="Bram"]`,
      `[inventory: action="remove" item="Arrow" count="7"]`,
      `[inventory: action="remove" item="Torch" who="Bram"]`,
      `[inventory: action="add" item="Gold" who="Dmitri"]`,
      `[inventory: action="give" item="Rope"]`,
      `[inventory: action="add" item="Crown" result="ok" now="1"]`,
      `[inventory: gibberish]`,
    ].join("\n");
    const outcome = applyGameInventoryTags(reply, bag(), party, nextId);
    const resolved = readResolvedInventoryTags(outcome.content);
    assert.deepEqual(
      resolved.map((tag) => `${tag.action} ${tag.item} ${tag.ok ? `ok ${tag.count}->${tag.now}` : tag.reason}`),
      [
        "add Map ok 2->2",
        "add Compass ok 2->2",
        "give Rope ok 1->1",
        "remove Arrow ok 7->8",
        "remove Torch none-held",
        "add Gold unknown-character",
        "give Rope no-recipient",
        "add Crown ok 1->1",
      ],
    );
    assert.match(outcome.content, /\[inventory: raw="gibberish" result="refused" reason="unreadable"\]/);
    assert.equal(outcome.tags, 8);
    assert.equal(gameInventoryCount(outcome.stacks, "Rope", { holder: "Bram" }), 1);
    assert.equal(gameInventoryCount(outcome.stacks, "Arrow", {}), 0, "the player's 5 arrows went first");
    assert.equal(gameInventoryCount(outcome.stacks, "Arrow", { holder: "Bram" }), 8);
    assert.deepEqual(outcome.journal, [
      { item: "Map", action: "acquired", quantity: 2 },
      { item: "Compass", action: "acquired", quantity: 2 },
      { item: "Arrow", action: "lost", quantity: 7 },
      { item: "Crown", action: "acquired", quantity: 1 },
    ]);
    // A give with no who comes out of the player's own bag, never out of someone it did not name.
    const onlyCass = applyGameInventoryTags(`[inventory: action="give" item="Torch" to="Bram"]`, bag(), party, nextId);
    assert.deepEqual(
      readResolvedInventoryTags(onlyCass.content).map((tag) => tag.reason),
      ["none-held"],
    );
    assert.equal(gameInventoryCount(onlyCass.stacks, "Torch", { holder: "Cass" }), 1);

    // Past the cap, tags are answered as refused rather than read at any cost, even one that
    // claims it already happened.
    const flood = [
      ...Array.from({ length: 44 }, () => `[inventory: action="add" item="Pebble"]`),
      `[inventory: action="add" item="Crown" result="ok" now="1"]`,
    ].join(" ");
    const capped = applyGameInventoryTags(flood, [], party, nextId);
    assert.equal(gameInventoryCount(capped.stacks, "Pebble"), 40);
    const answers = readResolvedInventoryTags(capped.content);
    assert.equal(answers.filter((tag) => tag.ok).length, 40);
    assert.deepEqual(
      answers.filter((tag) => !tag.ok).map((tag) => `${tag.item} ${tag.reason}`),
      ["Pebble too-many", "Pebble too-many", "Pebble too-many", "Pebble too-many", "Crown too-many"],
    );

    // A reply whose tags could not be carried out at all says that nothing happened.
    const unapplied = refuseGameInventoryTags(
      `A crown! [inventory: action="add" item="Crown, Orb" result="ok" now="1"] [inventory: nonsense]`,
      "unapplied",
    );
    assert.deepEqual(
      readResolvedInventoryTags(unapplied).map((tag) => `${tag.item} ${tag.ok ? "ok" : tag.reason}`),
      ["Crown unapplied", "Orb unapplied"],
    );
    assert.match(unapplied, /\[inventory: raw="nonsense" result="refused" reason="unapplied"\]/);
  }

  // ── The route and the storage ──
  const Fastify = createRequire(new URL("../../packages/server/package.json", import.meta.url))(
    "fastify",
  ) as typeof import("fastify").default;
  const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
  const { createGameStateStorage } = await import("../../packages/server/src/services/storage/game-state.storage.js");
  const { gameInventoryRoutes } = await import("../../packages/server/src/routes/game-inventory.routes.js");
  const { commitGameInventoryChange, followGameInventoryOnRow } =
    await import("../../packages/server/src/services/game/game-inventory.service.js");
  const { buildGmFormatReminder } = await import("../../packages/server/src/services/game/gm-prompts.js");
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameInventoryRoutes, { prefix: "/inventory" });
  const chats = createChatsStorage(db);
  const states = createGameStateStorage(db);
  try {
    const chat = await chats.create({ name: "Bags proof", mode: "game", characterIds: [] });
    const message = await chats.createMessage({ chatId: chat.id, role: "assistant", content: "The road." });
    await chats.patchMetadata(chat.id, { gameInventory: bag() });
    const stats = (inventory: InventoryItem[]) => ({
      stats: [],
      attributes: null,
      skills: {},
      inventory,
      activeQuests: [],
      status: "",
    });
    await states.create({
      chatId: chat.id,
      messageId: message.id,
      swipeIndex: 0,
      date: null,
      time: null,
      location: null,
      weather: null,
      temperature: null,
      presentCharacters: [],
      recentEvents: [],
      playerStats: stats([{ name: "Rope", description: "Hemp", quantity: 2, location: "pack" }]) as never,
      personaStats: null,
    });
    const post = (payload: unknown) => app.inject({ method: "POST", url: "/inventory", payload });
    const readChat = async () => {
      const row = await chats.getById(chat.id);
      return (typeof row!.metadata === "string" ? JSON.parse(row!.metadata) : row!.metadata) as Record<string, any>;
    };
    const readRow = async () => {
      const row = await states.getByChatAndMessage(chat.id, message.id, 0);
      return JSON.parse(row!.playerStats as string) as { inventory: InventoryItem[] };
    };

    const response = await post({
      chatId: chat.id,
      ops: [
        { op: "set", id: "a", quantity: 1 },
        { op: "give", id: "c", to: "Cass" },
        { op: "take", name: "Lantern", count: 1 },
      ],
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as {
      inventory: GameInventoryStack[];
      results: Array<{ ok: boolean }>;
      playerStats?: unknown;
    };
    assert.deepEqual(
      body.results.map((result) => result.ok),
      [true, true, false],
    );
    const meta = await readChat();
    assert.deepEqual(meta.gameInventory, body.inventory, "the stacks the route answered with are the saved ones");
    assert.equal(normalizeGameInventoryStacks(meta.gameInventory).find((stack) => stack.id === "c")?.holder, "Cass");
    assert.deepEqual(
      (meta.gameJournal?.inventoryLog ?? []).map((entry: { item: string; action: string; quantity: number }) => [
        entry.item,
        entry.action,
        entry.quantity,
      ]),
      [["Rope", "removed", 1]],
      "the journal in the same write",
    );
    assert.deepEqual((await readRow()).inventory, [
      { name: "Rope", description: "Hemp", quantity: 1, location: "pack" },
    ]);
    assert.ok(body.playerStats, "the stats written come back for the screen");

    // A malformed request changes nothing at all.
    const before = await readChat();
    for (const payload of [
      { chatId: chat.id, ops: [] },
      { chatId: chat.id, ops: [{ op: "add", name: "Map", count: 0 }] },
      {
        chatId: chat.id,
        ops: [
          { op: "add", name: "Map", count: 1 },
          { op: "teleport", id: "a" },
        ],
      },
      { chatId: chat.id, ops: [{ op: "give", id: "a", to: "x".repeat(81) }] },
    ]) {
      assert.equal((await post(payload)).statusCode, 400, JSON.stringify(payload));
    }
    assert.deepEqual((await readChat()).gameInventory, before.gameInventory);
    assert.equal((await post({ chatId: "no-such-chat", ops: [{ op: "add", name: "Map", count: 1 }] })).statusCode, 404);

    // A change that refuses itself leaves everything as it was, the journal included.
    await assert.rejects(
      commitGameInventoryChange(db, chat.id, () => {
        throw new Error("refused whole");
      }),
      /refused whole/,
    );
    assert.deepEqual((await readChat()).gameInventory, before.gameInventory);

    // A turn's tags: the stacks first, then the turn's own row, cloned from the one before it.
    const turn = await chats.createMessage({ chatId: chat.id, role: "assistant", content: "Next." });
    const committed = await commitGameInventoryChange(
      db,
      chat.id,
      (stacks) => {
        const outcome = applyGameInventoryTags(`[inventory: action="add" item="Rope" count="2"]`, stacks, {
          members: ["Cass"],
        });
        return {
          stacks: outcome.stacks,
          journal: outcome.journal,
          value: { before: stacks, content: outcome.content },
        };
      },
      { kind: "none" },
    );
    assert.ok(committed);
    const baseSnapshot = await states.getByChatAndMessage(chat.id, message.id, 0);
    await followGameInventoryOnRow(db, chat.id, committed.value.before, committed.stacks, {
      kind: "message",
      messageId: turn.id,
      swipeIndex: 0,
      baseSnapshot,
    });
    const turnRow = async () =>
      JSON.parse((await states.getByChatAndMessage(chat.id, turn.id, 0))!.playerStats as string) as {
        inventory: InventoryItem[];
      };
    assert.equal((await turnRow()).inventory[0]!.quantity, 3, "the turn's row has the rope it gained");
    assert.equal((await readRow()).inventory[0]!.quantity, 1, "the turn before keeps what it had");

    // A tracker that rebuilds the turn's row from the turn before keeps what the tags did.
    const rebuild = (inventory: InventoryItem[], keepReplacedInventory?: boolean) =>
      states.create(
        {
          chatId: chat.id,
          messageId: turn.id,
          swipeIndex: 0,
          date: "Day 2",
          time: null,
          location: null,
          weather: null,
          temperature: null,
          presentCharacters: [],
          recentEvents: [],
          playerStats: stats(inventory) as never,
          personaStats: null,
        },
        null,
        keepReplacedInventory === undefined ? undefined : { keepReplacedInventory },
      );
    const turnBefore = [{ name: "Rope", description: "Hemp", quantity: 1, location: "pack" }];
    await rebuild(turnBefore, true);
    assert.equal((await turnRow()).inventory[0]!.quantity, 3);
    // Any other write of the row keeps the inventory it is given, an empty one included.
    await rebuild(turnBefore);
    assert.equal((await turnRow()).inventory[0]!.quantity, 1);
    await rebuild([]);
    assert.deepEqual((await turnRow()).inventory, []);
  } finally {
    await app.close();
    await closeDB();
  }

  // ── What the Game Master is shown ──
  {
    const base = { hasSceneModel: true, playerName: "Ada" } as never as Parameters<typeof buildGmFormatReminder>[0];
    const playerOnly = buildGmFormatReminder({
      ...base,
      playerInventory: [{ name: "Rope", quantity: 2 }],
      partyInventory: gameInventoryBags([{ id: "a", name: "Rope", quantity: 2 }]),
    });
    assert.match(playerOnly, /PLAYER INVENTORY: Rope ×2/, "only the player carries anything: the line is as it was");
    assert.doesNotMatch(playerOnly, /PARTY INVENTORY/);
    const shared = buildGmFormatReminder({
      ...base,
      playerInventory: [{ name: "Rope", quantity: 2 }],
      partyInventory: gameInventoryBags(bag()),
    });
    assert.match(shared, /PARTY INVENTORY:\n- Ada: Rope ×2; Arrow ×5\n- Bram: Arrow ×10\n- Cass: Torch/);
    assert.doesNotMatch(shared, /PLAYER INVENTORY/);
    assert.match(
      shared,
      /\[inventory: action="add\|remove\|give" item="Item A, Item B" count="3" who="Name" to="Name"\]/,
    );
    assert.match(shared, /Never write result, reason or now yourself/);
  }

  console.info("game inventory bag regressions passed.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
}
