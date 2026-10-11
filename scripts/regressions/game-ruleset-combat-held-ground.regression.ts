/**
 * Held Ground (Capability API 1.318), the showcase's region rule for death.
 *
 *   - Whoever reaches no health on it is felled: an opponent is out of the fight, a character lies
 *     stable and never dying, takes the ground's condition and a mark of Owing, and can be healed up.
 *   - Nothing slays there: what would kill outright fells.
 *   - A blow that `reaps` (the Reaping Hook) reaps whoever it fells: it stays down.
 *   - Off Held Ground nothing changes; the install gate for `reaps`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  advanceRulesetTurn,
  applyRulesetCombatChoice,
  createRulesetEncounter,
  parseRulesetDefinition,
  readRulesetLive,
  rulesetCombatant,
  rulesetCombatConditions,
  rulesetCombatOptions,
  rulesetSheetBuildSchema,
  supportedCapabilityApi,
  type RulesetCombatChoice,
  type RulesetCombatEvent,
  type RulesetDefinition,
  type RulesetEncounterState,
  type RulesetHeldGround,
  type RulesetSheetItem,
  type RulesetStatBlock,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-held-ground-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");

try {
  assert.ok(supportedCapabilityApi.minor >= 318);
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const document = (edit: (doc: Record<string, any>) => void = () => {}): Record<string, any> => {
    const doc = JSON.parse(fiveEText);
    doc.sheet.live.conditions.push({ id: "felled", label: "Felled" });
    doc.sheet.live.tracks.push({ id: "owing", label: "Owing", min: 0, max: 10 });
    doc.combat.conditions.push({ condition: "felled", effects: [] });
    edit(doc);
    return doc;
  };
  const parsed = (doc: unknown): RulesetDefinition => {
    const result = parseRulesetDefinition(doc);
    assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
    return result.definition;
  };
  const definition = parsed(document());
  const held: RulesetHeldGround = {
    label: "Held Ground",
    condition: "felled",
    marks: [{ track: "owing", by: 1 }],
  };
  const hook: RulesetSheetItem = {
    name: "Reaping Hook",
    quantity: 1,
    worn: true,
    item: {
      category: "gear",
      slots: { hands: 1 },
      attack: {
        budget: "action",
        toHit: { abilities: ["str"], bonus: 1 },
        damage: { dice: "1d4", abilities: ["str"], type: "slashing", bonus: 1 },
        reach: 5,
        reaps: true,
      },
    },
  } as never;
  const build = (hp = 50) =>
    rulesetSheetBuildSchema.parse({
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
      fields: { level: 5, ac: 12, speed: 30, hp_max: hp },
      lists: { attacks: [{ name: "Dagger", ability: "dex", proficient: true, bonus: 0, damage: "1d4", reach: 5 }] },
    });
  const block = (extra: Partial<RulesetStatBlock> = {}): RulesetStatBlock =>
    ({
      health: 3,
      defense: 5,
      initiativeModifier: 0,
      speed: 30,
      actions: [
        { id: "claw", name: "Claw", budget: "action", toHit: 10, reach: 5, damage: { count: 1, sides: 4, flat: 20 } },
        {
          id: "reap",
          name: "Reap",
          budget: "action",
          toHit: 10,
          reach: 5,
          damage: { count: 1, sides: 4, flat: 20 },
          reaps: true,
        },
        {
          id: "end",
          name: "End",
          budget: "action",
          reach: 5,
          autoHit: true,
          save: { save: "con_save", difficulty: 30, onSuccess: "negates" },
          slaysOnFailedSave: true,
        },
      ],
      ...extra,
    }) as RulesetStatBlock;
  const roll = (sides: number) => (sides === 20 ? 12 : 3);
  const fight = (ground: RulesetHeldGround | undefined, items: RulesetSheetItem[] = []): RulesetEncounterState => {
    const state = createRulesetEncounter({
      definition,
      seed: 1,
      roller: roll,
      combatants: [
        { id: "cat", name: "Cat", side: "party", build: build(), live: {}, items },
        { id: "ally", name: "Ally", side: "party", build: build(10), live: {} },
        { id: "foe", name: "Foe", side: "enemy", block: block() },
        { id: "imp", name: "Imp", side: "enemy", block: block({ health: 30 }) },
      ],
      board: {
        grid: { width: 12, height: 8, tiles: Array.from({ length: 8 }, () => Array(12).fill("plains")) },
        placements: { cat: { x: 2, y: 2 }, ally: { x: 4, y: 2 }, foe: { x: 3, y: 2 }, imp: { x: 5, y: 2 } },
      },
      ...(ground ? { heldGround: ground } : {}),
    });
    state.order = ["cat", "foe", "imp", "ally"];
    state.turn = 0;
    return state;
  };
  const who = (state: RulesetEncounterState, id: string) => rulesetCombatant(state, id)!;
  const of = <T extends RulesetCombatEvent["type"]>(events: RulesetCombatEvent[], type: T) =>
    events.filter((one): one is Extract<RulesetCombatEvent, { type: T }> => one.type === type);
  const act = (state: RulesetEncounterState, choice: RulesetCombatChoice) => {
    state.turn = state.order.indexOf(choice.actorId);
    const step = applyRulesetCombatChoice(definition, state, choice, roll);
    assert.deepEqual(of(step.events, "refused"), [], JSON.stringify(step.events));
    return step;
  };
  const owing = (state: RulesetEncounterState, id: string) => {
    const sheet = who(state, id).sheet!;
    return readRulesetLive(definition, sheet.build, sheet.live).tracks.find((track) => track.id === "owing")?.value;
  };
  const strike = (state: RulesetEncounterState, label: string, target: string) => {
    const option = rulesetCombatOptions(definition, state, "cat").find((one) => one.label === label);
    assert.ok(option, label);
    return act(state, { actorId: "cat", optionId: option!.id, targetIds: [target] });
  };

  // ── Kept as the fight is handed it ──
  {
    assert.deepEqual(fight(held).heldGround, held);
    assert.deepEqual(fight({ condition: "nonsense", marks: [{ track: "nonsense", by: 1 }] }).heldGround, {});
    assert.equal(fight(undefined).heldGround, undefined);
  }

  // ── An opponent felled, and one reaped ──
  {
    const state = fight(held, [hook]);
    const felled = strike(state, "Dagger", "foe");
    assert.deepEqual(of(felled.events, "felled"), [{ type: "felled", actorId: "foe", label: "Held Ground" }]);
    assert.deepEqual(of(felled.events, "defeated"), []);
    assert.ok(who(felled.state, "foe").felled && who(felled.state, "foe").defeated);
    assert.equal(who(felled.state, "foe").reaped, undefined);
    assert.ok(rulesetCombatConditions(definition, who(felled.state, "foe")).includes("felled"));
    const reaped = strike(fight(held, [hook]), "Reaping Hook", "foe");
    assert.deepEqual(
      of(reaped.events, "reaped").map((one) => [one.actorId, one.sourceId]),
      [["foe", "cat"]],
    );
    assert.ok(who(reaped.state, "foe").reaped && who(reaped.state, "foe").felled);
    assert.ok(!rulesetCombatConditions(definition, who(reaped.state, "foe")).includes("felled"));
    // Off Held Ground, as it always was.
    const plain = strike(fight(undefined, [hook]), "Reaping Hook", "foe");
    assert.deepEqual(
      of(plain.events, "defeated").map((one) => one.actorId),
      ["foe"],
    );
    assert.deepEqual(of(plain.events, "felled"), []);
    assert.deepEqual(of(plain.events, "reaped"), []);
    assert.equal(who(plain.state, "foe").felled, undefined);
  }

  // ── A character felled: stable, never dying, marked, and healed up ──
  {
    const state = fight(held);
    const down = act(state, { actorId: "foe", optionId: "claw", targetIds: ["ally"] });
    const ally = who(down.state, "ally");
    assert.deepEqual(
      of(down.events, "felled").map((one) => one.actorId),
      ["ally"],
    );
    assert.deepEqual(of(down.events, "down"), []);
    assert.ok(ally.down && ally.felled && ally.stable && !ally.dying && !ally.defeated);
    assert.ok(rulesetCombatConditions(definition, ally).includes("felled"));
    assert.equal(owing(down.state, "ally"), 1, "a mark of Owing");
    // Hurt again, nothing: no failures, no death.
    who(down.state, "imp").budgets.action = 1;
    const again = act(down.state, { actorId: "imp", optionId: "claw", targetIds: ["ally"] });
    assert.ok(!who(again.state, "ally").defeated);
    assert.deepEqual(of(again.events, "dying"), []);
    // Their own turn: no death save.
    again.state.turn = 2;
    const turn = advanceRulesetTurn(definition, again.state, roll);
    assert.deepEqual(of(turn.events, "dying"), []);
    assert.ok(who(turn.state, "ally").felled);
    // Healed, they are up and no longer felled.
    const potion: RulesetSheetItem = {
      name: "Potion",
      quantity: 1,
      worn: false,
      item: {
        category: "gear",
        use: { kind: "heal", budget: "action", targets: "ally", range: 10, amount: { flat: 5 }, consumes: true },
      },
    } as never;
    const nursed = fight(held, [potion]);
    const hurt = act(nursed, { actorId: "foe", optionId: "claw", targetIds: ["ally"] });
    hurt.state.turn = 0;
    const drink = rulesetCombatOptions(definition, hurt.state, "cat").find((one) => one.label === "Potion");
    assert.ok(drink);
    const up = act(hurt.state, { actorId: "cat", optionId: drink!.id, targetIds: ["ally"] });
    assert.deepEqual(
      of(up.events, "revived").map((one) => one.actorId),
      ["ally"],
    );
    assert.ok(!who(up.state, "ally").down);
    assert.equal(who(up.state, "ally").felled, undefined);
    // What would slay outright fells instead.
    const slain = act(fight(held), { actorId: "foe", optionId: "end", targetIds: ["cat"] });
    assert.deepEqual(of(slain.events, "slain"), []);
    assert.deepEqual(
      of(slain.events, "felled").map((one) => one.actorId),
      ["cat"],
    );
    assert.ok(!who(slain.state, "cat").defeated);
    // Off Held Ground it kills.
    const killed = act(fight(undefined), { actorId: "foe", optionId: "end", targetIds: ["cat"] });
    assert.ok(who(killed.state, "cat").defeated);
    // A character reaped is dead.
    const reaped = act(fight(held), { actorId: "foe", optionId: "reap", targetIds: ["ally"] });
    assert.ok(who(reaped.state, "ally").reaped && who(reaped.state, "ally").defeated);
    assert.equal(owing(reaped.state, "ally"), 0, "no mark for the reaped");
  }

  // ── The install gate ──
  {
    const gate = "A ruleset with a blow that reaps requires schemaVersion 2 and capabilityApi 1.318 or newer";
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
    const reaper = document((doc) => {
      const creatures = doc.catalogs.find((catalog: { holds?: string }) => catalog.holds === "creatures");
      creatures.entries[0].creature.actions[0].reaps = true;
    });
    parsed(reaper);
    assert.equal(getCapabilityPackageInstallIssue(manifest(317) as never, reaper), gate);
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(318) as never, reaper), gate);
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(317) as never, document()), gate);
  }

  console.log(
    "Held Ground: the felled are out of the fight or stable and marked, nothing slays, and a blow that reaps keeps them down.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
