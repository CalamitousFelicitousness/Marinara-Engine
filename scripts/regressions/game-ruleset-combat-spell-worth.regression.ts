/**
 * What the Engine reads a spell or an ability to be worth by what it puts on whom it lands on.
 *
 *   - A paralysing hold goes on the most dangerous opponent, never on one already held or one that
 *     cannot be held; a condition worth nothing is not cast at all.
 *   - Healing is worth what is missing: no Second Wind at 35 of 44.
 *   - Oil that makes fire hurt more is thrown only where a fire will follow.
 *   - A Counterspell is worth what it stops: a blast at the party far more than a flick.
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
  rulesetWindowOptions,
  type RulesetDefinition,
  type RulesetEncounterState,
  type RulesetStatBlock,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-spell-worth-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { createCombatDirector } = await import("../../packages/server/src/services/game/combat-director.service.js");
const { pickRulesetChoice, rulesetEffectWorth, rulesetStoppedWorth } =
  await import("../../packages/server/src/services/game/ruleset-combat-director.service.js");

try {
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const parsed = (document: unknown): RulesetDefinition => {
    const result = parseRulesetDefinition(document);
    assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
    return result.definition;
  };
  const definition = parsed(JSON.parse(fiveEText));
  const combat = definition.combat!;
  const block = (actions: unknown[], extra: Record<string, unknown> = {}): RulesetStatBlock =>
    ({
      health: 60,
      defense: 12,
      initiativeModifier: 0,
      speed: 30,
      abilities: { str: 10, dex: 10, con: 10, int: 16, wis: 10, cha: 10 },
      actions,
      ...extra,
    }) as unknown as RulesetStatBlock;
  const hold = {
    id: "hold",
    name: "Hold",
    budget: "action",
    range: { normal: 90 },
    save: { save: "wis_save", difficulty: 16, onSuccess: "negates" },
    applies: [{ condition: "paralyzed", duration: { rounds: 10 } }],
  };
  const flick = {
    id: "flick",
    name: "Flick",
    budget: "action",
    toHit: 6,
    range: { normal: 90 },
    damage: { count: 1, sides: 2, flat: 0 },
  };
  const smash = {
    id: "smash",
    name: "Smash",
    budget: "action",
    toHit: 8,
    reach: 1,
    damage: { count: 3, sides: 10, flat: 5 },
  };
  const poke = {
    id: "poke",
    name: "Poke",
    budget: "action",
    toHit: 2,
    reach: 1,
    damage: { count: 1, sides: 2, flat: 0 },
  };
  const unit = (id: string, side: "player" | "enemy") => ({
    id,
    name: id,
    side,
    hp: 60,
    maxHp: 60,
    attack: 8,
    defense: 6,
    speed: 6,
    level: 9,
    skills: [],
    aiHints: { proficiency: "master" as const, temperament: "disciplined" as const },
  });
  const fight = (
    blocks: Record<string, { side: "party" | "enemy"; block: RulesetStatBlock; at: { x: number; y: number } }>,
  ) => {
    const encounter: RulesetEncounterState = createRulesetEncounter({
      definition,
      seed: 1,
      roller: () => 10,
      combatants: Object.entries(blocks).map(([id, one]) => ({ id, name: id, side: one.side, block: one.block })),
      board: {
        grid: { width: 14, height: 8, tiles: Array.from({ length: 8 }, () => Array(14).fill("plains")) },
        placements: Object.fromEntries(Object.entries(blocks).map(([id, one]) => [id, one.at])),
      } as never,
    });
    encounter.order = Object.keys(blocks);
    encounter.turn = 0;
    const state = createCombatDirector({
      id: "fight",
      anchor: "anchor",
      style: "ruleset",
      party: Object.entries(blocks)
        .filter(([, one]) => one.side === "party")
        .map(([id]) => unit(id, "player")),
      enemies: Object.entries(blocks)
        .filter(([, one]) => one.side === "enemy")
        .map(([id]) => unit(id, "enemy")),
      gm: false,
      difficulty: "normal",
      seed: 3,
    } as never);
    return { encounter, state };
  };

  // ── A hold goes on the one that matters, and only where it can take ──
  {
    const scene = (bruteExtra: Record<string, unknown> = {}) =>
      fight({
        mage: { side: "enemy", block: block([hold, flick]), at: { x: 2, y: 4 } },
        brute: { side: "party", block: block([smash], bruteExtra), at: { x: 10, y: 3 } },
        weakling: { side: "party", block: block([poke]), at: { x: 10, y: 5 } },
      });
    const { encounter, state } = scene();
    const picked = pickRulesetChoice(definition, state, encounter, "mage");
    assert.equal(picked?.option.id, "hold", JSON.stringify(picked?.choice));
    assert.equal(picked?.targetId, "brute", "the dangerous one");
    // One that cannot be paralysed is never held: the hold goes elsewhere, or the flick does.
    const immune = scene({ conditionImmunities: ["paralyzed"] });
    const other = pickRulesetChoice(definition, immune.state, immune.encounter, "mage");
    assert.ok(!(other?.option.id === "hold" && other.targetId === "brute"), JSON.stringify(other?.choice));
    // Nobody can be held: it flicks.
    const nobody = fight({
      mage: { side: "enemy", block: block([hold, flick]), at: { x: 2, y: 4 } },
      golem: { side: "party", block: block([smash], { conditionImmunities: ["paralyzed"] }), at: { x: 10, y: 3 } },
    });
    assert.equal(pickRulesetChoice(definition, nobody.state, nobody.encounter, "mage")?.option.id, "flick");
  }

  // ── Healing is worth what is missing: no Second Wind for a scratch ──
  {
    const mend = { id: "mend", name: "Mend", budget: "action", self: true, heal: { count: 1, sides: 10, flat: 5 } };
    const at = (value: number) => {
      const { encounter, state } = fight({
        brom: { side: "enemy", block: block([smash, mend], { health: 44 }), at: { x: 5, y: 4 } },
        foe: { side: "party", block: block([poke]), at: { x: 6, y: 4 } },
      });
      const brom = rulesetCombatant(encounter, "brom")!;
      brom.health = { ...brom.health!, value };
      // A steady fighter, not a reckless one that never stops to mend.
      state.enemies[0]!.tactics = {
        version: 1,
        seed: 0,
        category: "unknown",
        proficiency: "master",
        role: "bruiser",
        adjective: "disciplined",
      };
      return pickRulesetChoice(definition, state, encounter, "brom")?.option.id;
    };
    assert.equal(at(35), "smash", "at 35 of 44 it fights");
    assert.equal(at(8), "mend", "at 8 of 44 it mends");
  }

  // ── Oil is worth throwing only where a fire will follow ──
  {
    combat.conditions = [
      ...(combat.conditions ?? []),
      { condition: "oiled", modifiers: [{ to: "damage-taken", damageType: "fire", flat: 5 }] },
    ] as typeof combat.conditions;
    const rapier = {
      id: "rapier",
      name: "Rapier",
      budget: "action",
      toHit: 5,
      reach: 1,
      damage: { count: 1, sides: 8, flat: 3, type: "piercing" },
    };
    const oil = {
      id: "oil",
      name: "Lamp oil",
      budget: "action",
      toHit: 5,
      range: { normal: 20 },
      applies: [{ condition: "oiled", duration: { rounds: 10 } }],
    };
    const torch = {
      id: "torch",
      name: "Torch",
      budget: "action",
      toHit: 5,
      reach: 1,
      damage: { count: 1, sides: 4, flat: 0, type: "fire" },
    };
    const pick = (withFire: boolean) => {
      const { encounter, state } = fight({
        vex: { side: "enemy", block: block([rapier, oil]), at: { x: 5, y: 4 } },
        ...(withFire ? { torcher: { side: "enemy" as const, block: block([torch]), at: { x: 5, y: 2 } } } : {}),
        foe: { side: "party", block: block([poke]), at: { x: 6, y: 4 } },
      });
      state.enemies.find((one) => one.id === "vex")!.tactics = {
        version: 1,
        seed: 0,
        category: "unknown",
        proficiency: "master",
        role: "skirmisher",
        adjective: "methodical",
      };
      const vex = rulesetCombatant(encounter, "vex")!;
      const worth = rulesetEffectWorth(
        definition,
        combat,
        encounter,
        vex,
        vex.actions.find((action) => action.id === "oil"),
        rulesetCombatant(encounter, "foe")!,
      );
      return { worth, picked: pickRulesetChoice(definition, state, encounter, "vex")?.option.id };
    };
    const dry = pick(false);
    assert.equal(dry.worth, 0, "no fire on its side: oil does nothing worth a turn");
    assert.notEqual(dry.picked, "oil", "so it stays in the pack");
    assert.ok((pick(true).worth ?? 0) > 0, "a torch beside it: oil is worth something");
  }

  // ── A Counterspell is worth what it stops ──
  {
    const counter = {
      id: "counter",
      name: "Counter",
      budget: "reaction",
      range: { normal: 120 },
      reaction: { on: "aimed", cancels: true },
    };
    const blast = {
      id: "blast",
      name: "Blast",
      budget: "action",
      range: { normal: 150 },
      area: { shape: "burst", size: 20 },
      save: { save: "dex_save", difficulty: 15, onSuccess: "half" },
      damage: { count: 8, sides: 6, flat: 0 },
    };
    const worth = (optionId: string, choice: Record<string, unknown>) => {
      const { encounter } = fight({
        caster: { side: "enemy", block: block([blast, flick]), at: { x: 2, y: 4 } },
        mage: { side: "party", block: block([counter, flick]), at: { x: 10, y: 3 } },
        fighter: { side: "party", block: block([smash]), at: { x: 10, y: 5 } },
      });
      encounter.order = ["caster", "mage", "fighter"];
      const step = applyRulesetCombatChoice(
        definition,
        encounter,
        { actorId: "caster", optionId, targetIds: [], ...choice },
        () => 10,
      );
      assert.equal(step.state.window?.kind, "reaction", JSON.stringify(step.events.slice(-3)));
      assert.deepEqual(step.state.window?.waiting, ["mage"]);
      assert.ok(rulesetWindowOptions(definition, step.state, "mage").some((one) => one.id === "counter"));
      return rulesetStoppedWorth(definition, combat, step.state, rulesetCombatant(step.state, "mage")!);
    };
    const small = worth("flick", { targetIds: ["mage"] });
    const big = worth("blast", { at: { x: 10, y: 4 } });
    assert.ok(big > 0.8, `a blast over the party is worth stopping: ${big}`);
    assert.ok(small < 0.1, `a flick is not: ${small}`);

    // A creature's Counterspell, written as one it casts on itself and aimed back at the cast, is
    // taken against the blast and let go against the flick, by a reckless caster as by any other.
    const own = {
      ...counter,
      targets: { side: "self", count: 0 },
      reaction: { on: "aimed", at: "source", cancels: true },
    };
    const answer = (optionId: string, choice: Record<string, unknown>) => {
      const { encounter, state } = fight({
        caster: { side: "enemy", block: block([blast, flick]), at: { x: 2, y: 4 } },
        mage: { side: "party", block: block([own, flick]), at: { x: 10, y: 3 } },
        fighter: { side: "party", block: block([smash]), at: { x: 10, y: 5 } },
      });
      state.party.find((one) => one.id === "mage")!.aiHints = { proficiency: "master", temperament: "reckless" };
      encounter.order = ["caster", "mage", "fighter"];
      const step = applyRulesetCombatChoice(
        definition,
        encounter,
        { actorId: "caster", optionId, targetIds: [], ...choice },
        () => 10,
      );
      const menu = rulesetWindowOptions(definition, step.state, "mage");
      return pickRulesetChoice(definition, state, step.state, "mage", menu)?.choice.optionId;
    };
    assert.equal(answer("blast", { at: { x: 10, y: 4 } }), "counter", "the blast is stopped");
    assert.notEqual(answer("flick", { targetIds: ["mage"] }), "counter", "the flick is let through");

    // Priced by the level of what it stops: a 3rd-level answer is thrown at a cantrip only to keep
    // its thrower alive, and at a 3rd-level blast whenever the blast is worth it.
    const zap = {
      id: "zap",
      name: "Zap",
      budget: "action",
      toHit: 20,
      range: { normal: 90 },
      damage: { count: 3, sides: 10, flat: 10 },
    };
    const priced = (optionId: string, choice: Record<string, unknown>, health: number) => {
      const { encounter, state } = fight({
        caster: { side: "enemy", block: block([blast, zap]), at: { x: 2, y: 4 } },
        mage: { side: "party", block: block([own, flick]), at: { x: 10, y: 3 } },
        fighter: { side: "party", block: block([smash]), at: { x: 10, y: 5 } },
      });
      state.party.find((one) => one.id === "mage")!.aiHints = { proficiency: "master", temperament: "disciplined" };
      const mage = rulesetCombatant(encounter, "mage")!;
      mage.health = { ...mage.health!, value: health };
      mage.actions.find((action) => action.id === "counter")!.castLevel = 3;
      rulesetCombatant(encounter, "caster")!.actions.find((action) => action.id === "blast")!.castLevel = 3;
      encounter.order = ["caster", "mage", "fighter"];
      const step = applyRulesetCombatChoice(
        definition,
        encounter,
        { actorId: "caster", optionId, targetIds: [], ...choice },
        () => 10,
      );
      const menu = rulesetWindowOptions(definition, step.state, "mage");
      return pickRulesetChoice(definition, state, step.state, "mage", menu)?.choice.optionId;
    };
    assert.notEqual(priced("zap", { targetIds: ["mage"] }, 40), "counter", "a cantrip it lives through is let by");
    assert.equal(priced("zap", { targetIds: ["mage"] }, 20), "counter", "a cantrip that would kill it is stopped");
    assert.equal(priced("blast", { at: { x: 10, y: 4 } }, 60), "counter", "the 3rd-level blast is stopped");
    // Held down itself weighs half again what holding a friend does.
    const holding = (target: string) => {
      const { encounter } = fight({
        caster: { side: "enemy", block: block([hold]), at: { x: 2, y: 4 } },
        mage: { side: "party", block: block([counter, flick]), at: { x: 10, y: 3 } },
        fighter: { side: "party", block: block([smash]), at: { x: 10, y: 5 } },
      });
      encounter.order = ["caster", "mage", "fighter"];
      const step = applyRulesetCombatChoice(
        definition,
        encounter,
        { actorId: "caster", optionId: "hold", targetIds: [target] },
        () => 10,
      );
      return rulesetStoppedWorth(definition, combat, step.state, rulesetCombatant(step.state, "mage")!);
    };
    const self = holding("mage");
    const friend = holding("fighter");
    assert.ok(self > friend * 1.2, `held itself ${self}, a friend held ${friend}`);
  }

  // ── A blast over its own side is never worth one nearly dead foe ──
  {
    const fireball = {
      id: "fireball",
      name: "Fireball",
      budget: "action",
      range: { normal: 150 },
      area: { shape: "burst", size: 20 },
      save: { save: "dex_save", difficulty: 15, onSuccess: "half" },
      damage: { count: 8, sides: 6, flat: 0 },
    };
    const { encounter, state } = fight({
      mage: { side: "enemy", block: block([fireball, flick]), at: { x: 2, y: 4 } },
      other: { side: "enemy", block: block([flick]), at: { x: 9, y: 4 } },
      cleric: { side: "party", block: block([poke]), at: { x: 10, y: 4 } },
      fighter: { side: "party", block: block([smash]), at: { x: 13, y: 0 } },
    });
    const cleric = rulesetCombatant(encounter, "cleric")!;
    cleric.health = { ...cleric.health!, value: 3 };
    const picked = pickRulesetChoice(definition, state, encounter, "mage");
    const at = picked?.choice.at;
    assert.ok(
      picked?.option.id !== "fireball" || !at || Math.max(Math.abs(at.x - 9), Math.abs(at.y - 4)) > 4,
      `no Fireball over its friend to finish one at 3 health: ${JSON.stringify(picked?.choice)}`,
    );
  }

  console.log(
    "Spell worth: a hold goes on the most dangerous opponent and never on one that cannot be held; healing is worth what is missing; oil waits for a fire; a Counterspell is worth what it stops.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
