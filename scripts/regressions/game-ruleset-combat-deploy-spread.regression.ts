/**
 * Deploying spread against a blast (combat AI S1a).
 *
 *   - A party facing an opponent that holds an area that harms starts spread by its size, not in a
 *     block its opening blast catches whole.
 *   - Against opponents with none it still starts together.
 *   - The same for the other side: `placeSpawns` spreads whichever side it is asked to, never nearer
 *     the other.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultRulesetSheetBuild,
  parseRulesetDefinition,
  rulesetPositionOf,
  type RulesetDefinition,
} from "../../packages/shared/src/index.js";
import { placeSpawns } from "../../packages/shared/src/features/tactical-combat/grid-gen.js";
import type { TacticalGrid } from "../../packages/shared/src/features/tactical-combat/types.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-deploy-spread-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { createRulesetFight } =
  await import("../../packages/server/src/services/game/ruleset-combat-director.service.js");

try {
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const slam = { id: "slam", name: "Slam", budget: "action", toHit: 5, reach: 5, damage: { dice: "1d6" } };
  const blast = {
    id: "blast",
    name: "Fire Blast",
    budget: "action",
    range: { normal: 150 },
    autoHit: true,
    damage: { dice: "8d6", type: "fire" },
    area: { shape: "burst", size: 10 },
  };
  const withMage = (actions: Record<string, unknown>[]): RulesetDefinition => {
    const doc = JSON.parse(fiveEText) as Record<string, any>;
    const creatures = doc.catalogs.find((one: { holds?: string }) => one.holds === "creatures");
    const mage = structuredClone(creatures.entries.find((one: { id: string }) => one.id === "thorn-lurker"));
    mage.id = "mage";
    mage.label = "Mage";
    mage.creature.actions = actions;
    creatures.entries.push(mage);
    const result = parseRulesetDefinition(doc);
    assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
    return result.definition;
  };
  const names = ["Ada", "Bram", "Cora", "Dain"];
  const deploy = (definition: RulesetDefinition) => {
    const bestiary = Object.fromEntries(
      (definition.catalogs ?? []).flatMap((catalog) =>
        catalog.holds === "creatures" && catalog.entries ? [[catalog.id, catalog.entries]] : [],
      ),
    );
    const creaturesId = (definition.catalogs ?? []).find((catalog) => catalog.holds === "creatures")!.id;
    const built = createRulesetFight({
      definition,
      seed: 5,
      positioned: true,
      party: names.map((name) => ({ id: name.toLowerCase(), name })),
      enemies: [{ id: "mage", name: "Mage", creature: `${creaturesId}/mage` }],
      cards: names.map((name) => ({ name, rulesetSheet: { v: 1, build: defaultRulesetSheetBuild(definition) } })),
      playerName: null,
      live: {},
      items: () => [],
      partyCatalogs: {},
      bestiary,
    } as never);
    assert.ok(built.ok, built.ok ? "" : (built as { error: string }).error);
    const encounter = (built as { fight: { encounter: { combatants: never[] } } }).fight.encounter;
    return names.map((name) =>
      rulesetPositionOf(encounter.combatants.find((one: { id: string }) => one.id === name.toLowerCase()))!,
    );
  };
  const gap = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const closest = (cells: { x: number; y: number }[]) =>
    Math.min(...cells.flatMap((a, i) => cells.slice(i + 1).map((b) => gap(a, b))));
  /** The most of them one blast of this many cells across its centre catches. */
  const mostCaught = (cells: { x: number; y: number }[], radius: number) =>
    Math.max(...cells.map((centre) => cells.filter((one) => gap(one, centre) <= radius).length));

  {
    const together = deploy(withMage([slam]));
    assert.equal(closest(together), 1, `against a slam the party starts together: ${JSON.stringify(together)}`);
    const spread = deploy(withMage([slam, blast]));
    assert.ok(closest(spread) >= 2, `against a blast it starts spread: ${JSON.stringify(spread)}`);
    assert.ok(
      mostCaught(spread, 2) < mostCaught(together, 2),
      `a 10-foot blast catches fewer of them: ${JSON.stringify(spread)} against ${JSON.stringify(together)}`,
    );
    assert.ok(
      spread.every((cell) => cell.x <= Math.max(...together.map((one) => one.x)) + 2),
      `and none of them steps far out toward the mage: ${JSON.stringify(spread)}`,
    );
  }

  {
    // The other side, straight off placement: enemies asked to spread do, never nearer the party.
    const open = (): TacticalGrid => ({
      width: 16,
      height: 12,
      tiles: Array.from({ length: 12 }, () => Array.from({ length: 16 }, () => "plains" as const)),
    });
    const units = () => [
      ...[0, 1].map((i) => ({ id: `p${i}`, side: "party" as const, x: 0, y: 0 })),
      ...[0, 1, 2, 3].map((i) => ({ id: `e${i}`, side: "enemy" as const, x: 0, y: 0 })),
    ];
    const plain = units();
    assert.ok(placeSpawns(open(), plain, "skirmish", () => 0.5, new Set(), true));
    const spaced = units();
    assert.ok(placeSpawns(open(), spaced, "skirmish", () => 0.5, new Set(), true, { enemy: 3 }));
    const enemies = (list: typeof plain) => list.filter((one) => one.side === "enemy");
    assert.ok(closest(enemies(plain)) < 3, `a skirmish bunches them: ${JSON.stringify(enemies(plain))}`);
    assert.ok(closest(enemies(spaced)) >= 3, `spread three apart: ${JSON.stringify(enemies(spaced))}`);
    const party = spaced.filter((one) => one.side === "party");
    const nearest = (list: typeof plain) =>
      Math.min(
        ...enemies(list).flatMap((foe) => list.filter((one) => one.side === "party").map((one) => gap(one, foe))),
      );
    assert.ok(nearest(spaced) >= nearest(plain) - 1, `none of them nearer the party: ${JSON.stringify(party)}`);
  }

  console.log(
    "Deploying spread: a party facing a blast starts spread by its size, one facing none starts together, and either side spreads without stepping toward the other.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
