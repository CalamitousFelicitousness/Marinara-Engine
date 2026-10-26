/**
 * A command to the whole party passes by the dead and those taken out of the party (laptop pass 6,
 * 2026-10-26: a party long rest put two fallen companions back on their feet, death saves cleared,
 * after they had died and left the party).
 *
 *   - `who="party"` skips a card dead by the ruleset's dying saves, and any card the sheet context
 *     counts away; the living members still rest.
 *   - Named, the away are still found; the dead are refused a heal, a rest or temporary health,
 *     which only a use of what raises the dead gives back.
 *   - A fight leaves the dead out, and refuses a party of none but the dead.
 *   - The sheet context counts away a card whose member left the stored party list, and nobody when
 *     a member of that list cannot be named.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-party-rest-dead-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");

const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { createGameRulesetsStorage } =
  await import("../../packages/server/src/services/storage/game-rulesets.storage.js");
const { applyGameRulesetSheetTurn, loadGameRulesetSheetContext } =
  await import("../../packages/server/src/services/game/ruleset-sheet-turn.service.js");
const { createRulesetFight } =
  await import("../../packages/server/src/services/game/ruleset-combat-director.service.js");
const { characterDataSchema } = await import("../../packages/shared/src/index.js");

const db = await getDB();
try {
  const doc = JSON.parse(
    readFileSync(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  await createGameRulesetsStorage(db).put({
    rulesetId: "local/party-rest-dead",
    version: 1,
    sourceKind: "local",
    definition: JSON.stringify({ ...doc, id: "party-rest-dead" }),
  });
  const characters = createCharactersStorage(db);
  const aldric = (await characters.create(characterDataSchema.parse({ name: "Aldric", description: "A" })))!;
  const kesh = (await characters.create(characterDataSchema.parse({ name: "Kesh", description: "K" })))!;
  const mara = (await characters.create(characterDataSchema.parse({ name: "Mara", description: "M" })))!;
  const chats = createChatsStorage(db);
  const chat = await chats.create({ name: "Pass 6", mode: "game", characterIds: [aldric.id, kesh.id, mara.id] });
  await chats.patchMetadata(chat.id, {
    gameRuleset: { id: "local/party-rest-dead", version: 1, packageId: null, options: {} },
    gameCharacterCards: [{ name: "Aldric" }, { name: "Kesh" }, { name: "Mara" }],
    // Kesh was taken out of the party; his card stays.
    gamePartyCharacterIds: [aldric.id, mara.id],
  });

  const context = (await loadGameRulesetSheetContext(db, chat.id))!;
  assert.deepEqual(context.away, ["Kesh"], "a member taken out of the party is away");
  const hurt = { pools: { hp: { value: 3 } } };
  const live = {
    aldric: { pools: { hp: { value: 0 } }, tracks: { death_save_failures: 3 } },
    kesh: hurt,
    mara: hurt,
  };
  const rest = applyGameRulesetSheetTurn(context, `[sheet: who="party" op="rest" rest="Long rest"]`, live);
  assert.deepEqual(rest.live.aldric, live.aldric, "the dead do not rest");
  assert.deepEqual(rest.live.kesh, hurt, "one who left the party does not rest");
  assert.notDeepEqual(rest.live.mara, hurt, "the living member rests");
  assert.deepEqual(
    rest.rests.map((one) => one.who),
    ["Mara"],
  );

  // Named, one away is still found; the dead are not healed or rested back to life (laptop pass 6
  // 2026-10-26: a restore of 1 hit point stood a dead hero up).
  const named = applyGameRulesetSheetTurn(
    context,
    `[sheet: who="Kesh" op="rest" rest="Long rest"] [sheet: who="Aldric" op="heal" pool="hp" amount="1"] [sheet: who="Aldric" op="rest" rest="Long rest"]`,
    live,
  );
  assert.notDeepEqual(named.live.kesh, hurt);
  assert.deepEqual(named.live.aldric, live.aldric);
  assert.deepEqual(
    named.outcomes.filter((one) => one.who === "Aldric").map((one) => [one.ok, one.reason]),
    [
      [false, "dead"],
      [false, "dead"],
    ],
  );
  // A damage or a note still reaches them.
  assert.equal(
    applyGameRulesetSheetTurn(context, `[sheet: who="Aldric" op="damage" pool="hp" amount="1"]`, live).outcomes[0]?.ok,
    true,
  );

  // Nor does a fight take the dead: not on the board, not in the budget (laptop pass 6 2026-10-26: a
  // dead hero placed down, every blow on him a critical); a party of none but the dead is refused.
  const fight = (party: string[]) =>
    createRulesetFight({
      definition: context.definition,
      seed: 3,
      party: party.map((name) => ({ id: name.toLowerCase(), name })),
      enemies: [{ id: "bandit", name: "Bandit", tier: "cr_1_4" }],
      cards: ["Aldric", "Mara"].map((name) => ({ name, rulesetSheet: { v: 1, build: context.cards[0]!.build } })),
      playerName: "Aldric",
      live,
      partyCatalogs: {},
      bestiary: {},
    });
  const both = fight(["Aldric", "Mara"]);
  assert.ok(both.ok, both.ok ? "" : both.error);
  assert.deepEqual(
    both.fight.encounter.combatants.filter((one) => one.side === "party").map((one) => one.name),
    ["Mara"],
  );
  assert.ok(both.fight.adjustments.includes("Aldric is dead and stays out of the fight."));
  const alone = fight(["Aldric"]);
  assert.equal(alone.ok, false);
  if (!alone.ok) assert.match(alone.error, /is dead, so there is nobody to fight it/);

  // A party list member the Engine cannot name drops nobody.
  await chats.patchMetadata(chat.id, { gamePartyCharacterIds: [aldric.id, mara.id, "missing-id"] });
  assert.equal((await loadGameRulesetSheetContext(db, chat.id))!.away, undefined);
  // And a game with no stored party list counts nobody away.
  await chats.patchMetadata(chat.id, { gamePartyCharacterIds: null });
  assert.equal((await loadGameRulesetSheetContext(db, chat.id))!.away, undefined);

  console.log("A party command passes by the dead and those taken out of the party.");
} finally {
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
