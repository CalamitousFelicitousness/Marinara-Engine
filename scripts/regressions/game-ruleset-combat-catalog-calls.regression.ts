/**
 * Creatures called by a catalog entry or an item use (Capability API 1.344).
 *
 *   - `mechanics.calls` with `options`: Conjure Animals, its user picking one wolf or two hounds as
 *     they cast it, each option a mode. They join on the caster's side, beside them.
 *   - Held by the entry's concentration: broken, they leave the fight.
 *   - With `rounds`: they leave as that many rounds pass, at their caller's turn.
 *   - A bestiary creature or a stat block may stand on the party's side from the start.
 *   - Refused shapes; the install gate.
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
  supportedCapabilityApi,
  type RulesetCatalogEntriesById,
  type RulesetCatalogEntry,
  type RulesetCombatChoice,
  type RulesetCombatEvent,
  type RulesetDefinition,
  type RulesetEncounterState,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-catalog-calls-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");

try {
  assert.ok(supportedCapabilityApi.minor >= 344);
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const wolf = {
    id: "dire-wolf",
    label: "Dire Wolf",
    filters: { challenge: "CR 1", kind: "Beast", places: ["Forest"] },
    creature: {
      health: 30,
      defense: 14,
      initiativeModifier: 0,
      speed: 50,
      tier: "cr_1",
      actions: [{ id: "maul", name: "Maul", budget: "action", toHit: 5, damage: { flat: 8 }, reach: 5 }],
    },
  };
  const conjure = (calls: Record<string, unknown>) => ({
    id: "conjure-animals",
    label: "Conjure Animals",
    rows: [{ list: "spells", values: { name: "Conjure Animals", level: 3, prepared: true } }],
    mechanics: { kind: "utility", targets: "self", budget: "action", concentration: true, calls },
  });
  const options = {
    options: [
      { creature: "creatures/dire-wolf", count: { flat: 1 } },
      { creature: "creatures/cinder-hound", count: { flat: 2 }, label: "Two cinder hounds" },
      { creature: "creatures/nobody", count: { flat: 4 } },
    ],
    initiative: "after",
    rounds: 10,
  };
  const document = (entries: unknown[], edit: (doc: Record<string, any>) => void = () => {}) => {
    const doc = JSON.parse(fiveEText);
    doc.catalogs.find((catalog: { holds?: string }) => catalog.holds === "creatures").entries.push(wolf);
    doc.catalogs.push({ id: "spells", label: "Spells", feeds: ["spells"], entries });
    edit(doc);
    return doc;
  };
  const parsed = (doc: unknown): RulesetDefinition => {
    const result = parseRulesetDefinition(doc);
    assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
    return result.definition;
  };
  const refused = (doc: unknown, pattern: RegExp) => {
    const result = parseRulesetDefinition(doc);
    assert.equal(result.ok, false, `should be refused: ${pattern}`);
    if (!result.ok)
      assert.ok(
        result.issues.some((issue) => pattern.test(issue)),
        result.issues.join("; "),
      );
  };
  let queued: number[] = [];
  const roll = (sides: number) => Math.min(sides, queued.shift() ?? 10);
  const of = <T extends RulesetCombatEvent["type"]>(events: RulesetCombatEvent[], type: T) =>
    events.filter((one): one is Extract<RulesetCombatEvent, { type: T }> => one.type === type);
  const fight = (definition: RulesetDefinition) => {
    const entries = definition.catalogs!.find((catalog) => catalog.id === "spells")!.entries! as RulesetCatalogEntry[];
    const bestiary: RulesetCatalogEntriesById = {
      creatures: definition.catalogs!.find((catalog) => catalog.holds === "creatures")!.entries!,
    };
    const state = createRulesetEncounter({
      definition,
      seed: 1,
      roller: roll,
      bestiary,
      combatants: [
        {
          id: "druid",
          name: "Druid",
          side: "party",
          build: rulesetSheetBuildSchema.parse({
            abilities: { str: 10, dex: 12, con: 10, int: 10, wis: 18, cha: 10 },
            fields: { level: 5, ac: 12, speed: 30, hp_max: 40 },
            lists: { spells: entries.flatMap((entry) => rowsFromCatalogEntry("spells", entry).map((row) => row.row)) },
          }),
          live: {},
          catalogs: { spells: entries },
        },
        {
          id: "brute",
          name: "Brute",
          side: "enemy",
          block: {
            health: 100,
            defense: 10,
            initiativeModifier: 0,
            speed: 30,
            actions: [
              {
                id: "smash",
                label: "Smash",
                kind: "attack",
                budget: "action",
                toHit: 30,
                damage: { flat: 30, type: "bludgeoning" },
              },
            ],
          },
        },
      ],
      board: {
        grid: { width: 10, height: 3, tiles: Array.from({ length: 3 }, () => Array(10).fill("plains")) },
        placements: { druid: { x: 3, y: 1 }, brute: { x: 4, y: 1 } },
      },
    });
    state.order = ["druid", "brute"];
    state.turn = 0;
    return state;
  };
  const who = (state: RulesetEncounterState, id: string) => rulesetCombatant(state, id)!;
  const step = (definition: RulesetDefinition, state: RulesetEncounterState, choice: RulesetCombatChoice) => {
    const taken = applyRulesetCombatChoice(definition, state, choice, roll);
    assert.deepEqual(of(taken.events, "refused"), [], JSON.stringify(taken.events));
    return taken;
  };
  const cast = (definition: RulesetDefinition, state: RulesetEncounterState, mode?: string) => {
    const option = rulesetCombatOptions(definition, state, "druid").find((one) => one.label === "Conjure Animals");
    assert.ok(
      option,
      rulesetCombatOptions(definition, state, "druid")
        .map((one) => one.label)
        .join(", "),
    );
    return {
      option,
      taken: step(definition, state, {
        actorId: "druid",
        optionId: option.id,
        targetIds: option.targets.count === 0 ? [] : ["druid"],
        ...(mode ? { mode } : {}),
      }),
    };
  };

  // ── Conjure Animals: picked among its options ──
  const definition = parsed(document([conjure(options)]));
  {
    const { option, taken } = cast(definition, fight(definition), "call-1");
    assert.deepEqual(
      option.modes?.map((one) => [one.id, one.label]),
      [
        ["call-0", "Dire Wolf ×1"],
        ["call-1", "Two cinder hounds"],
      ],
      "an option nobody can find is not offered",
    );
    const [called] = of(taken.events, "called");
    assert.deepEqual(called?.ids, ["called-1", "called-2"]);
    const state = taken.state;
    for (const id of called!.ids) {
      const hound = who(state, id);
      assert.equal(hound.side, "party", "on the caster's side");
      assert.equal(hound.calledBy, "druid");
      assert.deepEqual(hound.creature, { catalogId: "creatures", entryId: "cinder-hound" });
      assert.equal(hound.calledUntil, 11);
    }
    assert.deepEqual(state.order, ["druid", "called-1", "called-2", "brute"], "right after the druid");
    assert.equal(who(state, "druid").concentrating?.label, "Conjure Animals (Two cinder hounds)");

    // Concentration broken: a blow on the druid and a failed save.
    const hit = structuredClone(state);
    hit.turn = hit.order.indexOf("brute");
    who(hit, "brute").budgets.action = 1;
    queued = [10, 1];
    const broken = step(definition, hit, { actorId: "brute", optionId: "smash", targetIds: ["druid"] });
    queued = [];
    const [gone] = of(broken.events, "sentAway");
    assert.deepEqual(gone, {
      type: "sentAway",
      actorId: "druid",
      ids: ["called-1", "called-2"],
      reason: "concentration",
    });
    for (const id of gone!.ids) {
      const hound = who(broken.state, id);
      assert.ok(hound.dismissed && hound.defeated, "out of the fight");
      assert.equal(hound.x, undefined, "and off the board");
    }

    // Kept, they leave as the tenth round after comes round to the druid.
    let later = structuredClone(state);
    later.round = 10;
    later.turn = later.order.indexOf("brute");
    later = step(definition, later, { actorId: "brute", optionId: "end-turn", targetIds: [] }).state;
    const next = applyRulesetCombatChoice(
      definition,
      structuredClone(later),
      { actorId: "druid", optionId: "end-turn", targetIds: [] },
      roll,
    );
    assert.equal(of(next.events, "sentAway").length, 0, "not yet in round 10");
    let round = structuredClone(state);
    round.round = 10;
    round.turn = round.order.indexOf("brute");
    who(round, "brute").budgets.action = 1;
    const turned = step(definition, round, { actorId: "brute", optionId: "end-turn", targetIds: [] });
    assert.equal(turned.state.round, 11);
    assert.equal(turned.state.order[turned.state.turn], "druid");
    assert.deepEqual(of(turned.events, "sentAway")[0]?.ids, ["called-1", "called-2"]);
    assert.equal(of(turned.events, "sentAway")[0]?.reason, "rounds");
  }

  // ── One creature, no choosing ──
  {
    const one = parsed(document([conjure({ creature: "creatures/dire-wolf", count: { dice: "1d4" } })]));
    const { option, taken } = cast(one, fight(one));
    assert.equal(option.modes, undefined);
    assert.equal(of(taken.events, "called")[0]?.ids.length, 4, "a d4 thrown at its most");
  }

  // ── A bestiary creature or a stat block beside the party, built as an opponent is ──
  {
    const allied = createRulesetEncounter({
      definition,
      seed: 1,
      roller: roll,
      bestiary: { creatures: definition.catalogs!.find((catalog) => catalog.holds === "creatures")!.entries! },
      combatants: [
        { id: "wolf", name: "Wolf", side: "party", creature: { catalogId: "creatures", entryId: "dire-wolf" } },
        {
          id: "post",
          name: "Post",
          side: "party",
          block: { health: 9, defense: 10, initiativeModifier: 0, speed: 0, actions: [] },
        },
      ],
    });
    assert.deepEqual(
      allied.combatants.map((one) => [one.id, one.side, one.health?.max, one.sheet === undefined]),
      [
        ["wolf", "party", 30, true],
        ["post", "party", 9, true],
      ],
    );
    // Felled, such an ally is out of the fight, not dying as a character would be.
    const felled = createRulesetEncounter({
      definition,
      seed: 1,
      roller: roll,
      combatants: [
        {
          id: "post",
          name: "Post",
          side: "party",
          block: { health: 9, defense: 10, initiativeModifier: 0, speed: 0, actions: [] },
        },
        {
          id: "ogre",
          name: "Ogre",
          side: "enemy",
          block: {
            health: 50,
            defense: 10,
            initiativeModifier: 0,
            speed: 30,
            actions: [{ name: "Club", budget: "action", toHit: 30, damage: { count: 0, sides: 0, flat: 20 } }],
          },
        },
      ],
    });
    felled.order = ["ogre", "post"];
    felled.turn = 0;
    const clubbed = step(definition, felled, {
      actorId: "ogre",
      optionId: who(felled, "ogre").actions[0]!.id,
      targetIds: ["post"],
    });
    assert.equal(who(clubbed.state, "post").defeated, true);
    assert.ok(!who(clubbed.state, "post").dying, "never dying");
    assert.equal(of(clubbed.events, "defeated").length, 1);
  }

  // ── Refused shapes ──
  {
    refused(document([conjure({ creature: "creatures/dire-wolf" })]), /says its "count"/);
    refused(document([conjure({ count: { flat: 1 } })]), /one "creature" or a list of "options"/);
    refused(
      document([conjure({ creature: "creatures/dire-wolf", count: { flat: 1 }, options: options.options })]),
      /one "creature" or a list of "options"/,
    );
    refused(document([conjure({ ...options, count: { flat: 2 } })]), /its own "count"/);
    refused(document([conjure({ creature: "dire-wolf", count: { flat: 1 } })]), /<catalogId>\/<entryId>/);
    refused(document([conjure({ creature: "creatures/dire-wolf", count: { flat: 0 } })]), /at least one creature/);
  }

  // ── The install gate ──
  {
    const gate =
      "A ruleset with a catalog entry or an item use that calls creatures into the fight requires schemaVersion 2 and capabilityApi 1.344 or newer";
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
    const caller = document([conjure(options)]);
    assert.equal(getCapabilityPackageInstallIssue(manifest(343) as never, caller), gate);
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(344) as never, caller), gate);
    // A creature's own call is 1.325's, not this.
    const creatureCall = JSON.parse(fiveEText);
    creatureCall.catalogs
      .find((catalog: { holds?: string }) => catalog.holds === "creatures")
      .entries[0].creature.actions.push({
        id: "howl",
        name: "Howl",
        budget: "action",
        calls: { creature: "creatures/cinder-hound", count: { flat: 1 } },
      });
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(343) as never, creatureCall), gate);
  }

  console.log(
    "Catalog calls: Conjure Animals' two hounds on the druid's side right after them, gone with its concentration or as its ten rounds pass; one creature by its count; refusals; gated at 1.344.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
