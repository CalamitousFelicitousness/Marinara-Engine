/**
 * What the class re-test found the AI still never did, or did wrong (cloud class re-test 2026-10-24).
 *
 *   - A burst that turns only one kind of creature (Turn the Unholy) is weighed by those it may take,
 *     not the friends it is read out around, and the turns it takes from them count as a hold's do.
 *   - A heal paid in as many uses as its user chooses (Lay on Hands) is weighed at the uses that heal
 *     its target, not at one.
 *   - A dodge an ability grants on another budget (Patient Defense) is taken by a hurt one beside its
 *     foes once its action is spent; never by a whole one.
 *   - Twinned: a cantrip sent at two foes for a point, both struck.
 *   - A self-buff whose condition leaves a level of a track as it ends (Frenzy's exhaustion) costs more
 *     than the same one without.
 *   - An area that lowers its holders' defense is never cast over its own side as support (Slow).
 *   - A summons held is not let go for a lesser held spell.
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
  rowsFromCatalogEntry,
  rulesetCombatant,
  rulesetCombatOptions,
  rulesetSheetBuildSchema,
  type RulesetCatalogEntry,
  type RulesetCombatAction,
  type RulesetCombatantInput,
  type RulesetDefinition,
  type RulesetEncounterState,
  type RulesetStatBlock,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-ai-class-retest-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { createCombatDirector } = await import("../../packages/server/src/services/game/combat-director.service.js");
const { commandRulesetCombatDirector, pickRulesetChoice, rankRulesetChoices } =
  await import("../../packages/server/src/services/game/ruleset-combat-director.service.js");

try {
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const features = [
    {
      id: "lay-on-hands",
      label: "Lay on Hands",
      rows: [
        { list: "features", values: { name: "Lay on Hands" } },
        { list: "counters", values: { name: "Lay on Hands", max: 25, recharge: "long" } },
      ],
      mechanics: { kind: "heal", targets: "ally", range: 0, amount: { flat: 1 }, usesOf: "Lay on Hands", usesChosen: true },
    },
    {
      id: "ki",
      label: "Ki",
      rows: [
        { list: "features", values: { name: "Ki" } },
        { list: "counters", values: { name: "Ki", max: 4, recharge: "short" } },
      ],
      mechanics: { kind: "utility", usesOf: "Ki", standard: { actions: ["dodge"], budget: "bonus" } },
    },
    {
      id: "points",
      label: "Font of Magic",
      rows: [
        { list: "features", values: { name: "Font of Magic" } },
        { list: "counters", values: { name: "Sorcery Points", max: 5, recharge: "long" } },
      ],
    },
    {
      id: "twinned",
      label: "Twinned Spell",
      rows: [{ list: "features", values: { name: "Twinned Spell" } }],
      mechanics: { kind: "utility", usesOf: "Sorcery Points", usesSpentByLevel: true, alters: { catalogs: ["spells"], twins: true } },
    },
  ] as unknown as RulesetCatalogEntry[];
  const spells = [
    {
      id: "firebolt",
      label: "Firebolt",
      rows: [{ list: "spells", values: { name: "Firebolt", level: 0, prepared: true } }],
      mechanics: { kind: "attack", autoHit: true, damageType: "fire", range: 120, amount: { dice: "2d10" } },
    },
  ] as unknown as RulesetCatalogEntry[];
  const doc = JSON.parse(fiveEText) as Record<string, any>;
  Object.assign(
    doc.combat.abilities.find((one: { list: string }) => one.list === "features"),
    { saveDifficulty: { derived: "spell_save_dc" }, toHit: { derived: "spell_attack" } },
  );
  doc.catalogs.push(
    { id: "classes", label: "Classes", feeds: ["features", "counters"], entries: features },
    { id: "spells", label: "Spells", feeds: ["spells"], entries: spells },
  );
  doc.combat.creatureTypes = {
    types: ["humanoid", "undead"].map((id) => ({ id, label: id })),
    default: "humanoid",
  };
  // Turned: nothing but walking away, ended by any harm; slowed: a defense lowered; frenzied: a level
  // of exhaustion as it ends.
  doc.sheet.live.conditions.push(
    { id: "turned", label: "Turned" },
    { id: "slowed", label: "Slowed" },
    { id: "warded", label: "Warded" },
    { id: "frenzied", label: "Frenzied" },
    { id: "fierce", label: "Fierce" },
  );
  doc.combat.conditions.push(
    { condition: "turned", effects: ["cannot-react"], behavior: { only: ["move", "dash"], moves: "away" }, endsWhen: ["damaged"] },
    { condition: "slowed", effects: [], modifiers: [{ to: "defense", flat: -2 }] },
    { condition: "warded", effects: [], modifiers: [{ to: "defense", flat: 1 }] },
    {
      condition: "frenzied",
      effects: [],
      modifiers: [{ to: "damage", flat: 4 }],
      onEnd: { tracks: [{ track: "exhaustion", by: 1 }] },
    },
    { condition: "fierce", effects: [], modifiers: [{ to: "damage", flat: 4 }] },
  );
  const parsed = parseRulesetDefinition(doc);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.issues.join("; "));
  const definition: RulesetDefinition = parsed.definition;

  const block = (actions: unknown[], extra: Record<string, unknown> = {}): RulesetStatBlock =>
    ({
      health: 60,
      defense: 12,
      initiativeModifier: 0,
      speed: 30,
      size: "medium",
      abilities: { str: 10, dex: 10, con: 10, int: 12, wis: 10, cha: 10 },
      saves: { wis_save: -10, con_save: -10 },
      actions,
      ...extra,
    }) as unknown as RulesetStatBlock;
  const smash = { id: "smash", name: "Smash", budget: "action", toHit: 6, reach: 5, damage: { count: 2, sides: 8, flat: 4 } };
  const poke = { id: "poke", name: "Poke", budget: "action", toHit: 4, reach: 5, damage: { count: 1, sides: 4, flat: 0 } };
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
  const rows = (list: string) =>
    features.flatMap((entry) =>
      rowsFromCatalogEntry("classes", entry).flatMap((one) => (one.list === list ? [one.row] : [])),
    );
  const sheet = (fields: Record<string, unknown>, extra: { spells?: boolean } = {}) =>
    rulesetSheetBuildSchema.parse({
      abilities: { str: 14, dex: 14, con: 14, int: 10, wis: 12, cha: 16 },
      fields: { level: 5, ac: 15, speed: 30, hp_max: 40, spellcasting_ability: "cha", ...fields },
      lists: {
        attacks: [],
        features: rows("features"),
        counters: rows("counters"),
        ...(extra.spells
          ? { spells: spells.flatMap((entry) => rowsFromCatalogEntry("spells", entry).map((one) => one.row)) }
          : {}),
      },
    });
  type Placed = RulesetCombatantInput & { at: { x: number; y: number } };
  const fight = (placed: Placed[], controllers: Record<string, string> = {}) => {
    const encounter: RulesetEncounterState = createRulesetEncounter({
      definition,
      seed: 1,
      roller: () => 10,
      combatants: placed.map(({ at: _at, ...one }) => one),
      board: {
        grid: { width: 16, height: 10, tiles: Array.from({ length: 10 }, () => Array(16).fill("plains")) },
        placements: Object.fromEntries(placed.map((one) => [one.id, one.at])),
      } as never,
    });
    encounter.order = placed.map((one) => one.id);
    encounter.turn = 0;
    const state = createCombatDirector({
      id: "fight",
      anchor: "anchor",
      style: "ruleset",
      party: placed.filter((one) => one.side === "party").map((one) => unit(one.id, "player")),
      enemies: placed.filter((one) => one.side === "enemy").map((one) => unit(one.id, "enemy")),
      gm: false,
      difficulty: "normal",
      seed: 3,
    } as never);
    state.rulesetFight = { encounter, events: [], eventSeq: 0, controllers, bosses: [], adjustments: [] } as never;
    return { encounter, state };
  };
  const ranked = (scene: ReturnType<typeof fight>, actorId: string) =>
    rankRulesetChoices(definition, scene.state, scene.encounter, actorId, 400);
  const sheetOf = (id: string, build: ReturnType<typeof sheet>, at: { x: number; y: number }, hp?: number): Placed => ({
    id,
    name: id,
    side: "party",
    build,
    live: hp === undefined ? {} : { pools: { hp: { value: hp } } },
    catalogs: { classes: features, spells },
    at,
  });

  // ── Turning only the undead, around its maker and its friends ──
  {
    const turn = {
      id: "turn",
      name: "Turn",
      budget: "action",
      targets: "any",
      area: { shape: "burst", size: 6 },
      targetTypes: { is: { types: ["undead"] } },
      save: { save: "wis_save", difficulty: 15 },
      saveDifficulty: 15,
      applies: [{ condition: "turned", duration: { rounds: 10 } }],
    };
    const dead = (id: string, at: { x: number; y: number }): Placed => ({
      id,
      name: id,
      side: "enemy",
      block: block([smash], { type: "undead", health: 22 }),
      at,
    });
    const scene = fight([
      { id: "mira", name: "mira", side: "party", block: block([poke, turn]), at: { x: 2, y: 5 } },
      { id: "ada", name: "ada", side: "party", block: block([smash]), at: { x: 2, y: 4 } },
      dead("z1", { x: 3, y: 5 }),
      dead("z2", { x: 3, y: 4 }),
      dead("z3", { x: 4, y: 6 }),
    ]);
    const choice = pickRulesetChoice(definition, scene.state, scene.encounter, "mira");
    assert.equal(choice?.option.id, "turn", `three undead turned beat a poke: ${choice?.option.id}`);
    assert.ok((choice?.denies ?? 0) > 0, "worth the blows it keeps off");
  }

  // ── Healing in as many uses as heal them ──
  {
    const scene = fight(
      [
        sheetOf("pal", sheet({ level: 5 }), { x: 2, y: 5 }),
        sheetOf("ada", sheet({ level: 5 }), { x: 3, y: 5 }, 6),
        { id: "orc", name: "orc", side: "enemy", block: block([smash]), at: { x: 12, y: 5 } },
      ],
      { ada: "manual" },
    );
    const hands = ranked(scene, "pal").find((one) => one.candidate.action.option.label === "Lay on Hands");
    assert.ok(hands, "on offer to a friend at 6 of 40");
    assert.ok((hands.candidate.healing ?? 0) > 0.5, `weighed at the points that heal her: ${hands.candidate.healing}`);
  }

  // ── A granted dodge, hurt and beside its foes with its action spent ──
  {
    const scene = (hp: number) => {
      const made = fight([
        sheetOf("mei", sheet({ level: 5 }), { x: 4, y: 5 }, hp),
        { id: "o1", name: "o1", side: "enemy", block: block([smash]), at: { x: 5, y: 5 } },
        { id: "o2", name: "o2", side: "enemy", block: block([smash]), at: { x: 5, y: 4 } },
      ]);
      rulesetCombatant(made.encounter, "mei")!.budgets.action = 0;
      return made;
    };
    const low = scene(8);
    const dodged = pickRulesetChoice(definition, low.state, low.encounter, "mei");
    assert.equal(dodged?.option.id, "standard:dodge@bonus", `hurt, it dodges: ${dodged?.option.id}`);
    const whole = scene(40);
    assert.notEqual(
      pickRulesetChoice(definition, whole.state, whole.encounter, "mei")?.option.id,
      "standard:dodge@bonus",
      "whole, it does not",
    );
  }

  // ── Twinned: one point, two foes ──
  {
    const scene = fight(
      [
        sheetOf("sera", sheet({ level: 5 }, { spells: true }), { x: 1, y: 5 }),
        { id: "o1", name: "o1", side: "enemy", block: block([smash], { health: 30 }), at: { x: 9, y: 4 } },
        { id: "o2", name: "o2", side: "enemy", block: block([smash], { health: 30 }), at: { x: 9, y: 6 } },
      ],
      { sera: "ai" },
    );
    const choice = pickRulesetChoice(definition, scene.state, scene.encounter, "sera");
    assert.equal(choice?.option.label, "Firebolt");
    assert.equal(choice?.choice.alters?.length, 1, `twinned: ${JSON.stringify(choice?.choice)}`);
    assert.deepEqual([...(choice?.choice.targetIds ?? [])].sort(), ["o1", "o2"]);
    assert.ok(commandRulesetCombatDirector(definition, scene.state, { type: "continue" }).ok);
    const struck = scene.state
      .rulesetFight!.events.map((entry) => entry.event as { type: string; sourceId?: string; targetId?: string })
      .filter((event) => event.type === "damage" && event.sourceId === "sera")
      .map((event) => event.targetId)
      .sort();
    assert.deepEqual(struck, ["o1", "o2"], "both struck");
  }

  // ── A self-buff that leaves exhaustion behind costs more than one that does not ──
  {
    const buff = (id: string, condition: string) => ({
      id,
      name: id,
      budget: "bonus",
      self: true,
      applies: [{ condition, duration: { rounds: 10 } }],
    });
    const scene = fight([
      {
        id: "brak",
        name: "brak",
        side: "party",
        block: block([smash, buff("frenzy", "frenzied"), buff("fury", "fierce")]),
        at: { x: 4, y: 5 },
      },
      { id: "o1", name: "o1", side: "enemy", block: block([smash]), at: { x: 5, y: 5 } },
    ]);
    const cost = (id: string) =>
      ranked(scene, "brak").find((one) => one.candidate.action.option.id === id)?.candidate.cost ?? 0;
    assert.ok(cost("frenzy") > cost("fury") + 0.4, `exhaustion is a price: ${cost("frenzy")} vs ${cost("fury")}`);
  }

  // ── A defense lowered is no support for its own side ──
  {
    const slow = {
      id: "slow",
      name: "Slow",
      budget: "action",
      range: { normal: 60 },
      targets: "enemy",
      area: { shape: "burst", size: 2 },
      save: { save: "wis_save", difficulty: 15 },
      saveDifficulty: 15,
      applies: [{ condition: "slowed", duration: { rounds: 10 } }],
    };
    const scene = fight([
      { id: "mira", name: "mira", side: "party", block: block([poke, slow]), at: { x: 2, y: 5 } },
      { id: "ada", name: "ada", side: "party", block: block([smash]), at: { x: 4, y: 5 } },
      { id: "bo", name: "bo", side: "party", block: block([smash]), at: { x: 4, y: 6 } },
      { id: "orc", name: "orc", side: "enemy", block: block([smash]), at: { x: 15, y: 0 } },
    ]);
    const support = ranked(scene, "mira").filter(
      (one) => one.candidate.action.option.id === "slow" && (one.candidate.support ?? 0) > 0,
    );
    assert.equal(support.length, 0, "never weighed as support over the party");
  }

  // ── A summons held, not let go for a lesser held spell ──
  {
    const call = {
      id: "call",
      label: "Call",
      kind: "utility",
      budget: "action",
      concentration: true,
      targets: { side: "self", count: 0 },
      calls: {
        block: block([{ id: "bite", name: "Bite", budget: "action", toHit: 6, reach: 5, damage: { count: 0, sides: 0, flat: 7 } }], {
          health: 15,
        }),
        name: "Wolf",
        creature: { catalogId: "creatures", entryId: "wolf" },
        count: { count: 0, sides: 0, flat: 4 },
        rounds: 10,
      },
    } as unknown as RulesetCombatAction;
    const ward = {
      id: "ward",
      label: "Ward",
      kind: "ability",
      budget: "action",
      concentration: true,
      targets: { side: "ally", count: 1 },
      applies: [{ condition: "warded", duration: { rounds: 10 } }],
    } as unknown as RulesetCombatAction;
    const scene = fight([
      { id: "mira", name: "mira", side: "party", block: block([poke]), at: { x: 2, y: 5 } },
      { id: "ada", name: "ada", side: "party", block: block([smash]), at: { x: 3, y: 5 } },
      { id: "orc", name: "orc", side: "enemy", block: block([smash], { health: 60 }), at: { x: 9, y: 5 } },
    ]);
    const mira = rulesetCombatant(scene.encounter, "mira")!;
    mira.actions.push(call, ward);
    const called = applyRulesetCombatChoice(
      definition,
      scene.encounter,
      { actorId: "mira", optionId: "call", targetIds: [] },
      () => 10,
    );
    assert.ok(!called.refused, JSON.stringify(called.refused));
    const next = called.state;
    assert.equal(next.combatants.filter((one) => one.calledBy === "mira").length, 4, "four wolves");
    rulesetCombatant(next, "mira")!.budgets.action = 1;
    (scene.state.rulesetFight as { encounter: RulesetEncounterState }).encounter = next;
    const choice = pickRulesetChoice(definition, scene.state, next, "mira");
    assert.notEqual(choice?.option.id, "ward", "the wolves are kept");
    assert.ok(rulesetCombatOptions(definition, next, "mira").some((one) => one.id === "ward"), "the ward was on offer");
  }

  console.info(
    "AI class re-test: turning by kind, chosen-use heals, granted dodges, twinned, exhaustion priced, no Slow as support, held summons kept.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
