/**
 * Calls kept on the sheet (Capability API 1.787, Alyssa 2026-10-24: "Keep on sheet").
 *
 *   - Find Familiar used outside a fight names its creature (`as=`), checked against what it calls;
 *     one left unnamed is refused with the names it may call. Paid for once, and kept on the sheet.
 *   - The Game Master reads it on the sheet block, "With them".
 *   - It joins the next fight on its own, not paid for again, even where the Game Master lists it.
 *   - Killed in a fight, or dismissed by its caller there, it is gone from the sheet as the fight
 *     ends; sent away only because its caller went down, it stays.
 *   - The `dismiss` sheet command (and the sheet's button, the same op) sends it away.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyRulesetSheetOp,
  applySheetCommandTags,
  parseRulesetDefinition,
  renderRulesetSheetBlock,
  rowsFromCatalogEntry,
  rulesetKeptCalls,
  rulesetSheetBuildSchema,
  supportedCapabilityApi,
  type RulesetCatalogEntry,
  type RulesetDefinition,
  type RulesetLiveStates,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-kept-calls-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { createRulesetFight, rulesetFightLiveStates } =
  await import("../../packages/server/src/services/game/ruleset-combat-director.service.js");

try {
  assert.ok(supportedCapabilityApi.minor >= 787);
  const doc = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
      "utf8",
    ),
  );
  doc.combat.creatureTypes = {
    types: ["beast", "humanoid", "celestial", "fey", "fiend"].map((id) => ({
      id,
      label: id[0]!.toUpperCase() + id.slice(1),
    })),
    field: "race",
    default: "humanoid",
  };
  doc.sheet.live.conditions.push({ id: "bonded", label: "Familiar bond" });
  doc.combat.conditions.push({ condition: "bonded", effects: [] });
  const beast = (id: string, label: string, familiar: string) => ({
    id,
    label,
    filters: { familiar },
    creature: {
      health: 3,
      defense: 11,
      initiativeModifier: 0,
      speed: 30,
      tier: "cr_0",
      type: "beast",
      actions: [{ id: "talons", name: "Talons", budget: "action", toHit: 3, damage: { flat: 1 }, reach: 5 }],
    },
  });
  const creatures = doc.catalogs.find((catalog: { holds?: string }) => catalog.holds === "creatures");
  creatures.filters.push({ id: "familiar", label: "Familiar", type: "text" });
  creatures.entries.push(beast("owl", "Owl", "yes"), beast("cat", "Cat", "yes"), beast("rat", "Giant Rat", "no"));
  doc.catalogs.push({
    id: "spells",
    label: "Spells",
    feeds: ["spells"],
    entries: [
      {
        id: "find-familiar",
        label: "Find Familiar",
        rows: [{ list: "spells", values: { name: "Find Familiar", level: 1, prepared: true } }],
        mechanics: {
          kind: "utility",
          targets: "self",
          cost: [{ pool: "slots_1", amount: 1 }],
          beforeFight: true,
          calls: {
            from: { catalog: "creatures", filters: { familiar: "yes" } },
            count: { flat: 1 },
            asTypes: ["celestial", "fey", "fiend"],
          },
          appliesSelf: [{ condition: "bonded", duration: { rounds: 14400 } }],
        },
      },
    ],
  });
  const parsed = parseRulesetDefinition(doc);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.issues.join("; "));
  const definition: RulesetDefinition = parsed.definition;
  const spells = definition.catalogs!.find((entry) => entry.id === "spells")!.entries! as RulesetCatalogEntry[];
  const bestiary = { creatures: definition.catalogs!.find((catalog) => catalog.holds === "creatures")!.entries! };
  const build = rulesetSheetBuildSchema.parse({
    abilities: { str: 10, dex: 10, con: 10, int: 16, wis: 10, cha: 10 },
    fields: { level: 3, ac: 12, speed: 30, hp_max: 20, race: "Human", spellcasting_ability: "int", slots_max_1: 4 },
    lists: { spells: spells.flatMap((entry) => rowsFromCatalogEntry("spells", entry).map((row) => row.row)) },
  });
  const cards = [{ name: "Wren", build }];
  const say = (content: string, live: RulesetLiveStates = {}) =>
    applySheetCommandTags(content, {
      definition,
      cards,
      playerName: "Wren",
      live,
      catalogs: { spells, ...bestiary },
    });
  const slots = (live: RulesetLiveStates) => live.wren?.pools?.slots_1?.value;

  // ── Outside a fight: the creature is named, checked, paid for once and kept ──
  const unnamed = say(`[sheet: op="use" name="Find Familiar"]`);
  assert.equal(unnamed.outcomes[0]!.ok, false);
  assert.match(unnamed.outcomes[0]!.reason ?? "", /name the creature Find Familiar calls.*Owl, Cat/);
  assert.equal(unnamed.changed, false, "nothing is paid for a refused call");
  const wrong = say(`[sheet: op="use" name="Find Familiar" as="Giant Rat"]`);
  assert.equal(wrong.outcomes[0]!.ok, false, "a creature it does not call is refused");
  const badType = say(`[sheet: op="use" name="Find Familiar" as="Owl, Dragon"]`);
  assert.equal(badType.outcomes[0]!.ok, false, "a type it does not offer is refused");
  const cast = say(`[sheet: op="use" name="Find Familiar" as="owl, fey"]`);
  assert.equal(cast.outcomes[0]!.ok, true, cast.outcomes[0]!.reason);
  assert.match(cast.outcomes[0]!.now ?? "", /Owl, Fey called, and stays/);
  assert.equal(slots(cast.live), 3, "one slot spent");
  assert.deepEqual(rulesetKeptCalls(cast.live.wren), [{ entry: "Find Familiar", as: "Owl, Fey" }]);
  // Another command after it leaves it be.
  const after = say(`[sheet: op="damage" pool="hp" amount="2"]`, cast.live);
  assert.deepEqual(rulesetKeptCalls(after.live.wren), [{ entry: "Find Familiar", as: "Owl, Fey" }]);
  // Cast again, the new one takes its place.
  const again = say(`[sheet: op="use" name="Find Familiar" as="Cat"]`, cast.live);
  assert.deepEqual(rulesetKeptCalls(again.live.wren), [{ entry: "Find Familiar", as: "Cat" }]);

  // ── The Game Master reads it ──
  assert.match(renderRulesetSheetBlock(definition, cards[0]!, cast.live.wren), /With them: Owl, Fey \(Find Familiar\)/);

  // ── The next fight: it comes along on its own, not paid for again ──
  const fightWith = (live: RulesetLiveStates, standing?: Array<{ casterId: string; entry: string }>) => {
    const built = createRulesetFight({
      definition,
      seed: 3,
      party: [{ id: "wren", name: "Wren" }],
      enemies: [{ id: "rat", name: "Giant Rat", creature: "creatures/rat" }],
      cards: [{ name: "Wren", rulesetSheet: { v: 1, build } }],
      playerName: "Wren",
      live,
      partyCatalogs: { spells },
      bestiary,
      ...(standing ? { standing } : {}),
    });
    assert.ok(built.ok, built.ok ? "" : built.error);
    return built.fight;
  };
  const fight = fightWith(cast.live, [{ casterId: "wren", entry: "Find Familiar" }]);
  const familiars = fight.encounter.combatants.filter((one) => one.calledBy === "wren");
  assert.equal(familiars.length, 1, "one familiar, though the Game Master listed it too");
  assert.equal(familiars[0]!.name, "Owl");
  assert.equal(familiars[0]!.calledKept?.entry, "Find Familiar");
  const wren = fight.encounter.combatants.find((one) => one.id === "wren")!;
  assert.equal(
    (wren.sheet!.live as RulesetLiveStates[string]).pools?.slots_1?.value,
    3,
    "not paid for again as the fight starts",
  );
  // A fight it lives through keeps it.
  assert.deepEqual(rulesetKeptCalls(rulesetFightLiveStates(fight).wren), [{ entry: "Find Familiar", as: "Owl, Fey" }]);

  // ── Killed: gone from the sheet ──
  {
    const lost = fightWith(cast.live);
    const owl = lost.encounter.combatants.find((one) => one.calledBy === "wren")!;
    owl.defeated = true;
    assert.deepEqual(rulesetKeptCalls(rulesetFightLiveStates(lost).wren), []);
  }
  // ── Sent away because its caller went down: it stays ──
  {
    const away = fightWith(cast.live);
    const owl = away.encounter.combatants.find((one) => one.calledBy === "wren")!;
    owl.defeated = true;
    owl.dismissed = true;
    assert.equal(rulesetKeptCalls(rulesetFightLiveStates(away).wren).length, 1);
    // Dismissed by its caller's choice: gone.
    owl.calledKept!.gone = true;
    assert.deepEqual(rulesetKeptCalls(rulesetFightLiveStates(away).wren), []);
  }

  // ── Dismissed outside a fight ──
  const dismissed = say(`[sheet: op="dismiss" name="Owl, Fey"]`, cast.live);
  assert.equal(dismissed.outcomes[0]!.ok, true, dismissed.outcomes[0]!.reason);
  assert.deepEqual(rulesetKeptCalls(dismissed.live.wren), []);
  assert.equal(say(`[sheet: op="dismiss" name="Find Familiar"]`, dismissed.live).outcomes[0]!.ok, false);
  // The sheet's own button is the same op.
  const button = applyRulesetSheetOp(definition, build, cast.live.wren, { op: "dismiss", name: "Find Familiar" });
  assert.ok(button.ok);
  assert.deepEqual(rulesetKeptCalls(button.live), []);
  // With no familiar the next fight calls nobody.
  assert.equal(
    fightWith(dismissed.live).encounter.combatants.filter((one) => one.calledBy === "wren").length,
    0,
  );

  console.log("game-ruleset-kept-calls: ok");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
