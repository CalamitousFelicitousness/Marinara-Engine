/**
 * Starting gear (P1-6, Capability API 1.73): gear a character may take into their bag at the start,
 * never on its own.
 *
 *   - The schema: lines of the ruleset's items, coins, one of a list, or a plain item; choices of
 *     options; `fits` read off the sheet; every item, coin and word checked at import; the 1.73 gate.
 *   - The resolver: every choice needs an option, every list a pick that is one of it and one of the
 *     game's own items; lines merge by item; what a layer took out of the game is left out and named.
 *   - The route: into one bag, all of it or none of it, once for each group unless asked again, armor
 *     put on as it is taken, the journal and the marker written with the items, the holder one of the
 *     party.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultRulesetSheetBuild,
  parseRulesetDefinition,
  resolveRulesetStartingGear,
  rulesetItemBook,
  rulesetStartingGearFits,
  type GameInventoryStack,
  type RulesetCatalogEntry,
  type RulesetDefinition,
  type RulesetItemBook,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-ruleset-starting-gear-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createGameStateStorage } = await import("../../packages/server/src/services/storage/game-state.storage.js");
const { createGameRulesetsStorage } =
  await import("../../packages/server/src/services/storage/game-rulesets.storage.js");
const { gameInventoryRoutes } = await import("../../packages/server/src/routes/game-inventory.routes.js");
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await app.register(gameInventoryRoutes, { prefix: "/game/inventory" });

try {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const emberText = read("../../docs/examples/rulesets/ember-roads.json");
  /** Ember Roads with a traveller's gear (two choices) and a background's (a plain item and salt). */
  const withGear = (edit: (doc: Record<string, any>) => void = () => {}) => {
    const doc = JSON.parse(emberText) as Record<string, any>;
    doc.items.startingGear = [
      {
        id: "traveller",
        label: "Traveller",
        group: "calling",
        fits: { value: { field: "toughness" }, atLeast: 2 },
        lines: [
          { coins: "mark", count: 5 },
          { item: "outfitter/road-rations", count: 3 },
        ],
        choices: [
          {
            label: "Weapon",
            options: [
              { label: "A hand axe", lines: [{ item: "outfitter/hand-axe" }] },
              {
                label: "A hunting bow",
                lines: [{ item: "outfitter/hunting-bow" }, { item: "outfitter/arrows", count: 20 }],
              },
            ],
          },
          {
            label: "Protection",
            options: [
              { label: "A leather coat", lines: [{ item: "outfitter/leather-coat", equip: true }] },
              { label: "A second weapon", lines: [{ oneOf: ["outfitter/hand-axe", "outfitter/boar-spear"] }] },
            ],
          },
        ],
      },
      {
        id: "pilgrim",
        label: "Pilgrim",
        group: "background",
        lines: [
          { name: "Lucky charm", count: 1 },
          { coins: "pinch", count: 10 },
        ],
      },
      { id: "hoarder", label: "Hoarder", group: "calling", lines: [{ item: "outfitter/road-rations", count: 13 }] },
      { id: "drifter", label: "Drifter", group: "calling", lines: [{ coins: "bit", count: 3 }] },
    ];
    edit(doc);
    return doc;
  };
  const parsedOrThrow = (document: unknown): RulesetDefinition => {
    const parsed = parseRulesetDefinition(document);
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.issues.join("; "));
    return parsed.definition;
  };
  const refusal = (document: unknown) => {
    const parsed = parseRulesetDefinition(document);
    assert.ok(!parsed.ok, "this document was supposed to be refused");
    return parsed.issues.join("; ");
  };
  const entriesOf = (definition: RulesetDefinition): Record<string, RulesetCatalogEntry[]> =>
    Object.fromEntries(
      (definition.catalogs ?? []).flatMap((catalog) =>
        catalog.entries && catalog.holds === "items" ? [[catalog.id, catalog.entries]] : [],
      ),
    );
  const ember = parsedOrThrow(withGear());
  const book = rulesetItemBook(ember, entriesOf(ember));

  // ── The schema ──
  {
    const gear = (doc: Record<string, any>) => doc.items.startingGear[0];
    for (const [edit, message] of [
      [(doc: Record<string, any>) => (gear(doc).lines[1].item = "outfitter/spade"), /No item "spade" in catalog/],
      [(doc: Record<string, any>) => (gear(doc).lines[1].item = "packs/spade"), /No item catalog "packs"/],
      [(doc: Record<string, any>) => (gear(doc).lines[0].coins = "crown"), /Unknown currency unit "crown"/],
      [
        (doc: Record<string, any>) => (gear(doc).choices[1].options[1].lines[0].oneOf = ["outfitter/hand-axe"]),
        /at least 2/,
      ],
      [(doc: Record<string, any>) => gear(doc).choices[0].options.pop(), /at least 2/],
      [(doc: Record<string, any>) => (doc.items.startingGear[1].lines = []), /Starting gear gives something/],
      [(doc: Record<string, any>) => (doc.items.freeform = "refuse"), /refuses plain items/],
      [(doc: Record<string, any>) => (gear(doc).lines[0].equip = true), /Only one of the ruleset's items is put on/],
      [(doc: Record<string, any>) => (gear(doc).fits.value = { field: "toughnes" }), /toughnes/],
      [
        (doc: Record<string, any>) => (gear(doc).lines[1] = { item: "outfitter/road-rations", count: 999 }),
        /more stacks than one bag/,
      ],
      [(doc: Record<string, any>) => (doc.items.startingGear[2].id = "traveller"), /Duplicate starting gear/],
    ] as const) {
      assert.match(refusal(withGear(edit)), message);
    }
    // The gate: starting gear is 1.73's.
    const manifest = (minor: number) => ({
      schemaVersion: 2,
      capabilityApi: { major: 1, minor },
      id: "ember",
      name: "Ember",
      version: "1.0.0",
      kind: ["ruleset"],
      entrypoints: {},
      contributions: { assets: { paths: ["ruleset.json"] } },
      files: [{ path: "ruleset.json", sha256: "0".repeat(64), bytes: 10 }],
      permissions: [],
      restartRequired: false,
    });
    const issue = (minor: number) => getCapabilityPackageInstallIssue(manifest(minor) as never, withGear());
    assert.match(issue(72) ?? "", /starting gear requires .*capabilityApi 1\.73/);
    assert.ok(!/starting gear/.test(issue(73) ?? ""));
  }

  // ── Fits ──
  {
    const traveller = ember.items!.startingGear![0]!;
    const sheet = defaultRulesetSheetBuild(ember);
    assert.equal(
      rulesetStartingGearFits(ember, traveller, { ...sheet, fields: { ...sheet.fields, toughness: 2 } }),
      true,
    );
    assert.equal(
      rulesetStartingGearFits(ember, traveller, { ...sheet, fields: { ...sheet.fields, toughness: 1 } }),
      false,
    );
    assert.equal(rulesetStartingGearFits(ember, ember.items!.startingGear![1]!, sheet), false, "names nobody");
  }

  // ── The resolver ──
  {
    const resolve = (choices: number[], picks: Record<string, string> = {}, over: RulesetItemBook = book) =>
      resolveRulesetStartingGear(ember, over, { gear: "traveller", choices, picks });
    const axeAndCoat = resolve([0, 0]);
    assert.ok(axeAndCoat.ok);
    assert.deepEqual(
      axeAndCoat.adds.map((add) => [add.item ?? add.name, add.count, add.equip ?? false]),
      [
        ["coin:mark", 5, false],
        ["outfitter/road-rations", 3, false],
        ["outfitter/hand-axe", 1, false],
        ["outfitter/leather-coat", 1, true],
      ],
    );
    // Two picks of the same weapon are one add of two.
    const twoAxes = resolve([0, 1], { "1.0": "outfitter/hand-axe" });
    assert.ok(twoAxes.ok);
    assert.equal(twoAxes.adds.find((add) => add.item === "outfitter/hand-axe")?.count, 2);
    // Refused: a choice without an option, a pick missing or not in its list, an unknown gear.
    assert.deepEqual(resolve([0]).ok, false);
    assert.equal((resolve([0, 2]) as { reason: string }).reason, "choice");
    assert.equal((resolve([0, 1]) as { reason: string }).reason, "pick");
    assert.equal((resolve([0, 1], { "1.0": "outfitter/hunting-bow" }) as { reason: string }).reason, "pick");
    assert.equal((resolve([0, 1], { "1.0": "coin:mark" }) as { reason: string }).reason, "pick");
    assert.equal(
      (resolveRulesetStartingGear(ember, book, { gear: "nomad", choices: [], picks: {} }) as { reason: string }).reason,
      "unknown-gear",
    );
    // What a layer took out of the game is left out and named; a pick of it is refused.
    const hidden: RulesetItemBook = {
      ...book,
      entries: book.entries.filter((entry) => entry.item !== "outfitter/leather-coat"),
    };
    const withoutCoat = resolve([0, 0], {}, hidden);
    assert.ok(withoutCoat.ok);
    assert.deepEqual(withoutCoat.dropped, ["Leather coat"]);
    assert.ok(!withoutCoat.adds.some((add) => add.item === "outfitter/leather-coat"));
  }

  // ── The route ──
  const RULESET_ID = "local/ember-gear";
  await createGameRulesetsStorage(db).put({
    rulesetId: RULESET_ID,
    version: 1,
    sourceKind: "local",
    definition: JSON.stringify({ ...withGear(), id: "ember-gear" }),
  });
  const chats = createChatsStorage(db);
  const states = createGameStateStorage(db);
  const newGame = async (inventory: GameInventoryStack[] = []) => {
    const chat = await chats.create({ name: "Gear", mode: "game", characterIds: [] });
    const anchor = await chats.createMessage({ chatId: chat.id, role: "assistant", content: "The road." });
    await chats.patchMetadata(chat.id, {
      gameRuleset: { id: RULESET_ID, version: 1, packageId: null, options: {} },
      gameCharacterCards: [{ name: "Ada" }, { name: "Juno" }],
      gameInventory: inventory,
    });
    await states.create({
      chatId: chat.id,
      messageId: anchor.id,
      swipeIndex: 0,
      date: "",
      time: "",
      location: "road",
      weather: "",
      temperature: "",
      worldCustomFields: [],
      presentCharacters: [],
      recentEvents: [],
      playerStats: null,
      personaStats: null,
      fieldLocks: {},
      hiddenTrackerFields: [],
      committed: true,
    });
    return chat.id;
  };
  const take = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/game/inventory/starting-gear", payload });
  const metadataOf = async (chatId: string) => {
    const raw = (await chats.getById(chatId))!.metadata;
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, any>;
  };
  {
    const chatId = await newGame();
    const first = await take({ chatId, selection: { gear: "traveller", choices: [0, 0], picks: {} } });
    assert.equal(first.statusCode, 200, first.body);
    const answer = first.json();
    const bag = (answer.inventory as GameInventoryStack[]).filter((stack) => !stack.holder);
    assert.deepEqual(
      bag.map((stack) => [stack.item, stack.quantity, stack.equipped ?? false]).sort(),
      [
        ["coin:mark", 5, false],
        ["outfitter/hand-axe", 1, false],
        ["outfitter/leather-coat", 1, true],
        ["outfitter/road-rations", 3, false],
      ].sort(),
      "the gear in the player's bag, the coat worn",
    );
    assert.deepEqual(answer.taken, { "": ["traveller"] });
    const metadata = await metadataOf(chatId);
    assert.deepEqual(metadata.gameStartingGearTaken, { "": ["traveller"] });
    assert.ok(
      metadata.gameJournal.entries.some((entry: { title: string }) => entry.title === "Starting gear: Traveller"),
    );
    assert.ok(metadata.gameJournal.inventoryLog.some((entry: { item: string }) => entry.item === "Hand axe"));
    // Once for each group: the calling's gear again is refused, the background's is not.
    const again = await take({ chatId, selection: { gear: "hoarder", choices: [], picks: {} } });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().reason, "taken");
    const background = await take({ chatId, selection: { gear: "pilgrim", choices: [], picks: {} } });
    assert.equal(background.statusCode, 200, background.body);
    assert.ok(
      (background.json().inventory as GameInventoryStack[]).some((stack) => stack.name === "Lucky charm"),
      "a plain item",
    );
    assert.deepEqual(background.json().taken, { "": ["traveller", "pilgrim"] });
    // All of it or none of it: too heavy, and nothing is stored, the marker included.
    const heavy = await take({ chatId, selection: { gear: "hoarder", choices: [], picks: {} }, again: true });
    assert.equal(heavy.statusCode, 409);
    assert.equal(heavy.json().reason, "too-heavy");
    assert.deepEqual((await metadataOf(chatId)).gameStartingGearTaken, { "": ["traveller", "pilgrim"] });
    // Asked again, the calling's gear may be taken a second time, and replaces the first in the marker.
    const twice = await take({ chatId, selection: { gear: "drifter", choices: [], picks: {} }, again: true });
    assert.equal(twice.statusCode, 200, twice.body);
    assert.deepEqual(twice.json().taken, { "": ["pilgrim", "drifter"] });
    // A party member's own bag, by their card's name; nobody else's.
    const juno = await take({ chatId, holder: "juno", selection: { gear: "pilgrim", choices: [], picks: {} } });
    assert.equal(juno.statusCode, 200, juno.body);
    assert.ok((juno.json().inventory as GameInventoryStack[]).some((stack) => stack.holder === "Juno"));
    assert.deepEqual(juno.json().taken.juno, ["pilgrim"]);
    const stranger = await take({ chatId, holder: "Mallory", selection: { gear: "pilgrim", choices: [], picks: {} } });
    assert.equal(stranger.json().reason, "unknown-holder");
    // Never trusted: a pick that is not one of its list.
    const forged = await take({
      chatId,
      holder: "Juno",
      selection: { gear: "traveller", choices: [0, 1], picks: { "1.0": "outfitter/hunting-bow" } },
    });
    assert.equal(forged.json().reason, "pick");
  }

  console.log("Ruleset starting gear: schema and gate, fits, the resolver, and the route into one bag, once a group.");
} finally {
  await app.close();
  closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
