/**
 * Where each side begins (2026-10-24, Alyssa).
 *
 *   - The Game Master places every opponent: one started "behind" the party stands past it, one
 *     "among" it in its middle.
 *   - A party member the story put somewhere ("front": the wizard who walked in first) stands there,
 *     and the player does not move them.
 *   - Everyone else of the party the player sets down before the first turn: on a lit square near
 *     their side, never beside an opponent, never onto somebody else. Nobody acts until they begin.
 *   - A party the Engine plays all of has nobody to set down, and a fight built without asking for
 *     it (a test, a preview) starts at once.
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
  rulesetStartPlacements,
  type RulesetDefinition,
} from "../../packages/shared/src/index.js";
import type { TacticalGrid } from "../../packages/shared/src/features/tactical-combat/types.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-deploy-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { commandRulesetCombatDirector, createRulesetFight, directedRulesetView, rulesetDirectorStage } =
  await import("../../packages/server/src/services/game/ruleset-combat-director.service.js");
const { createCombatDirector } = await import("../../packages/server/src/services/game/combat-director.service.js");

try {
  const doc = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
      "utf8",
    ),
  );
  const parsed = parseRulesetDefinition(doc);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.issues.join("; "));
  const definition: RulesetDefinition = parsed.definition;
  const creatures = (definition.catalogs ?? []).find((catalog) => catalog.holds === "creatures")!;
  const bestiary = { [creatures.id]: creatures.entries ?? [] };
  const lurker = `${creatures.id}/thorn-lurker`;
  const names = ["Ada", "Bram", "Cora"];
  const gap = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

  const begin = (opts: {
    deploy?: boolean;
    ai?: boolean;
    adaStart?: "front";
    allStart?: boolean;
    foeStarts?: Array<"behind" | "among">;
  }) => {
    const foes = opts.foeStarts ?? [undefined, undefined];
    const built = createRulesetFight({
      definition,
      seed: 9,
      positioned: true,
      ...(opts.deploy ? { deploy: true } : {}),
      party: names.map((name) => ({
        id: name.toLowerCase(),
        name,
        ...(name === "Ada" && opts.adaStart ? { start: opts.adaStart } : {}),
        ...(opts.allStart ? { start: "front" as const } : {}),
      })),
      enemies: foes.map((start, i) => ({
        id: `foe${i}`,
        name: `Foe ${i}`,
        creature: lurker,
        ...(start ? { start } : {}),
      })),
      cards: names.map((name) => ({ name, rulesetSheet: { v: 1, build: defaultRulesetSheetBuild(definition) } })),
      playerName: null,
      live: {},
      items: () => [],
      partyCatalogs: {},
      bestiary,
    } as never);
    assert.ok(built.ok, built.ok ? "" : (built as { error: string }).error);
    const unit = (id: string, side: "player" | "enemy") => ({
      id,
      name: id,
      hp: 10,
      maxHp: 10,
      attack: 1,
      defense: 1,
      speed: 1,
      level: 1,
      side,
      ...(opts.ai && side === "player" ? { controller: "ai" as const } : {}),
    });
    const state = createCombatDirector({
      id: "fight",
      anchor: "anchor",
      style: "ruleset",
      party: names.map((name) => unit(name.toLowerCase(), "player")),
      enemies: foes.map((_, i) => unit(`foe${i}`, "enemy")),
      gm: false,
      difficulty: "normal",
      seed: 9,
    });
    state.rulesetFight = built.fight;
    if (opts.ai) for (const name of names) state.rulesetFight.controllers[name.toLowerCase()] = "ai";
    state.stage = rulesetDirectorStage(state);
    return state;
  };
  const at = (state: ReturnType<typeof begin>, id: string) =>
    rulesetPositionOf(state.rulesetFight!.encounter.combatants.find((one) => one.id === id)!)!;
  const centre = (cells: Array<{ x: number; y: number }>) => ({
    x: cells.reduce((sum, one) => sum + one.x, 0) / cells.length,
    y: cells.reduce((sum, one) => sum + one.y, 0) / cells.length,
  });

  {
    // Nobody asked: the fight starts at once, as every fight did.
    const state = begin({});
    assert.equal(state.rulesetFight!.deploy, undefined);
    assert.notEqual(state.stage, "deploy");
  }

  {
    const state = begin({ deploy: true, adaStart: "front" });
    assert.equal(state.stage, "deploy", "the fight waits for the player to set the party down");
    const turns = () => state.rulesetFight!.events.filter((entry) => entry.event.type === "turn").length;
    assert.equal(turns(), 0, "nobody's turn is said before the fight begins");
    const view = directedRulesetView(definition, state)!;
    assert.deepEqual(view.deploy?.ids, ["bram", "cora"], "Ada, whom the story put at the front, is not theirs to move");
    assert.ok(view.deploy!.cells.length > 0, "there are squares to choose");
    const foes = ["foe0", "foe1"].map((id) => at(state, id));
    for (const cell of view.deploy!.cells)
      assert.ok(
        foes.every((foe) => gap(foe, cell) > 2),
        `no lit square beside an opponent: ${JSON.stringify(cell)}`,
      );
    // Ada stands nearer the foes than the rest of the party.
    const foeCentre = centre(foes);
    const toFoes = (id: string) => Math.hypot(at(state, id).x - foeCentre.x, at(state, id).y - foeCentre.y);
    assert.ok(toFoes("ada") < Math.min(toFoes("bram"), toFoes("cora")), "the one who walked in first is at the front");

    // Nobody acts while the party is being set down.
    const refused = commandRulesetCombatDirector(definition, state, { type: "continue" });
    assert.ok(!refused.ok && refused.code === "ruleset_combat_deploying", JSON.stringify(refused));
    const moved = commandRulesetCombatDirector(definition, state, {
      type: "deploy",
      unitId: "ada",
      to: view.deploy!.cells[0]!,
    });
    assert.ok(!moved.ok, "the player does not move whom the story placed");

    // A free lit square takes Bram; a held one, or one not lit, is refused.
    const held = new Set(state.rulesetFight!.encounter.combatants.map((one) => `${one.x},${one.y}`));
    const free = view.deploy!.cells.find((cell) => !held.has(`${cell.x},${cell.y}`))!;
    assert.ok(commandRulesetCombatDirector(definition, state, { type: "deploy", unitId: "bram", to: free }).ok);
    assert.deepEqual(at(state, "bram"), free, "Bram stands where the player put him");
    assert.ok(
      !commandRulesetCombatDirector(definition, state, { type: "deploy", unitId: "cora", to: free }).ok,
      "nobody onto somebody else",
    );
    assert.ok(
      !commandRulesetCombatDirector(definition, state, { type: "deploy", unitId: "cora", to: foes[0]! }).ok,
      "nor onto a square that is not lit",
    );
    assert.equal(state.stage, "deploy");

    // Beginning the fight ends it, and the turns run.
    assert.ok(commandRulesetCombatDirector(definition, state, { type: "deployed" }).ok);
    assert.equal(state.rulesetFight!.deploy, undefined);
    assert.ok(turns() >= 1, "and once it has, whose turn it is");
    assert.notEqual(state.stage, "deploy");
    assert.equal(directedRulesetView(definition, state)!.deploy, undefined);
    assert.ok(
      !commandRulesetCombatDirector(definition, state, { type: "deploy", unitId: "bram", to: free }).ok,
      "and nobody is set down once it has begun",
    );
  }

  {
    // A Game Master who started the whole party somewhere started nobody in particular (laptop party
    // A): the player still sets every one of them down.
    const state = begin({ deploy: true, allStart: true });
    assert.equal(state.stage, "deploy");
    assert.deepEqual(directedRulesetView(definition, state)!.deploy?.ids, ["ada", "bram", "cora"]);
  }

  {
    // Handing the last one the player plays to the Engine begins it as well.
    const state = begin({ deploy: true });
    for (const id of ["ada", "bram"])
      assert.ok(commandRulesetCombatDirector(definition, state, { type: "control", unitId: id, controller: "ai" }).ok);
    assert.equal(state.stage, "deploy");
    assert.ok(
      commandRulesetCombatDirector(definition, state, { type: "control", unitId: "cora", controller: "ai" }).ok,
    );
    assert.equal(state.rulesetFight!.deploy, undefined, "with nobody left to set down, the fight begins");
  }

  {
    // The Game Master's places for opponents, read straight off a board.
    const grid: TacticalGrid = {
      width: 20,
      height: 12,
      tiles: Array.from({ length: 12 }, () => Array.from({ length: 20 }, () => "plains")),
    } as never;
    const placements = {
      a: { x: 2, y: 5 },
      b: { x: 2, y: 6 },
      c: { x: 3, y: 5 },
      x: { x: 16, y: 5 },
      y: { x: 16, y: 6 },
      z: { x: 17, y: 5 },
    };
    const stands = [
      { id: "a", side: "party" as const },
      { id: "b", side: "party" as const },
      { id: "c", side: "party" as const },
      { id: "x", side: "enemy" as const },
      { id: "y", side: "enemy" as const },
      { id: "z", side: "enemy" as const },
    ];
    const placed = rulesetStartPlacements(grid, placements, stands, { x: "behind", y: "among" });
    const party = centre([placements.a, placements.b, placements.c]);
    assert.ok(placed.x!.x < party.x, `one started behind the party stands past it: ${JSON.stringify(placed.x)}`);
    assert.ok(gap(placed.y!, party) <= 1, `one started among them stands in their middle: ${JSON.stringify(placed.y)}`);
    assert.deepEqual(placed.z, placements.z, "one with no place keeps its formation's");
    const keys = Object.values(placed).map((cell) => `${cell.x},${cell.y}`);
    assert.equal(new Set(keys).size, keys.length, "nobody onto anybody else");
    // A caster steps back from the front, a bruiser forward.
    const roles = rulesetStartPlacements(grid, placements, stands, {}, { a: "spellcaster", c: "bruiser" });
    assert.ok(roles.a!.x < placements.a.x, `the caster is set back: ${JSON.stringify(roles.a)}`);
    assert.ok(roles.c!.x > placements.c.x, `the bruiser forward: ${JSON.stringify(roles.c)}`);
  }

  {
    // An ambush on a vast board (laptop party A): the foes ring the party, so a "rear" one goes out past
    // the ring by the board's size, and a pack on a flank keeps to one side together.
    const grid = {
      width: 40,
      height: 26,
      tiles: Array.from({ length: 26 }, () => Array.from({ length: 40 }, () => "plains")),
    } as never;
    const placements: Record<string, { x: number; y: number }> = {
      a: { x: 20, y: 13 },
      b: { x: 20, y: 14 },
      archer: { x: 23, y: 13 },
      z1: { x: 17, y: 13 },
      z2: { x: 20, y: 10 },
      g1: { x: 20, y: 17 },
      g2: { x: 23, y: 16 },
    };
    const stands = [
      { id: "a", side: "party" as const },
      { id: "b", side: "party" as const },
      { id: "archer", side: "enemy" as const, group: "archer" },
      { id: "z1", side: "enemy" as const, group: "zombie" },
      { id: "z2", side: "enemy" as const, group: "zombie" },
      { id: "g1", side: "enemy" as const, group: "ghoul" },
      { id: "g2", side: "enemy" as const, group: "ghoul" },
    ];
    const placed = rulesetStartPlacements(grid, placements, stands, {
      archer: "rear",
      z1: "flank",
      z2: "flank",
      g1: "flank",
      g2: "flank",
    });
    const party = centre([placements.a!, placements.b!]);
    assert.ok(gap(placed.archer!, party) >= 9, `the rear is well out past the ring: ${JSON.stringify(placed.archer)}`);
    const sideOf = (cell: { x: number; y: number }) => Math.sign(cell.y - party.y) || Math.sign(cell.x - party.x);
    assert.equal(sideOf(placed.z1!), sideOf(placed.z2!), "the zombies keep one flank");
    assert.equal(sideOf(placed.g1!), sideOf(placed.g2!), "the ghouls keep one flank");
    assert.notEqual(sideOf(placed.z1!), sideOf(placed.g1!), "the ghouls take the other");
  }

  console.info(
    "Ruleset deployment: the Game Master places opponents and anyone the story put somewhere, the player sets down the rest before the first turn.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
