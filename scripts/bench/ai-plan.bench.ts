// Times one Engine-planned turn of a caster with area spells on a 14x10 board (not a regression).
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRulesetEncounter,
  parseRulesetDefinition,
  rowsFromCatalogEntry,
  rulesetSheetBuildSchema,
  type RulesetCatalogEntry,
  type RulesetStatBlock,
} from "../../packages/shared/src/index.js";
const dataDir = mkdtempSync(join(tmpdir(), "marinara-bench-"));
process.env.DATA_DIR = dataDir;
const { createCombatDirector } = await import("../../packages/server/src/services/game/combat-director.service.js");
const { pickRulesetChoice } = await import("../../packages/server/src/services/game/ruleset-combat-director.service.js");
const doc = JSON.parse(readFileSync("docs/development/ruleset-5e-2014.example.json", "utf8"));
const spell = (id: string, label: string, mechanics: Record<string, unknown>, level = 1) => ({
  id,
  label,
  rows: [{ list: "spells", values: { name: label, level, prepared: true } }],
  mechanics,
});
doc.catalogs.push({
  id: "spells",
  label: "Spells",
  feeds: ["spells"],
  entries: [
    spell("fireball", "Fireball", { kind: "attack", budget: "action", area: { shape: "burst", size: 20 }, range: 150, amount: { dice: "8d6" }, damageType: "fire" }, 3),
    spell("burst", "Burst", { kind: "attack", budget: "action", area: { shape: "cone", size: 15 }, range: 0, amount: { dice: "3d6" }, damageType: "cold" }),
    spell("bolt", "Bolt", { kind: "attack", budget: "action", range: 120, targets: "enemy", attackRoll: true, amount: { dice: "1d10" }, damageType: "fire" }),
  ],
});
const parsed = parseRulesetDefinition(doc);
if (!parsed.ok) throw new Error(parsed.issues.join("; "));
const definition = parsed.definition;
const spells = definition.catalogs!.find((c) => c.id === "spells")!.entries! as RulesetCatalogEntry[];
const build = (caster: boolean) =>
  rulesetSheetBuildSchema.parse({
    abilities: { str: 10, dex: 12, con: 14, int: 18, wis: 12, cha: 10 },
    fields: { level: 7, ac: 13, speed: 30, hp_max: 50, spellcasting_ability: "int", slots_max_1: 4, slots_max_3: 3 },
    ...(caster ? { lists: { spells: spells.flatMap((e) => rowsFromCatalogEntry("spells", e).map((r) => r.row)) } } : {}),
  });
const block = (): RulesetStatBlock =>
  ({ health: 30, defense: 13, initiativeModifier: 0, speed: 30, actions: [{ id: "claw", name: "Claw", budget: "action", toHit: 4, damage: { count: 1, sides: 8, flat: 2 }, reach: 1 }] }) as unknown as RulesetStatBlock;
const party = ["mage", "a", "b", "c"];
const enemies = ["e1", "e2", "e3", "e4", "e5"];
const encounter = createRulesetEncounter({
  definition,
  seed: 1,
  roller: () => 10,
  combatants: [
    ...party.map((id) => ({ id, name: id, side: "party" as const, build: build(id === "mage"), ...(id === "mage" ? { catalogs: { spells } } : {}) })),
    ...enemies.map((id) => ({ id, name: id, side: "enemy" as const, block: block() })),
  ],
  board: {
    grid: { width: 14, height: 10, tiles: Array.from({ length: 10 }, () => Array(14).fill("plains")) },
    placements: {
      mage: { x: 1, y: 5 }, a: { x: 3, y: 4 }, b: { x: 3, y: 5 }, c: { x: 3, y: 6 },
      e1: { x: 9, y: 4 }, e2: { x: 9, y: 5 }, e3: { x: 10, y: 5 }, e4: { x: 10, y: 6 }, e5: { x: 11, y: 3 },
    },
  } as never,
});
encounter.order = [...party, ...enemies];
encounter.turn = 0;
const unit = (id: string, side: string) => ({ id, name: id, side, hp: 30, maxHp: 30, attack: 8, defense: 6, speed: 6, level: 7, skills: [] });
const state = createCombatDirector({
  id: "f", anchor: "a", style: "ruleset",
  party: party.map((id) => unit(id, "player")), enemies: enemies.map((id) => unit(id, "enemy")),
  gm: false, difficulty: "normal", seed: 3,
} as never);
const runs = Number(process.env.RUNS ?? 1);
for (let i = 0; i < runs; i++) {
  const start = performance.now();
  const picked = pickRulesetChoice(definition, state, encounter, "mage");
  console.log(`plan ${i}: ${(performance.now() - start).toFixed(0)} ms ->`, picked?.option.label, picked?.to, picked?.choice.at);
}
