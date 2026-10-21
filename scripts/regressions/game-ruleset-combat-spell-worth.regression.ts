/**
 * What the Engine reads a spell or an ability to be worth by what it puts on whom it lands on.
 *
 *   - A paralysing hold goes on the most dangerous opponent, never on one already held or one that
 *     cannot be held; a condition worth nothing is not cast at all.
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
const { pickRulesetChoice, rulesetStoppedWorth } =
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
  const poke = { id: "poke", name: "Poke", budget: "action", toHit: 2, reach: 1, damage: { flat: 1 } };
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
  }

  console.log(
    "Spell worth: a hold goes on the most dangerous opponent and never on one that cannot be held; a Counterspell is worth what it stops.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
