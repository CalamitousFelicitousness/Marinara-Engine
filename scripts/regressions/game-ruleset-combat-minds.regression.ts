/**
 * How much thought a creature puts into a fight (Capability API 1.708), and the rest of what the Engine
 * weighs for the creatures it plays.
 *
 *   - A creature's mind is its own `mind`, else its type's, else the tier its `combat.minds` ability
 *     reaches; legendary makes `tactical` a `genius`. With nothing said, a beast fights by instinct and
 *     a construct or an ooze never thinks.
 *   - A mindless creature goes at whoever is nearest and stays on them; a thinking one finishes the
 *     weak. A cowardly one that is hurt gets away; a protective one goes at whoever is on its hurt friend.
 *   - Refusals and the install gate.
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
  rulesetCombatantMind,
  rulesetStatBlockFromCreature,
  supportedCapabilityApi,
  type CombatAiHints,
  type RulesetDefinition,
  type RulesetEncounterState,
  type RulesetStatBlock,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-combat-minds-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");
const { createCombatDirector } = await import("../../packages/server/src/services/game/combat-director.service.js");
const { pickRulesetChoice } =
  await import("../../packages/server/src/services/game/ruleset-combat-director.service.js");

try {
  assert.ok(supportedCapabilityApi.minor >= 708);
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const types = [
    { id: "beast", label: "Beast", mind: "instinct" },
    { id: "construct", label: "Construct", mind: "mindless" },
    { id: "humanoid", label: "Humanoid" },
    { id: "monstrosity", label: "Monstrosity" },
    { id: "undead", label: "Undead" },
    { id: "ooze", label: "Ooze" },
  ];
  const minds = {
    ability: "int",
    tiers: [
      { atLeast: 0, mind: "mindless" },
      { atLeast: 3, mind: "cunning" },
      { atLeast: 8, mind: "tactical" },
      { atLeast: 15, mind: "genius" },
    ],
  };
  const fiveE = (options: { types?: unknown; minds?: unknown } = {}): Record<string, any> => {
    const doc = JSON.parse(fiveEText) as Record<string, any>;
    doc.combat.creatureTypes = { types: options.types ?? types };
    if (options.minds !== null) doc.combat.minds = options.minds ?? minds;
    return doc;
  };
  const parsed = (document: unknown): RulesetDefinition => {
    const result = parseRulesetDefinition(document);
    assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
    return result.definition;
  };
  const refused = (document: unknown, pattern: RegExp) => {
    const result = parseRulesetDefinition(document);
    assert.equal(result.ok, false, `should be refused: ${pattern}`);
    if (!result.ok) assert.match(result.issues.join("; "), pattern);
  };
  const claw = {
    id: "claw",
    name: "Claw",
    budget: "action",
    toHit: 4,
    damage: { count: 1, sides: 6, flat: 2 },
    reach: 1,
  };
  const block = (extra: Record<string, unknown> = {}): RulesetStatBlock =>
    ({
      health: 20,
      defense: 12,
      initiativeModifier: 0,
      speed: 30,
      abilities: { str: 12, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
      actions: [claw],
      ...extra,
    }) as unknown as RulesetStatBlock;
  const definition = parsed(fiveE());

  // ── Its mind, from its own data ──
  {
    const mindOf = (def: RulesetDefinition, extra: Record<string, unknown>) => {
      const state = createRulesetEncounter({
        definition: def,
        seed: 1,
        roller: () => 10,
        combatants: [{ id: "it", name: "It", side: "enemy", block: block(extra) }],
      });
      return rulesetCombatantMind(def, rulesetCombatant(state, "it")!);
    };
    const int = (score: number) => ({ abilities: { str: 10, dex: 10, con: 10, int: score, wis: 10, cha: 10 } });
    assert.equal(mindOf(definition, { type: "monstrosity", ...int(22) }), "genius", "a kraken");
    assert.equal(mindOf(definition, { type: "beast", ...int(6) }), "instinct", "an ape, by its type");
    assert.equal(mindOf(definition, { type: "construct", ...int(6) }), "mindless", "a golem, by its type");
    assert.equal(mindOf(definition, { type: "undead", ...int(3), mind: "mindless" }), "mindless", "a zombie, its own");
    assert.equal(mindOf(definition, { type: "humanoid", ...int(7) }), "cunning", "an orc");
    assert.equal(mindOf(definition, { type: "humanoid", ...int(10) }), "tactical", "a soldier");
    assert.equal(
      mindOf(definition, { type: "humanoid", ...int(12), legendaryResistance: 3 }),
      "genius",
      "legendary makes a tactician a genius",
    );
    assert.equal(mindOf(definition, { type: "undead", ...int(1) }), "mindless", "Intelligence 1");
    // A ruleset that says nothing of minds still knows an animal and a thing that never thinks.
    const bare = parsed(fiveE({ types: types.map(({ mind: _mind, ...one }) => one), minds: null }));
    assert.equal(mindOf(bare, { type: "beast" }), "instinct");
    assert.equal(mindOf(bare, { type: "ooze" }), "mindless");
    assert.equal(mindOf(bare, { type: "humanoid" }), undefined, "played as it always was");

    // A bestiary creature's own mind, morale and leader reach the fight (1.708, 1.709).
    const doc = fiveE();
    const creatures = doc.catalogs.find((one: { holds?: string }) => one.holds === "creatures");
    const lurker = creatures.entries.find((one: { id: string }) => one.id === "thorn-lurker");
    Object.assign(lurker.creature, { type: "undead", mind: "mindless", morale: 8, leader: true });
    const withLurker = parsed(doc);
    const entry = withLurker
      .catalogs!.find((one) => one.holds === "creatures")!
      .entries!.find((one) => one.id === "thorn-lurker")!;
    const built = rulesetStatBlockFromCreature(withLurker, (entry as { creature: never }).creature)!;
    const state = createRulesetEncounter({
      definition: withLurker,
      seed: 1,
      roller: () => 10,
      combatants: [{ id: "it", name: "It", side: "enemy", block: built }],
    });
    const it = rulesetCombatant(state, "it")!;
    assert.equal(rulesetCombatantMind(withLurker, it), "mindless", "a zombie's own mind, from the bestiary");
    assert.equal(it.block?.morale, 8);
    assert.equal(it.block?.leader, true);
  }

  // ── How the Engine plays them ──
  const unit = (id: string, side: "player" | "enemy", aiHints?: CombatAiHints) => ({
    id,
    name: id,
    side,
    hp: 20,
    maxHp: 20,
    attack: 8,
    defense: 6,
    speed: 6,
    level: 9,
    skills: [],
    ...(aiHints ? { aiHints } : {}),
  });
  const fight = (
    placements: Record<string, { x: number; y: number }>,
    blocks: Record<string, { side: "party" | "enemy"; block: RulesetStatBlock; health?: number }>,
    hints: Record<string, CombatAiHints> = {},
  ) => {
    const encounter: RulesetEncounterState = createRulesetEncounter({
      definition,
      seed: 1,
      roller: () => 10,
      combatants: Object.entries(blocks).map(([id, one]) => ({ id, name: id, side: one.side, block: one.block })),
      board: {
        grid: { width: 10, height: 6, tiles: Array.from({ length: 6 }, () => Array(10).fill("plains")) },
        placements,
      } as never,
    });
    for (const [id, one] of Object.entries(blocks))
      if (one.health !== undefined) {
        const combatant = rulesetCombatant(encounter, id)!;
        combatant.health = { ...combatant.health!, value: one.health };
      }
    encounter.order = Object.keys(blocks);
    encounter.turn = 0;
    const state = createCombatDirector({
      id: "fight",
      anchor: "anchor",
      style: "ruleset",
      party: Object.entries(blocks)
        .filter(([, one]) => one.side === "party")
        .map(([id]) => unit(id, "player", hints[id])),
      enemies: Object.entries(blocks)
        .filter(([, one]) => one.side === "enemy")
        .map(([id]) => unit(id, "enemy", hints[id])),
      gm: false,
      difficulty: "normal",
      seed: 3,
    } as never);
    // A temperament asked for is the one it has, not merely the likeliest.
    for (const one of [...state.party, ...state.enemies]) {
      const temperament = hints[one.id]?.temperament;
      if (temperament && one.tactics) one.tactics.adjective = temperament;
    }
    return { encounter, state };
  };
  const master = { proficiency: "master" as const };

  // A mindless zombie goes at the nearest; a thinking one at whoever it can finish.
  for (const [mind, expected] of [
    ["mindless", "tank"],
    ["tactical", "weak"],
  ] as const) {
    const { encounter, state } = fight(
      { it: { x: 2, y: 2 }, tank: { x: 3, y: 2 }, weak: { x: 4, y: 4 } },
      {
        it: { side: "enemy", block: block({ type: "undead", mind }) },
        tank: { side: "party", block: block({ health: 40 }) },
        weak: { side: "party", block: block(), health: 1 },
      },
      { it: master },
    );
    const picked = pickRulesetChoice(definition, state, encounter, "it");
    assert.equal(picked?.targetId, expected, `${mind}: ${JSON.stringify(picked?.choice)}`);
    assert.equal(state.enemies[0]!.tactics!.mind, mind, "its profile made with its mind");
  }

  // Whom it goes for by what it is (P6): a genius at whoever has done its side the most harm, an animal
  // at the weaker.
  for (const [mind, expected] of [
    ["genius", "striker"],
    ["instinct", "near"],
  ] as const) {
    const { encounter, state } = fight(
      { it: { x: 2, y: 2 }, near: { x: 3, y: 2 }, striker: { x: 3, y: 3 } },
      {
        it: { side: "enemy", block: block({ type: mind === "genius" ? "monstrosity" : "beast", mind }) },
        near: { side: "party", block: block({ health: 30 }), health: 20 },
        striker: { side: "party", block: block({ health: 30 }) },
      },
      { it: master },
    );
    rulesetCombatant(encounter, "striker")!.done = { dealt: 40 };
    encounter.round = 2;
    const picked = pickRulesetChoice(definition, state, encounter, "it");
    assert.equal(picked?.targetId, expected, `${mind}: ${JSON.stringify(picked?.choice)}`);
    // What it then deals is counted to it, against the other side only.
    const step = applyRulesetCombatChoice(definition, encounter, picked!.choice, () => 19);
    assert.ok((rulesetCombatant(step.state, "it")!.done?.dealt ?? 0) > 0, JSON.stringify(step.events.slice(0, 4)));
  }

  // A cowardly goblin that is hurt gets away; a reckless one fights on.
  for (const [temperament, gets] of [
    ["cowardly", true],
    ["reckless", false],
  ] as const) {
    const { encounter, state } = fight(
      { goblin: { x: 4, y: 2 }, hero: { x: 5, y: 2 } },
      {
        goblin: { side: "enemy", block: block({ type: "humanoid" }), health: 2 },
        hero: { side: "party", block: block({ health: 40 }) },
      },
      { goblin: { ...master, temperament } },
    );
    const picked = pickRulesetChoice(definition, state, encounter, "goblin");
    assert.equal(picked?.defensive === "disengage", gets, `${temperament}: ${JSON.stringify(picked?.choice)}`);
    if (gets) assert.ok(picked!.to && picked!.to.x < 4, "and runs from the hero");
  }

  // A hurt animal hides for two turns at most, then fights; after a blow it is careful for one turn
  // at most before it goes back in, not two more.
  {
    const { encounter, state } = fight(
      { wolf: { x: 0, y: 0 }, hero: { x: 6, y: 0 } },
      {
        wolf: { side: "enemy", block: block({ type: "beast", mind: "instinct" }), health: 2 },
        hero: { side: "party", block: block({ health: 40 }) },
      },
      { wolf: master },
    );
    const picks = Array.from({ length: 5 }, () => pickRulesetChoice(definition, state, encounter, "wolf"));
    assert.ok(picks[0]?.defensive, `it starts careful: ${JSON.stringify(picks[0]?.choice)}`);
    const seen = JSON.stringify(picks.map((one) => one?.choice.optionId));
    assert.ok(picks[1]?.defensive && !picks[2]?.defensive, `two turns of it, then it fights: ${seen}`);
    assert.ok(!picks[4]?.defensive, `one careful turn after a blow: ${seen}`);
  }

  // Standing in burning oil, it steps out of it to fight rather than taking the flames next turn.
  {
    const { encounter, state } = fight(
      { wolf: { x: 4, y: 2 }, hero: { x: 5, y: 2 } },
      {
        wolf: { side: "enemy", block: block({ type: "beast", mind: "instinct" }) },
        hero: { side: "party", block: block({ health: 40 }) },
      },
      { wolf: master },
    );
    const hero = rulesetCombatant(encounter, "hero")!;
    const rule = { rounds: 10, anchor: "point", triggers: ["turn-start"], atCast: false };
    hero.actions.push({
      ...hero.actions[0]!,
      id: "oil",
      label: "Burning oil",
      damage: { count: 3, sides: 6, flat: 0 },
      zone: rule,
    } as never);
    hero.zones = [
      { actionId: "oil", label: "Burning oil", ...rule, at: { x: 4, y: 2 }, cells: [{ x: 4, y: 2 }] } as never,
    ];
    const picked = pickRulesetChoice(definition, state, encounter, "wolf");
    assert.ok(
      picked?.to && (picked.to.x !== 4 || picked.to.y !== 2),
      `it steps out of the fire: ${JSON.stringify(picked?.to)}`,
    );
  }

  // A healthy wolf beside its prey bites; a hurt coward with nobody beside it never Disengages.
  {
    const { encounter, state } = fight(
      { wolf: { x: 4, y: 2 }, hero: { x: 5, y: 2 } },
      {
        wolf: { side: "enemy", block: block({ type: "beast", mind: "instinct" }) },
        hero: { side: "party", block: block({ health: 40 }) },
      },
      { wolf: master },
    );
    const picked = pickRulesetChoice(definition, state, encounter, "wolf");
    assert.equal(picked?.targetId, "hero", `it bites: ${JSON.stringify(picked?.choice)}`);
  }
  {
    const { encounter, state } = fight(
      { goblin: { x: 0, y: 0 }, hero: { x: 9, y: 5 } },
      {
        goblin: { side: "enemy", block: block({ type: "humanoid" }), health: 2 },
        hero: { side: "party", block: block({ health: 40 }) },
      },
      { goblin: { ...master, temperament: "cowardly" } },
    );
    const picked = pickRulesetChoice(definition, state, encounter, "goblin");
    assert.notEqual(picked?.defensive, "disengage", `nobody to get away from: ${JSON.stringify(picked?.choice)}`);
  }

  // A protective guard goes at whoever is on its hurt friend.
  {
    const { encounter, state } = fight(
      { guard: { x: 4, y: 2 }, friend: { x: 4, y: 4 }, near: { x: 5, y: 2 }, bully: { x: 5, y: 4 } },
      {
        guard: { side: "enemy", block: block({ type: "humanoid" }) },
        friend: { side: "enemy", block: block({ type: "humanoid" }), health: 4 },
        near: { side: "party", block: block() },
        bully: { side: "party", block: block() },
      },
      { guard: { ...master, temperament: "protective" } },
    );
    const picked = pickRulesetChoice(definition, state, encounter, "guard");
    assert.equal(picked?.targetId, "bully", JSON.stringify(picked?.choice));
  }

  // ── Refused ──
  refused(
    fiveE({
      minds: {
        ability: "int",
        tiers: [
          { atLeast: 8, mind: "tactical" },
          { atLeast: 3, mind: "cunning" },
        ],
      },
    }),
    /Each tier starts above/,
  );
  refused(fiveE({ types: [{ id: "beast", label: "Beast", mind: "clever" }] }), /mind/);

  // ── The install gate ──
  {
    const gate =
      "A ruleset with how much thought a creature puts into a fight (a creature's or a creature type's mind, or combat.minds) requires schemaVersion 2 and capabilityApi 1.708 or newer";
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
    assert.equal(getCapabilityPackageInstallIssue(manifest(707) as never, fiveE()), gate);
    assert.equal(
      getCapabilityPackageInstallIssue(manifest(707) as never, fiveE({ types: [{ id: "x", label: "X" }] })),
      gate,
      "combat.minds alone",
    );
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(708) as never, fiveE()), gate);
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(707) as never, JSON.parse(fiveEText)), gate);
  }

  console.log(
    "Combat minds: a kraken a genius, an ape by instinct, a golem and a zombie mindless; the mindless go at the nearest, a hurt coward gets away, a guard goes at whoever is on its friend, a genius at whoever does its side most harm, an animal at the weaker; gated at 1.708.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
