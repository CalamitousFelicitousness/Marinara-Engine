/**
 * A command to the whole party passes by the dead and those taken out of the party (laptop pass 6,
 * 2026-10-26: a party long rest put two fallen companions back on their feet, death saves cleared,
 * after they had died and left the party).
 *
 *   - `who="party"` skips a card dead by the ruleset's dying saves, and any card the sheet context
 *     counts away; the living members still rest.
 *   - Named, the dead and the away are still found: a raising spell or a rest written for them.
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

  // Named, they are still found.
  const named = applyGameRulesetSheetTurn(
    context,
    `[sheet: who="Kesh" op="rest" rest="Long rest"] [sheet: who="Aldric" op="heal" pool="hp" amount="1"]`,
    live,
  );
  assert.notDeepEqual(named.live.kesh, hurt);
  assert.equal(named.live.aldric?.pools?.hp?.value, 1);

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
