/**
 * A call that sets down what it calls within some distance of its caller, on cells it sees
 * (Capability API 1.605): 5e's treant's Animate Trees, "one or two trees it can see within 60 feet
 * of it".
 *
 *   - The trees wake within 60 feet of the treant, the cells nearest its foe first.
 *   - Without `within`, beside the treant as ever.
 *   - `seen`: only cells the treant sees; without it, past a wall too.
 *   - The install gate.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyRulesetCombatChoice,
  createRulesetEncounter,
  parseRulesetDefinition,
  rulesetCombatant,
  rulesetDistanceTo,
  rulesetPositionOf,
  rulesetSheetBuildSchema,
  supportedCapabilityApi,
  type RulesetCatalogEntriesById,
  type RulesetDefinition,
  type RulesetEncounterState,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-call-within-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");

try {
  assert.ok(supportedCapabilityApi.minor >= 605);
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const animate: Record<string, unknown> = {
    creature: "creatures/tree",
    count: { flat: 2 },
    endsWithCaller: true,
    dismissible: { budget: "bonus" },
    leash: 120,
    within: { distance: 60, seen: true },
  };
  const slam = { id: "slam", name: "Slam", budget: "action", toHit: 10, reach: 5, damage: { flat: 3 } };
  const creature = (actions: unknown[]) => ({
    health: 100,
    defense: 16,
    initiativeModifier: 0,
    speed: 30,
    tier: "cr_5",
    actions,
  });
  const fiveE = (calls: Record<string, unknown> = animate): Record<string, any> => {
    const doc = JSON.parse(fiveEText) as Record<string, any>;
    doc.catalogs
      .find((catalog: { holds?: string }) => catalog.holds === "creatures")
      .entries.push(
        {
          id: "treant",
          label: "Treant",
          creature: creature([
            slam,
            { id: "animate", name: "Animate Trees", budget: "action", uses: { per: "day", count: 1 }, calls },
          ]),
        },
        { id: "tree", label: "Tree", creature: creature([slam]) },
      );
    return doc;
  };
  const parsed = (document: unknown): RulesetDefinition => {
    const result = parseRulesetDefinition(document);
    assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
    return result.definition;
  };
  const roll = (sides: number) => Math.min(sides, 10);
  let definition = parsed(fiveE());
  let bestiary: RulesetCatalogEntriesById = {
    creatures: definition.catalogs!.find((catalog) => catalog.holds === "creatures")!.entries!,
  };
  const fight = (wall = false): RulesetEncounterState => {
    const state = createRulesetEncounter({
      definition,
      seed: 1,
      roller: roll,
      bestiary,
      combatants: [
        {
          id: "ada",
          name: "Ada",
          side: "party",
          build: rulesetSheetBuildSchema.parse({
            abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
            fields: { level: 5, ac: 12, speed: 30, hp_max: 50 },
          }),
          live: {},
        },
        { id: "treant", name: "Treant", side: "enemy", creature: { catalogId: "creatures", entryId: "treant" } },
      ],
      board: {
        grid: {
          width: 30,
          height: 10,
          tiles: Array.from({ length: 10 }, () =>
            Array.from({ length: 30 }, (_, x) => (wall && x === 15 ? "wall" : "plains")),
          ),
        },
        placements: { ada: { x: 2, y: 2 }, treant: { x: 20, y: 4 } },
      },
    });
    for (const one of state.combatants) one.initiative = { ada: 5, treant: 20 }[one.id]!;
    state.order = ["treant", "ada"];
    state.turn = 0;
    return state;
  };
  const called = (state: RulesetEncounterState) =>
    state.combatants.filter((one) => one.calledBy === "treant" && !one.dismissed).map((one) => one.id);
  const animated = (state = fight(), count = 2) => {
    const taken = applyRulesetCombatChoice(
      definition,
      state,
      { actorId: "treant", optionId: "animate", targetIds: [] },
      roll,
    );
    assert.equal(called(taken.state).length, count, JSON.stringify(taken.events));
    return taken.state;
  };

  const gap = (state: RulesetEncounterState, id: string, to: string) =>
    rulesetDistanceTo(rulesetPositionOf(rulesetCombatant(state, id))!, rulesetCombatant(state, to));

  // ── Within 60 feet of the treant, nearest its foe first ──
  {
    const state = animated();
    for (const id of called(state)) {
      assert.ok(gap(state, id, "treant") <= 12, `${id} within 60 feet`);
      assert.ok(gap(state, id, "ada") <= 7, `${id} as near Ada as it may be: ${gap(state, id, "ada")}`);
    }
  }
  // ── Without within: beside the treant ──
  {
    const plain = { ...animate };
    delete plain.within;
    definition = parsed(fiveE(plain));
    bestiary = { creatures: definition.catalogs!.find((catalog) => catalog.holds === "creatures")!.entries! };
    const state = animated();
    for (const id of called(state)) assert.ok(gap(state, id, "treant") <= 2, `${id} beside the treant`);
    definition = parsed(fiveE());
    bestiary = { creatures: definition.catalogs!.find((catalog) => catalog.holds === "creatures")!.entries! };
  }
  // ── Seen: behind a wall, only on the treant's own side; unseen, through it ──
  {
    const seen = animated(fight(true));
    for (const id of called(seen)) assert.ok(rulesetPositionOf(rulesetCombatant(seen, id))!.x > 15, `${id} seen`);
    definition = parsed(fiveE({ ...animate, within: { distance: 60 } }));
    bestiary = { creatures: definition.catalogs!.find((catalog) => catalog.holds === "creatures")!.entries! };
    const unseen = animated(fight(true));
    for (const id of called(unseen))
      assert.ok(rulesetPositionOf(rulesetCombatant(unseen, id))!.x < 15, `${id} past it`);
    definition = parsed(fiveE());
    bestiary = { creatures: definition.catalogs!.find((catalog) => catalog.holds === "creatures")!.entries! };
  }
  // ── Refused: nothing within ──
  {
    const bad = parseRulesetDefinition(fiveE({ ...animate, within: { seen: true } }));
    assert.equal(bad.ok, false);
  }

  // ── The install gate ──
  {
    const gate =
      "A ruleset with a call that sets down what it calls within some distance of its caller (calls.within) requires schemaVersion 2 and capabilityApi 1.605 or newer";
    const manifest = (minor: number) => ({
      schemaVersion: 2,
      capabilityApi: { major: 1, minor },
      id: "fivee",
      name: "5e",
      version: "1.0.0",
      kind: ["ruleset"],
      entrypoints: {},
      contributions: { assets: { paths: ["ruleset.json"] } },
      files: [{ path: "ruleset.json", sha256: "0".repeat(64), bytes: 10 }],
      permissions: [],
      restartRequired: false,
    });
    assert.equal(getCapabilityPackageInstallIssue(manifest(604) as never, fiveE()), gate);
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(605) as never, fiveE()), gate);
  }

  console.log(
    "calls.within: Animate Trees wakes its trees within 60 feet, nearest its foe; beside it without; only where it sees; gated at 1.605.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
