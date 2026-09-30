/**
 * A ruleset's items in the Engine's own Classic and Tactical battles (#6905, slice I8-1).
 *
 *   - An item's `use` is its fight effect: heal, harm, a condition by its own name, used up or kept,
 *     on the combat bridge's scale. Nothing the Engine could do, charges and a gate: not offered.
 *   - A battle offers the ruleset's items only with an effect, and the rest while native items are on;
 *     a guess is never kept for one of the ruleset's items.
 *   - A ruleset heal heals by its own strength; a guessed heal still goes by its name.
 *   - The encounter's start asks the model only about the other items, the director works the effects
 *     out itself, and the Classic round route refuses an item the battle does not offer and puts the
 *     worked-out effect on one of the ruleset's.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  gameFightItems,
  gameInventoryFightLines,
  parseRulesetDefinition,
  rulesetItemBook,
  rulesetItemFightEffect,
  type CombatItemEffect,
  type GameInventoryStack,
  type RulesetCatalogEntry,
  type RulesetDefinition,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-ruleset-classic-items-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createGameStateStorage } = await import("../../packages/server/src/services/storage/game-state.storage.js");
const { createGameEngineStateStorage } =
  await import("../../packages/server/src/services/storage/game-engine-state.storage.js");
const { createGameRulesetsStorage } =
  await import("../../packages/server/src/services/storage/game-rulesets.storage.js");
const { resolveCombatRound } = await import("../../packages/server/src/services/game/combat.service.js");
const { loadGameFightItems } = await import("../../packages/server/src/services/game/game-inventory.service.js");
const { encounterRoutes } = await import("../../packages/server/src/routes/encounter.routes.js");
const { gameRoutes } = await import("../../packages/server/src/routes/game.routes.js");
const { combatDirectorRoutes, COMBAT_DIRECTOR_NAMESPACE } =
  await import("../../packages/server/src/routes/combat-director.routes.js");

let replyText = "{}";
let prompt = "";
const provider = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  prompt = JSON.stringify(JSON.parse(raw).messages);
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      id: "local-proof",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: replyText }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  );
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await app.register(encounterRoutes, { prefix: "/encounter" });
await app.register(gameRoutes, { prefix: "/game" });
await app.register(combatDirectorRoutes, { prefix: "/combat", chooseBoss: async () => "" });

try {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const emberText = read("../../docs/examples/rulesets/ember-roads.json");
  const gravewatchText = read("../../docs/examples/rulesets/gravewatch.json");
  const variant = (text: string, edit: (doc: Record<string, any>) => void = () => {}): Record<string, any> => {
    const doc = JSON.parse(text) as Record<string, any>;
    edit(doc);
    return doc;
  };
  const parsedOrThrow = (document: unknown, what: string): RulesetDefinition => {
    const parsed = parseRulesetDefinition(document);
    assert.ok(parsed.ok, `${what} must import cleanly: ${parsed.ok ? "" : parsed.issues.join("; ")}`);
    return parsed.definition;
  };
  const entriesOf = (definition: RulesetDefinition): Record<string, RulesetCatalogEntry[]> =>
    Object.fromEntries(
      (definition.catalogs ?? []).flatMap((catalog) =>
        catalog.entries && catalog.holds !== "rows" ? [[catalog.id, catalog.entries]] : [],
      ),
    );
  /** Ember Roads with two more things to use in a fight, and without the fights it resolves itself (and
   *  so its bestiary), so its battles are the Engine's own. */
  const emberDoc = variant(emberText, (doc) => {
    delete doc.combat;
    doc.catalogs = doc.catalogs.filter((catalog: { holds?: string }) => catalog.holds !== "creatures");
    const outfitter = doc.catalogs.find((catalog: { id: string }) => catalog.id === "outfitter");
    outfitter.entries.push(
      {
        id: "firepot",
        label: "Firepot",
        item: {
          category: "gear",
          use: {
            kind: "attack",
            targets: "enemy",
            amount: { dice: "2d6" },
            damageType: "fire",
            applies: [{ condition: "shaken", duration: { rounds: 3 } }],
            consumes: true,
          },
        },
      },
      {
        id: "war-horn",
        label: "War horn",
        item: { category: "gear", use: { kind: "buff", targets: "ally" } },
      },
    );
  });
  const ember = parsedOrThrow(emberDoc, "Ember Roads for the Engine's own battles");
  const emberBook = rulesetItemBook(ember, entriesOf(ember));
  const gravewatch = parsedOrThrow(JSON.parse(gravewatchText), "Gravewatch");
  const graveBook = rulesetItemBook(gravewatch, entriesOf(gravewatch));
  const effectOf = (book: typeof emberBook, item: string, name = book.itemOf(item)!.name) =>
    rulesetItemFightEffect(name, book.itemOf(item));

  // ── An item's use is its fight effect ──
  {
    assert.deepEqual(effectOf(emberBook, "outfitter/poultice"), {
      name: "Poultice",
      target: "ally",
      type: "heal",
      description: "heals 1d4 + 1, range 0",
      // 1d4 + 1 is 3.5 on average: half a typical hit, and a typical hit is 0.22 of a maximum.
      power: 0.11,
      consumes: true,
      ruleset: true,
    });
    assert.deepEqual(effectOf(emberBook, "outfitter/firepot"), {
      name: "Firepot",
      target: "enemy",
      type: "damage",
      description: "2d6 fire, Shaken",
      power: 0.22,
      element: "fire",
      status: { name: "Shaken", emoji: "💢", duration: 3 },
      consumes: true,
      ruleset: true,
    });
    // A buff is its status alone, kept rather than used up.
    assert.deepEqual(effectOf(emberBook, "outfitter/war-horn"), {
      name: "War horn",
      target: "ally",
      type: "buff",
      description: "War horn",
      consumes: false,
      ruleset: true,
    });
    // Under the name the fight lists it by.
    assert.equal(effectOf(emberBook, "outfitter/poultice", "Poultice (Green)")?.name, "Poultice (Green)");
    // A heal of one is as little as an effect goes, a twentieth.
    assert.equal(effectOf(graveBook, "kit/warming-tonic")?.power, 0.05);
    // Charges, a gate, no use at all: not in the Engine's own battles.
    assert.equal(effectOf(graveBook, "kit/dawn-bell"), null, "charges wait for I8-2");
    assert.equal(effectOf(graveBook, "kit/litany-page"), null, "a gate waits for I8-2");
    assert.equal(effectOf(emberBook, "outfitter/leather-coat"), null);
    assert.equal(rulesetItemFightEffect("Nothing", undefined), null);
    // Crafted uses, one part at a time.
    const withUse = (use: Record<string, unknown>) => {
      const definition = parsedOrThrow(
        variant(JSON.stringify(emberDoc), (doc) => {
          doc.catalogs.find((catalog: { id: string }) => catalog.id === "outfitter").entries[0].item.use = use;
        }),
        `a hand axe used as ${JSON.stringify(use)}`,
      );
      return rulesetItemFightEffect(
        "Hand axe",
        rulesetItemBook(definition, entriesOf(definition)).itemOf("outfitter/hand-axe"),
      );
    };
    assert.equal(withUse({ kind: "heal", targets: "self" }), null, "a heal with no amount does nothing here");
    assert.equal(withUse({ kind: "attack", targets: "enemy" }), null, "nor an attack with nothing");
    assert.deepEqual(
      withUse({ kind: "attack", applies: [{ condition: "pinned", duration: "instant" }] }),
      {
        name: "Hand axe",
        target: "enemy",
        type: "status",
        description: "Pinned",
        status: { name: "Pinned", emoji: "💢", duration: 2 },
        consumes: false,
        ruleset: true,
      },
      "an attack that only puts a condition on is a status, for two rounds without its own",
    );
    assert.equal(withUse({ kind: "heal", targets: "any", amount: { flat: 100 } })?.power, 1, "at most all of it");
    assert.equal(withUse({ kind: "heal", targets: "any", amount: { flat: 100 } })?.target, "any");
    assert.equal(withUse({ kind: "debuff" })?.target, "enemy");
    assert.equal(withUse({ kind: "debuff" })?.power, undefined, "a debuff is its status alone");
    assert.equal(withUse({ kind: "buff", amount: { flat: 7 } })?.power, undefined, "and so is a buff");
  }

  // ── Which items a battle offers ──
  {
    const stacks: GameInventoryStack[] = [
      { id: "s1", name: "Rope", quantity: 1 },
      { id: "s2", name: "Poultice", quantity: 3, item: "outfitter/poultice" },
      { id: "s3", name: "Leather coat", quantity: 1, item: "outfitter/leather-coat" },
      { id: "s4", name: "Firepot", quantity: 2, item: "outfitter/firepot", holder: "Bram" },
    ];
    const lines = gameInventoryFightLines(stacks);
    const guess = (name: string, extra: Partial<CombatItemEffect> = {}): CombatItemEffect => ({
      name,
      target: "ally",
      type: "heal",
      description: "guessed",
      power: 2,
      ...extra,
    });
    const guessed = [
      guess("Rope", { type: "utility" }),
      guess("Poultice"),
      guess("Leather coat"),
      guess("Stone", { ruleset: true }),
    ];
    const on = gameFightItems(lines, emberBook, true, guessed);
    assert.deepEqual(
      on.lines.map((line) => line.name),
      ["Rope", "Poultice", "Firepot"],
      "a plain item and the ruleset's usable ones; the coat has no use",
    );
    assert.deepEqual(
      on.effects.map((effect) => [effect.name, effect.description]),
      [
        ["Poultice", "heals 1d4 + 1, range 0"],
        ["Firepot", "2d6 fire, Shaken"],
        ["Rope", "guessed"],
      ],
      "the guesses for the ruleset's items, and one that claims to be the ruleset's, are gone",
    );
    const off = gameFightItems(lines, emberBook, false, guessed);
    assert.deepEqual(
      off.lines.map((line) => line.name),
      ["Poultice", "Firepot"],
      "native items off: only the ruleset's usable items",
    );
    assert.deepEqual(
      off.effects.map((effect) => effect.name),
      ["Poultice", "Firepot"],
    );
    // No book: every item is guessed at, as before, but a guess never passes for the ruleset's.
    const none = gameFightItems(lines, undefined, true, guessed);
    assert.deepEqual(
      none.lines.map((line) => line.name),
      ["Rope", "Poultice", "Leather coat", "Firepot"],
    );
    assert.deepEqual(
      none.effects.map((effect) => effect.name),
      ["Rope", "Poultice", "Leather coat"],
    );
  }

  // ── A plain item that shares a ruleset item's name keeps its own guess, in either order ──
  {
    const guess: CombatItemEffect = { name: "Poultice", target: "enemy", type: "damage", description: "guessed" };
    for (const [first, second] of [
      ["plain", "ruleset"],
      ["ruleset", "plain"],
    ]) {
      const stacks = [first, second].map((kind, index): GameInventoryStack =>
        kind === "plain"
          ? { id: `p${index}`, name: "Poultice", quantity: 1 }
          : { id: `r${index}`, name: "Poultice", quantity: 1, item: "outfitter/poultice" },
      );
      const fight = gameFightItems(gameInventoryFightLines(stacks), emberBook, true, [guess]);
      const effectOfLine = (item: string | undefined) => {
        const line = fight.lines.find((each) => each.item === item)!;
        return fight.effects.find((effect) => effect.name === line.name)?.description;
      };
      assert.equal(effectOfLine(undefined), "guessed", `${first} first: the plain poultice keeps the guess`);
      assert.equal(effectOfLine("outfitter/poultice"), "heals 1d4 + 1, range 0", `${first} first`);
      assert.equal(fight.effects.length, 2, `${first} first: nothing else`);
    }
  }

  // ── A ruleset heal heals by its own strength ──
  {
    const hero = {
      id: "hero",
      name: "Hero",
      side: "player" as const,
      hp: 20,
      maxHp: 100,
      mp: 0,
      maxMp: 0,
      attack: 10,
      defense: 5,
      speed: 5,
      level: 1,
    };
    const foe = { ...hero, id: "foe", name: "Foe", side: "enemy" as const, hp: 100 };
    const healed = (itemEffect: CombatItemEffect, itemId = "Poultice") => {
      const result = resolveCombatRound(
        [structuredClone(hero), structuredClone(foe)],
        1,
        "normal",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { actorId: "hero", defendingIds: new Set(), action: { type: "item", itemId, targetId: "hero", itemEffect } },
      );
      return result.actions.find((action) => action.skillName === itemId)!.remainingHp - hero.hp;
    };
    const poultice = effectOf(emberBook, "outfitter/poultice")!;
    assert.equal(healed(poultice), 11, "0.11 of 100");
    assert.equal(healed({ ...poultice, power: 0.5 }), 50);
    const { ruleset: _ruleset, ...guessedHeal } = poultice;
    assert.equal(healed({ ...guessedHeal, power: 0.9 }), 30, "a guessed heal still goes by its name");
    assert.equal(healed({ ...guessedHeal, power: 0.9 }, "Minor tonic"), 20);
  }

  // ── Through the routes ──
  const chats = createChatsStorage(db);
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  const connection = await createConnectionsStorage(db).create({
    name: "Local encounter fixture",
    provider: "custom",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    model: "fixture-model",
    treatAsLocalEndpoint: true,
  });
  const pin = async (id: string, document: Record<string, unknown>, definition: RulesetDefinition) => {
    await createGameRulesetsStorage(db).put({
      rulesetId: `local/${id}`,
      version: definition.version,
      sourceKind: "local",
      definition: JSON.stringify({ ...document, id }),
    });
    return { id: `local/${id}`, version: definition.version, packageId: null, options: {} };
  };
  const emberPin = await pin("ember-classic-items", emberDoc, ember);
  const closedDoc = variant(JSON.stringify(emberDoc), (doc) => (doc.items.native = false));
  const closedPin = await pin("ember-classic-closed", closedDoc, parsedOrThrow(closedDoc, "Ember with native off"));
  const bags: GameInventoryStack[] = [
    { id: "s1", name: "Rope", quantity: 1 },
    { id: "s2", name: "Poultice", quantity: 3, item: "outfitter/poultice" },
    { id: "s3", name: "Leather coat", quantity: 1, item: "outfitter/leather-coat" },
  ];
  const newGame = async (gameRuleset: unknown) => {
    const chat = await chats.create({ name: "Classic", mode: "game", characterIds: [], connectionId: connection.id });
    const anchor = await chats.createMessage({ chatId: chat.id, role: "assistant", content: "[state: combat]" });
    await chats.patchMetadata(chat.id, {
      gameRuleset,
      gameSetupConfig: { combatDirector: true, difficulty: "Normal" },
      gameInventory: bags,
    });
    await createGameStateStorage(db).create({
      chatId: chat.id,
      messageId: anchor.id,
      swipeIndex: 0,
      date: "",
      time: "",
      location: "road",
      weather: "",
      temperature: "",
      presentCharacters: [],
      recentEvents: [],
      playerStats: null,
      personaStats: null,
    });
    return { chatId: chat.id, anchor: anchor.id };
  };

  // The server's own reading.
  {
    const game = await newGame(emberPin);
    const meta = JSON.parse((await chats.getById(game.chatId))!.metadata as string);
    const fight = await loadGameFightItems(db, meta, [
      { name: "Poultice", target: "enemy", type: "damage", description: "forged", power: 2.5 },
    ]);
    assert.deepEqual(
      fight.lines.map((line) => line.name),
      ["Rope", "Poultice"],
    );
    assert.equal(fight.effects.find((effect) => effect.name === "Poultice")?.type, "heal", "never the screen's");
    const plain = await newGame(null);
    const plainMeta = JSON.parse((await chats.getById(plain.chatId))!.metadata as string);
    assert.deepEqual(
      (await loadGameFightItems(db, plainMeta, [])).lines.map((line) => line.name),
      ["Rope", "Poultice", "Leather coat"],
      "a game without a ruleset offers every item",
    );
  }

  // The encounter's start: the model is told which items to leave alone, and its guesses for them go.
  {
    const game = await newGame(emberPin);
    replyText = JSON.stringify({
      party: [{ name: "Hero" }],
      enemies: [{ name: "Rat" }],
      itemEffects: [
        { name: "Rope", target: "enemy", type: "status", description: "tangles", power: 0.2 },
        { name: "Poultice", target: "enemy", type: "damage", description: "guessed", power: 2 },
      ],
    });
    const started = await app.inject({
      method: "POST",
      url: "/encounter/init",
      payload: { chatId: game.chatId, settings: {} },
    });
    assert.equal(started.statusCode, 200, started.body);
    assert.match(prompt, /already says what these items do, so give no itemEffects for them: Poultice, Leather coat\./);
    const effects = started.json().combatState.itemEffects as CombatItemEffect[];
    assert.deepEqual(
      effects.map((effect) => [effect.name, effect.description, effect.ruleset ?? false]),
      [
        ["Poultice", "heals 1d4 + 1, range 0", true],
        ["Rope", "tangles", false],
      ],
    );
    const closed = await newGame(closedPin);
    const closedStart = await app.inject({
      method: "POST",
      url: "/encounter/init",
      payload: { chatId: closed.chatId, settings: {} },
    });
    assert.equal(closedStart.statusCode, 200, closedStart.body);
    assert.match(prompt, /says what its own items do in a fight, so give no itemEffects/);
    assert.doesNotMatch(prompt, /itemEffects\\": \[/);
    assert.deepEqual(
      (closedStart.json().combatState.itemEffects as CombatItemEffect[]).map((effect) => effect.name),
      ["Poultice"],
    );
  }

  // The Classic round route: the ruleset's effect, whatever the screen sent; an item the battle does
  // not offer is refused.
  {
    const game = await newGame(emberPin);
    const combatants = [
      {
        id: "hero",
        name: "Hero",
        side: "player",
        hp: 20,
        maxHp: 100,
        mp: 0,
        maxMp: 0,
        attack: 10,
        defense: 5,
        speed: 5,
        level: 1,
      },
      {
        id: "rat",
        name: "Rat",
        side: "enemy",
        hp: 100,
        maxHp: 100,
        mp: 0,
        maxMp: 0,
        attack: 1,
        defense: 1,
        speed: 1,
        level: 1,
      },
    ];
    const round = (playerAction: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: "/game/combat/round",
        payload: { chatId: game.chatId, round: 1, combatants, playerAction },
      });
    const forged = await round({
      type: "item",
      itemId: "Poultice",
      targetId: "hero",
      itemEffect: { name: "Poultice", target: "enemy", type: "damage", description: "forged", power: 2.5 },
    });
    assert.equal(forged.statusCode, 200, forged.body);
    const heal = forged.json().result.actions.find((action: { skillName?: string }) => action.skillName === "Poultice");
    assert.equal(heal.defenderId, "hero");
    assert.equal(heal.isHeal, true);
    assert.equal(heal.finalDamage, 11, "the poultice's own 0.11 of 100, not the forged harm");
    const coat = await round({ type: "item", itemId: "Leather coat", targetId: "hero" });
    assert.equal(coat.statusCode, 400);
    assert.match(coat.body, /That item does nothing in this fight/);
    const missing = await round({ type: "item", itemId: "Elixir", targetId: "hero" });
    assert.equal(missing.statusCode, 400);
    const rope = await round({ type: "item", itemId: "Rope", targetId: "hero" });
    assert.equal(rope.statusCode, 200, "a plain item is used as guessed");
    // A plain item cannot pass for the ruleset's: the mark is not read from the screen, so this heal goes
    // by its name (0.3), not by the forged strength.
    const markedRope = await round({
      type: "item",
      itemId: "Rope",
      targetId: "hero",
      itemEffect: { name: "Rope", target: "ally", type: "heal", description: "forged", power: 1, ruleset: true },
    });
    assert.equal(markedRope.statusCode, 200, markedRope.body);
    assert.equal(
      markedRope.json().result.actions.find((action: { skillName?: string }) => action.skillName === "Rope")
        .finalDamage,
      30,
    );
    // The screen-played Tactical engine heals with whatever it is handed, so it takes only a plain item
    // the battle offers, never one of the ruleset's.
    const tacticalUnit = (id: string, side: "player" | "enemy") => ({
      id,
      name: id,
      side,
      hp: 30,
      maxHp: 30,
      attack: 5,
      defense: 5,
      speed: 5,
      level: 1,
    });
    const tactical = await app.inject({
      method: "POST",
      url: "/game/combat/tactical/start",
      payload: {
        chatId: game.chatId,
        party: [tacticalUnit("hero", "player")],
        enemies: [tacticalUnit("rat", "enemy")],
        seed: 3,
      },
    });
    assert.equal(tactical.statusCode, 200, tactical.body);
    const tacticalItem = (itemName: string) =>
      app.inject({
        method: "POST",
        url: "/game/combat/tactical/action",
        payload: {
          chatId: game.chatId,
          state: tactical.json().state,
          action: { type: "item", unitId: "hero", itemName, targetId: "hero" },
        },
      });
    for (const refused of ["Poultice", "Leather coat", "Elixir"]) {
      const answer = await tacticalItem(refused);
      assert.equal(answer.statusCode, 400, `${refused}: ${answer.body}`);
      assert.match(answer.body, /That item does nothing in this fight/);
    }
    assert.equal((await tacticalItem("Rope")).statusCode, 200);
    const plainGame = await newGame(null);
    const plainTactical = await app.inject({
      method: "POST",
      url: "/game/combat/tactical/start",
      payload: {
        chatId: plainGame.chatId,
        party: [tacticalUnit("hero", "player")],
        enemies: [tacticalUnit("rat", "enemy")],
        seed: 3,
      },
    });
    const plainTacticalItem = await app.inject({
      method: "POST",
      url: "/game/combat/tactical/action",
      payload: {
        chatId: plainGame.chatId,
        state: plainTactical.json().state,
        action: { type: "item", unitId: "hero", itemName: "Elixir", targetId: "hero" },
      },
    });
    assert.equal(plainTacticalItem.statusCode, 200, "nor is screen-played Tactical");
    const closed = await newGame(closedPin);
    const closedRope = await app.inject({
      method: "POST",
      url: "/game/combat/round",
      payload: { chatId: closed.chatId, round: 1, combatants, playerAction: { type: "item", itemId: "Rope" } },
    });
    assert.equal(closedRope.statusCode, 400, "native items off: a plain item is not offered");
    const closedPoultice = await app.inject({
      method: "POST",
      url: "/game/combat/round",
      payload: {
        chatId: closed.chatId,
        round: 1,
        combatants,
        partyActions: { hero: { type: "item", itemId: "Poultice", targetId: "hero" } },
      },
    });
    assert.equal(closedPoultice.statusCode, 200, "but the ruleset's own poultice is");
    // A game without ruleset items is checked no more than it ever was: an item it does not hold is
    // still used as the screen sent it.
    const plain = await newGame(null);
    const unheld = await app.inject({
      method: "POST",
      url: "/game/combat/round",
      payload: {
        chatId: plain.chatId,
        round: 1,
        combatants,
        playerAction: { type: "item", itemId: "Elixir", targetId: "hero" },
      },
    });
    assert.equal(unheld.statusCode, 200, unheld.body);
  }

  // The combat director works the effects out itself.
  {
    const game = await newGame(emberPin);
    const unit = (id: string, name: string, side: "player" | "enemy") => ({
      id,
      name,
      side,
      hp: 30,
      maxHp: 30,
      attack: 8,
      defense: 6,
      speed: 6,
      level: 3,
      skills: [],
    });
    const start = await app.inject({
      method: "POST",
      url: "/combat/start",
      payload: {
        chatId: game.chatId,
        anchor: game.anchor,
        style: "classic",
        party: [unit("hero", "Hero", "player")],
        enemies: [unit("rat", "Rat", "enemy")],
        itemEffects: [
          { name: "Poultice", target: "enemy", type: "damage", description: "forged", power: 2.5, ruleset: true },
          { name: "Leather coat", target: "ally", type: "heal", description: "guessed" },
          { name: "Rope", target: "enemy", type: "status", description: "tangles" },
        ],
      },
    });
    assert.equal(start.statusCode, 200, start.body);
    assert.deepEqual(
      (start.json().session as { inventory: Array<{ name: string }> }).inventory.map((line) => line.name),
      ["Rope", "Poultice"],
    );
    const row = await createGameEngineStateStorage(db).getByChatAndMessage(
      game.chatId,
      game.anchor,
      0,
      COMBAT_DIRECTOR_NAMESPACE,
    );
    const state = JSON.parse(row!.state) as { itemEffects: CombatItemEffect[] };
    assert.deepEqual(
      state.itemEffects.map((effect) => [effect.name, effect.type, effect.description]),
      [
        ["Poultice", "heal", "heals 1d4 + 1, range 0"],
        ["Rope", "status", "tangles"],
      ],
    );
  }

  console.info("game ruleset classic items regressions passed.");
} finally {
  await app.close();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
