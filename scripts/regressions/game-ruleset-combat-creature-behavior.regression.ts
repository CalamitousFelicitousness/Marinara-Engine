/**
 * How a creature goes about a fight, as its own data says (Capability API 1.710).
 *
 *   - `behavior` on `combat`, a creature type and a stat block, merged key by key, the creature's own
 *     winning; its temperament and role over the dealt ones, unless the Game Master gave one.
 *   - `targets`: casters, whoever hurt it; `pack`: whoever a friend stands beside.
 *   - `opens`: its opener on its first turn, and only once.
 *   - `ambush`: a bestiary creature keeps still out of reach and springs once its prey comes close.
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
  defaultRulesetSheetBuild,
  parseRulesetDefinition,
  rulesetCombatant,
  rulesetCombatantBehavior,
  rulesetCombatantRole,
  rulesetEncounterSummary,
  supportedCapabilityApi,
  type RulesetCombatEvent,
  type RulesetDefinition,
  type RulesetEncounterState,
  type RulesetStatBlock,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-creature-behavior-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");
const { createCombatDirector } = await import("../../packages/server/src/services/game/combat-director.service.js");
const {
  commandRulesetCombatDirector,
  createRulesetFight,
  pickRulesetChoice,
  rulesetDirectorStage,
  syncRulesetCombatants,
} = await import("../../packages/server/src/services/game/ruleset-combat-director.service.js");

try {
  assert.ok(supportedCapabilityApi.minor >= 710);
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const fiveE = (edit?: (doc: Record<string, any>) => void): Record<string, any> => {
    const doc = JSON.parse(fiveEText) as Record<string, any>;
    edit?.(doc);
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
  const lurkerEntry = (doc: Record<string, any>) =>
    doc.catalogs
      .find((one: { holds?: string }) => one.holds === "creatures")
      .entries.find((one: { id: string }) => one.id === "thorn-lurker").creature;

  // ── Merged key by key ──
  const definition = parsed(
    fiveE((doc) => {
      doc.combat.behavior = { targets: ["nearest"], temperament: "disciplined" };
      doc.combat.creatureTypes = {
        types: [{ id: "beast", label: "Beast", behavior: { pack: true, temperament: "reckless" } }],
      };
      lurkerEntry(doc).behavior = { temperament: "cautious", ambush: true };
    }),
  );
  const combat = definition.combat!;
  const block = (actions: unknown[], extra: Record<string, unknown> = {}): RulesetStatBlock =>
    ({
      health: 60,
      defense: 12,
      initiativeModifier: 0,
      speed: 30,
      abilities: { str: 10, dex: 10, con: 10, int: 12, wis: 10, cha: 10 },
      actions,
      ...extra,
    }) as unknown as RulesetStatBlock;
  const bolt = {
    id: "bolt",
    name: "Bolt",
    budget: "action",
    toHit: 6,
    range: { normal: 90 },
    damage: { count: 2, sides: 6, flat: 0 },
  };
  const smash = {
    id: "smash",
    name: "Smash",
    budget: "action",
    toHit: 6,
    reach: 1,
    damage: { count: 3, sides: 10, flat: 5 },
  };
  const spark = {
    id: "spark",
    name: "Spark",
    budget: "action",
    range: { normal: 60 },
    save: { save: "dex_save", difficulty: 12, onSuccess: "half" },
    damage: { count: 1, sides: 6, flat: 0 },
  };
  const warding = {
    id: "warding",
    name: "Warding",
    budget: "action",
    self: true,
    concentration: true,
    applies: [{ condition: "blessed", duration: { rounds: 10 } }],
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
    aiHints: { proficiency: "master" as const },
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
        grid: { width: 16, height: 10, tiles: Array.from({ length: 10 }, () => Array(16).fill("plains")) },
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
  {
    const { encounter } = fight({
      wolf: {
        side: "enemy",
        block: block([bolt], { type: "beast", behavior: { role: "skirmisher" } }),
        at: { x: 2, y: 2 },
      },
      hero: { side: "party", block: block([smash]), at: { x: 9, y: 2 } },
    });
    assert.deepEqual(rulesetCombatantBehavior(definition, rulesetCombatant(encounter, "wolf")!), {
      targets: ["nearest"],
      temperament: "reckless",
      pack: true,
      role: "skirmisher",
    });
    assert.deepEqual(rulesetCombatantBehavior(definition, rulesetCombatant(encounter, "hero")!), {
      targets: ["nearest"],
      temperament: "disciplined",
    });
  }

  // ── With no role of its own, one read off what it can do (not every creature a bruiser) ──
  {
    const { encounter } = fight({
      archer: { side: "enemy", block: block([bolt]), at: { x: 2, y: 2 } },
      brute: { side: "enemy", block: block([smash]), at: { x: 3, y: 2 } },
      priest: {
        side: "enemy",
        block: block([
          smash,
          { id: "mend", name: "Mend", budget: "action", targets: "ally", heal: { count: 1, sides: 8, flat: 2 } },
        ]),
        at: { x: 4, y: 2 },
      },
      hero: { side: "party", block: block([smash]), at: { x: 9, y: 2 } },
    });
    assert.equal(rulesetCombatantRole(rulesetCombatant(encounter, "archer")!), "marksman");
    assert.equal(rulesetCombatantRole(rulesetCombatant(encounter, "brute")!), "bruiser");
    assert.equal(rulesetCombatantRole(rulesetCombatant(encounter, "priest")!), "supporter");
    // A class feature or a torch from a catalog is no spell: a fighter with Second Wind is no caster.
    const brute = rulesetCombatant(encounter, "brute")!;
    const feature = { ...brute.actions[0]!, id: "second_wind", catalog: "features", damage: undefined };
    brute.actions = [...brute.actions, feature];
    assert.equal(rulesetCombatantRole(brute), "bruiser", "a catalog feature");
    // Nor a spell only a condition would give it: 5e's Potion of Animal Friendship,
    // on every combatant's list and offered only while drunk.
    const potion = { ...feature, id: "granted:animal_friend:spells/animal-friendship", components: ["verbal"] };
    brute.actions = [...brute.actions, { ...potion, whileHolds: "animal_friend", applies: [{ condition: "charmed" }] }];
    assert.equal(rulesetCombatantRole(brute), "bruiser", "a spell a potion would give");
    brute.actions = brute.actions.filter((action) => action.id !== potion.id);
    brute.actions = [...brute.actions, { ...feature, id: "bolt_spell", components: ["verbal"] }];
    assert.equal(rulesetCombatantRole(brute), "spellcaster", "a spell cast with words");
  }

  // ── Roles read off what it does (combat AI A2): no dragon a bulwark for its armour ──
  {
    const { encounter } = fight({
      dragon: { side: "enemy", block: block([smash], { defense: 19, legendaryResistance: 3 }), at: { x: 2, y: 2 } },
      plated: { side: "enemy", block: block([smash], { defense: 19 }), at: { x: 3, y: 2 } },
      guardian: {
        side: "enemy",
        block: block([
          smash,
          {
            id: "shield",
            name: "Shield",
            budget: "reaction",
            reaction: { on: "hit", for: "ally", within: 5, at: "target" },
          },
        ]),
        at: { x: 4, y: 2 },
      },
      knight: {
        side: "enemy",
        block: block([
          smash,
          { id: "parry", name: "Parry", budget: "reaction", reaction: { on: "hit", blow: "melee" } },
        ]),
        at: { x: 5, y: 2 },
      },
      goblin: {
        side: "enemy",
        block: block([
          smash,
          { id: "nimble", name: "Nimble Escape", budget: "bonus", standard: { actions: ["disengage", "hide"] } },
        ]),
        at: { x: 6, y: 2 },
      },
      hero: { side: "party", block: block([smash]), at: { x: 9, y: 2 } },
    });
    const role = (id: string) => rulesetCombatantRole(rulesetCombatant(encounter, id)!, definition, encounter);
    assert.equal(role("dragon"), "solo");
    assert.equal(role("plated"), "bruiser", "armour alone makes nobody a bulwark");
    assert.equal(role("guardian"), "bulwark");
    assert.equal(role("knight"), "bulwark");
    assert.equal(role("goblin"), "skirmisher");
    // 5e's own Parry puts a condition on it worth +2 AC for the one attack: still a bulwark. One that
    // puts anything else on itself is not turning a blow aside.
    const knight = rulesetCombatant(encounter, "knight")!;
    const parry = knight.actions.find((action) => action.id === "parry")!;
    parry.applies = [{ condition: "parrying", duration: { rounds: 1 } }] as never;
    assert.equal(role("knight"), "bulwark", "a Parry written as a condition");
    parry.applies = [{ condition: "blessed", duration: { rounds: 1 } }] as never;
    assert.equal(role("knight"), "bruiser", "a reaction that blesses itself");
    // Feet much quicker than its side's, on blows no harder than theirs.
    const quick = rulesetCombatant(encounter, "plated")!;
    quick.speed = 60;
    assert.equal(role("plated"), "skirmisher");
    assert.equal(rulesetCombatantRole(quick), "bruiser", "with no fight to read its side from");
  }

  // ── In and out again (combat AI A4): a goblin strikes and slips away; a brute stands ──
  {
    const nimble = {
      id: "nimble",
      name: "Nimble Escape",
      budget: "bonus",
      standard: { actions: ["disengage", "hide"] },
    };
    const strikes = (actions: unknown[]) => {
      const { encounter, state } = fight({
        goblin: { side: "enemy", block: block(actions), at: { x: 8, y: 2 } },
        hero: { side: "party", block: block([smash], { health: 200 }), at: { x: 9, y: 2 } },
      });
      state.rulesetFight = { encounter, events: [], eventSeq: 0, controllers: { hero: "manual" }, bosses: [] } as never;
      syncRulesetCombatants(definition, state);
      state.stage = rulesetDirectorStage(state);
      assert.ok(commandRulesetCombatDirector(definition, state, { type: "continue" }).ok);
      const after = state.rulesetFight!.encounter;
      const goblin = rulesetCombatant(after, "goblin")!;
      const hero = rulesetCombatant(after, "hero")!;
      return {
        struck: state.rulesetFight!.events.some(
          (entry) => entry.event.type === "attack" && "actorId" in entry.event && entry.event.actorId === "goblin",
        ),
        gap: Math.max(Math.abs(goblin.x! - hero.x!), Math.abs(goblin.y! - hero.y!)),
        hit: hero.health!.value < 200,
      };
    };
    const goblin = strikes([smash, nimble]);
    assert.ok(goblin.struck, "the goblin strikes");
    assert.ok(goblin.gap > 1, `and is gone again: ${goblin.gap}`);
    const brute = strikes([smash]);
    assert.ok(brute.struck);
    assert.equal(brute.gap, 1, "a brute stands and fights");
  }

  // ── A bodyguard (combat AI A5): it goes at whoever is on the caster it keeps, not the one beside it ──
  {
    const scene = (behavior?: Record<string, unknown>) =>
      fight({
        guard: { side: "enemy", block: block([smash], behavior ? { behavior } : {}), at: { x: 5, y: 2 } },
        mage: { side: "enemy", block: block([{ ...bolt, components: ["verbal"] }]), at: { x: 2, y: 6 } },
        near: { side: "party", block: block([smash]), at: { x: 8, y: 2 } },
        onMage: { side: "party", block: block([smash]), at: { x: 2, y: 7 } },
      });
    const free = scene();
    assert.equal(pickRulesetChoice(definition, free.state, free.encounter, "guard")?.choice.targetIds[0], "near");
    const kept = scene({ guards: ["casters"] });
    assert.equal(
      pickRulesetChoice(definition, kept.state, kept.encounter, "guard")?.choice.targetIds[0],
      "onMage",
      "the one on its charge",
    );
    // A standing order, so a mindless one keeps it too (a Shield Guardian, a zombie).
    const golem = scene({ guards: ["casters"] });
    rulesetCombatant(golem.encounter, "guard")!.block!.mind = "mindless" as never;
    assert.equal(
      pickRulesetChoice(definition, golem.state, golem.encounter, "guard")?.choice.targetIds[0],
      "onMage",
      "a mindless guard too",
    );
    // Nobody of the kind it keeps: it fights as it would.
    const alone = scene({ guards: ["healers"] });
    assert.equal(pickRulesetChoice(definition, alone.state, alone.encounter, "guard")?.choice.targetIds[0], "near");
  }

  // ── A leader (combat AI A6): it opens with what helps its side, and steadies those running ──
  {
    const cry = {
      id: "cry",
      name: "Battle Cry",
      budget: "action",
      targets: "ally",
      targetCount: 3,
      range: { normal: 30 },
      applies: [{ condition: "parrying", duration: { rounds: 10 } }],
    };
    const scene = (leader: boolean) =>
      fight({
        chief: {
          side: "enemy",
          block: block([smash, cry], leader ? { leader: true } : {}),
          at: { x: 3, y: 3 },
        },
        left: { side: "enemy", block: block([smash]), at: { x: 3, y: 4 } },
        right: { side: "enemy", block: block([smash]), at: { x: 4, y: 3 } },
        hero: { side: "party", block: block([smash]), at: { x: 9, y: 3 } },
      });
    const led = scene(true);
    assert.equal(
      pickRulesetChoice(definition, led.state, led.encounter, "chief")?.option.id,
      "cry",
      "it rallies first",
    );
    const plain = scene(false);
    assert.notEqual(pickRulesetChoice(definition, plain.state, plain.encounter, "chief")?.option.id, "cry");

    const morale = parsed(
      fiveE((doc) => {
        doc.combat.morale = { check: { roll: "2d6" }, on: ["hurt"] };
      }),
    );
    const { encounter, state } = fight({
      chief: { side: "enemy", block: block([smash], { leader: true }), at: { x: 3, y: 3 } },
      near: { side: "enemy", block: block([smash]), at: { x: 5, y: 5 } },
      far: { side: "enemy", block: block([smash]), at: { x: 14, y: 9 } },
      hero: { side: "party", block: block([smash]), at: { x: 14, y: 0 } },
    });
    for (const id of ["near", "far"]) {
      const one = rulesetCombatant(encounter, id)!;
      one.routed = true;
      one.moraleChecked = ["hurt"];
    }
    state.rulesetFight = { encounter, events: [], eventSeq: 0, controllers: { hero: "manual" }, bosses: [] } as never;
    syncRulesetCombatants(morale, state);
    state.stage = rulesetDirectorStage(state);
    assert.ok(commandRulesetCombatDirector(morale, state, { type: "continue" }).ok);
    const after = state.rulesetFight!.encounter;
    assert.equal(rulesetCombatant(after, "near")!.routed, undefined, "the one near it stops running");
    assert.deepEqual(rulesetCombatant(after, "near")!.moraleChecked, [], "and checks again");
    assert.equal(rulesetCombatant(after, "far")!.routed, true, "one too far off runs on");
  }

  // ── Its temperament and role, unless the Game Master gave one ──
  {
    const scene = () =>
      fight({
        sly: {
          side: "enemy",
          block: block([bolt], { behavior: { temperament: "cautious", role: "marksman" } }),
          at: { x: 2, y: 2 },
        },
        hero: { side: "party", block: block([smash]), at: { x: 9, y: 2 } },
      });
    const own = scene();
    pickRulesetChoice(definition, own.state, own.encounter, "sly");
    assert.equal(own.state.enemies[0]!.tactics?.adjective, "cautious");
    assert.equal(own.state.enemies[0]!.tactics?.role, "marksman");
    const told = scene();
    told.state.enemies[0]!.aiHints = { proficiency: "master", temperament: "reckless" };
    pickRulesetChoice(definition, told.state, told.encounter, "sly");
    assert.notEqual(told.state.enemies[0]!.tactics?.adjective, "cautious", "the Game Master's word wins");
  }

  // ── Whom it goes for ──
  {
    // A frail fighter and a sturdy caster, both in range: left to itself it shoots the frail one.
    const scene = (behavior?: Record<string, unknown>) =>
      fight({
        archer: { side: "enemy", block: block([bolt], behavior ? { behavior } : {}), at: { x: 2, y: 4 } },
        fighter: { side: "party", block: block([smash], { health: 20 }), at: { x: 9, y: 3 } },
        mage: { side: "party", block: block([warding, bolt]), at: { x: 9, y: 6 } },
      });
    const shot = (behavior?: Record<string, unknown>, before?: (encounter: RulesetEncounterState) => void) => {
      const { encounter, state } = scene(behavior);
      state.enemies[0]!.tactics = {
        version: 1,
        seed: 0,
        category: "unknown",
        proficiency: "master",
        role: "marksman",
        adjective: "disciplined",
      };
      before?.(encounter);
      return pickRulesetChoice(definition, state, encounter, "archer")?.targetId;
    };
    assert.equal(shot(), "fighter", "the frail one, left to itself");
    assert.equal(shot({ targets: ["casters"] }), "mage", "a caster first");
    assert.equal(
      shot({ targets: ["attacker"] }, (encounter) => {
        rulesetCombatant(encounter, "archer")!.harmedBy = "mage";
      }),
      "mage",
      "whoever hurt it",
    );
    // A pack hunter goes for whoever its friend is already beside.
    const pack = fight({
      wolf: { side: "enemy", block: block([bolt], { behavior: { pack: true } }), at: { x: 2, y: 4 } },
      packmate: { side: "enemy", block: block([smash]), at: { x: 10, y: 6 } },
      fighter: { side: "party", block: block([smash], { health: 20 }), at: { x: 9, y: 3 } },
      mage: { side: "party", block: block([warding, bolt]), at: { x: 9, y: 6 } },
    });
    pack.state.enemies[0]!.tactics = {
      version: 1,
      seed: 0,
      category: "unknown",
      proficiency: "master",
      role: "skirmisher",
      adjective: "disciplined",
    };
    assert.equal(
      pickRulesetChoice(definition, pack.state, pack.encounter, "wolf")?.targetId,
      "mage",
      "the pack's prey",
    );
  }

  // ── Its opener, once ──
  {
    const { encounter, state } = fight({
      drake: { side: "enemy", block: block([smash, spark], { behavior: { opens: ["spark"] } }), at: { x: 5, y: 4 } },
      hero: { side: "party", block: block([smash]), at: { x: 6, y: 4 } },
    });
    state.enemies[0]!.tactics = {
      version: 1,
      seed: 0,
      category: "unknown",
      proficiency: "master",
      role: "bruiser",
      adjective: "disciplined",
    };
    assert.equal(pickRulesetChoice(definition, state, encounter, "drake")?.option.id, "spark", "it opens with it");
    assert.equal(state.enemies[0]!.tactics?.opened, true);
    assert.equal(pickRulesetChoice(definition, state, encounter, "drake")?.option.id, "smash", "and then fights");
  }

  // ── Lying in wait ──
  {
    const creaturesId = (definition.catalogs ?? []).find((catalog) => catalog.holds === "creatures")!.id;
    const bestiary = Object.fromEntries(
      (definition.catalogs ?? []).flatMap((catalog) =>
        catalog.holds === "creatures" && catalog.entries ? [[catalog.id, catalog.entries]] : [],
      ),
    );
    const hero = defaultRulesetSheetBuild(definition);
    hero.fields = { ...hero.fields, hp_max: 40 };
    const built = createRulesetFight({
      definition,
      seed: 3,
      positioned: true,
      party: [{ id: "ada", name: "Ada" }],
      enemies: [{ id: "lurker", name: "Lurker", creature: `${creaturesId}/thorn-lurker` }],
      cards: [{ name: "Ada", rulesetSheet: { v: 1, build: hero } }],
      playerName: null,
      live: {},
      items: () => [],
      partyCatalogs: {},
      bestiary,
    } as never);
    assert.ok(built.ok, built.ok ? "" : (built as { error: string }).error);
    const director = createCombatDirector({
      id: "fight",
      anchor: "anchor",
      style: "ruleset",
      party: [{ ...unit("ada", "player"), hp: 30, maxHp: 30 }],
      enemies: [{ ...unit("lurker", "enemy"), hp: 30, maxHp: 30 }],
      gm: false,
      difficulty: "normal",
      seed: 3,
    } as never);
    director.rulesetFight = (built as { fight: never }).fight;
    const encounter = director.rulesetFight!.encounter;
    const lurker = rulesetCombatant(encounter, "lurker")!;
    assert.equal(lurker.block?.behavior?.ambush, true, "the bestiary's behavior reaches the fight");
    const ada = rulesetCombatant(encounter, "ada")!;
    const grid = encounter.board!.grid!;
    assert.ok(grid.width >= 10, `a board wide enough to lie in wait on: ${grid.width}`);
    ada.x = 0;
    ada.y = 0;
    lurker.x = grid.width - 1;
    lurker.y = grid.height - 1;
    syncRulesetCombatants(definition, director);
    director.stage = rulesetDirectorStage(director);
    // Ada's own turns, played by nobody but the player; `walk` moves her first.
    const theirs: RulesetCombatEvent[] = [];
    const round = (walk?: { x: number; y: number }) => {
      for (let guard = 0; guard < 6 && !director.outcome; guard++) {
        const now = director.rulesetFight!.encounter;
        if (rulesetEncounterSummary(definition, now).outcome !== "ongoing") return;
        if (now.order[now.turn] === "ada") {
          if (walk) {
            const her = rulesetCombatant(now, "ada")!;
            her.x = walk.x;
            her.y = walk.y;
            walk = undefined;
          }
          const step = applyRulesetCombatChoice(
            definition,
            now,
            { actorId: "ada", optionId: "end-turn", targetIds: [] },
            () => 10,
          );
          theirs.push(...step.events);
          director.rulesetFight!.encounter = step.state;
          syncRulesetCombatants(definition, director);
          director.stage = rulesetDirectorStage(director);
          if (guard > 0) return;
          continue;
        }
        assert.ok(commandRulesetCombatDirector(definition, director, { type: "continue" }).ok);
      }
    };
    const where = () => {
      const one = rulesetCombatant(director.rulesetFight!.encounter, "lurker")!;
      return { x: one.x, y: one.y };
    };
    const start = where();
    round();
    round();
    assert.deepEqual(where(), start, "it keeps still while its prey is far off");
    const all = () => [...director.rulesetFight!.events.map((entry) => entry.event), ...theirs];
    assert.ok(
      !all().some(
        (event) =>
          (event.type === "attack" || event.type === "damage") && "actorId" in event && event.actorId === "lurker",
      ),
      "and strikes nobody",
    );
    // Ada walks up beside it: it springs.
    round({ x: start.x! - 1, y: start.y! });
    round();
    const sprung = director.enemies.find((one) => one.id === "lurker")!.tactics?.sprung;
    assert.equal(sprung, true, `it sprang: ${JSON.stringify(all().map((event) => event.type))}`);
  }

  // ── Refused ──
  refused(
    fiveE((doc) => (doc.combat.behavior = {})),
    /Say something about how it fights/,
  );
  refused(
    fiveE((doc) => (doc.combat.behavior = { targets: ["casters", "casters"] })),
    /Name each once/,
  );
  refused(
    fiveE((doc) => (doc.combat.behavior = { temperament: "mindless" })),
    /temperament/,
  );
  refused(
    fiveE((doc) => (doc.combat.behavior = { flees: true })),
    /flees|Unrecognized/,
  );
  refused(
    fiveE((doc) => (lurkerEntry(doc).behavior = { targets: ["the-tasty-one"] })),
    /targets/,
  );

  // ── The install gate ──
  {
    const gate =
      "A ruleset with how a creature goes about a fight (a behavior saying its temperament, role, targets, openers, pack or ambush) requires schemaVersion 2 and capabilityApi 1.710 or newer";
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
    const wolfish = fiveE((doc) => (lurkerEntry(doc).behavior = { pack: true }));
    assert.equal(getCapabilityPackageInstallIssue(manifest(709) as never, wolfish), gate, "a creature's own");
    assert.equal(
      getCapabilityPackageInstallIssue(
        manifest(709) as never,
        fiveE((doc) => (doc.combat.behavior = { targets: ["weakest"] })),
      ),
      gate,
      "the ruleset's",
    );
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(710) as never, wolfish), gate);
    assert.notEqual(
      getCapabilityPackageInstallIssue(manifest(709) as never, fiveE()),
      gate,
      "a condition's behavior is not one",
    );
    const solo =
      'A ruleset with a creature that fights a side alone (a behavior whose role is "solo") requires schemaVersion 2 and capabilityApi 1.723 or newer';
    const dragonish = fiveE((doc) => (lurkerEntry(doc).behavior = { role: "solo" }));
    assert.equal(getCapabilityPackageInstallIssue(manifest(722) as never, dragonish), solo);
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(723) as never, dragonish), solo);
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(722) as never, wolfish), solo);
    const guarding =
      "A ruleset with a bodyguard (a behavior's guards) requires schemaVersion 2 and capabilityApi 1.724 or newer";
    const guardish = fiveE((doc) => (lurkerEntry(doc).behavior = { guards: ["casters"] }));
    assert.equal(getCapabilityPackageInstallIssue(manifest(723) as never, guardish), guarding);
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(724) as never, guardish), guarding);
    refused(
      fiveE((doc) => (lurkerEntry(doc).behavior = { guards: ["casters", "casters"] })),
      /Name each once/,
    );
  }

  console.log(
    "Combat behavior: merged from the ruleset, the type and the creature; its temperament and role; casters, attackers and a pack's prey first; its opener once; an ambusher keeps still and springs; roles read off what it does; bodyguards stay by their charge; a leader rallies; refused and gated at 1.710, 1.723 and 1.724.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
