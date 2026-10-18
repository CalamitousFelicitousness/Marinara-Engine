/**
 * A condition that lifts its holder (Capability API 1.513): 5e's Reverse Gravity.
 *
 *   - `lifts`: whoever holds it is up that far above the ground under them, in levels, and hovers
 *     there; a lasting area's `inside.conditions` puts it on everyone it catches.
 *   - When it comes off, they come down.
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
  rowsFromCatalogEntry,
  rulesetCombatant,
  rulesetCombatOptions,
  rulesetSheetBuildSchema,
  supportedCapabilityApi,
  type RulesetCatalogEntry,
  type RulesetCombatEvent,
  type RulesetDefinition,
  type RulesetStatBlock,
  type TacticalGrid,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-reverse-gravity-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");

try {
  assert.ok(supportedCapabilityApi.minor >= 513);
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const document = () => {
    const doc = JSON.parse(fiveEText) as Record<string, any>;
    doc.sheet.live.conditions.push({ id: "reverse_gravity", label: "Fallen upward" });
    doc.combat.conditions.push({ condition: "reverse_gravity", effects: [], lifts: 100 });
    doc.catalogs.push({
      id: "spells",
      label: "Spells",
      feeds: ["spells"],
      entries: [
        {
          id: "reverse-gravity",
          label: "Reverse Gravity",
          rows: [{ list: "spells", values: { name: "Reverse Gravity", level: 7, prepared: true } }],
          mechanics: {
            kind: "utility",
            area: { shape: "burst", size: 10 },
            range: 100,
            zone: { rounds: 10, triggers: [], inside: { conditions: ["reverse_gravity"] } },
          },
        },
      ],
    });
    return doc;
  };
  const parsed = (doc: unknown): RulesetDefinition => {
    const result = parseRulesetDefinition(doc);
    assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
    return result.definition;
  };
  const of = <T extends RulesetCombatEvent["type"]>(events: RulesetCombatEvent[], type: T) =>
    events.filter((one): one is Extract<RulesetCombatEvent, { type: T }> => one.type === type);
  const definition = parsed(document());
  const entries = definition.catalogs!.find((catalog) => catalog.id === "spells")!.entries! as RulesetCatalogEntry[];
  const grid: TacticalGrid = {
    width: 30,
    height: 15,
    tiles: Array.from({ length: 15 }, () => Array.from({ length: 30 }, () => "plains")),
  };
  const ogre = {
    health: 59,
    defense: 11,
    initiativeModifier: 0,
    speed: 40,
    actions: [],
  } as unknown as RulesetStatBlock;
  const state = createRulesetEncounter({
    definition,
    seed: 1,
    roller: () => 10,
    combatants: [
      {
        id: "wizard",
        name: "Wizard",
        side: "party",
        build: rulesetSheetBuildSchema.parse({
          abilities: { str: 8, dex: 14, con: 12, int: 18, wis: 10, cha: 10 },
          fields: { level: 13, ac: 12, speed: 30, hp_max: 70, spellcasting_ability: "int", slots_max_7: 1 },
          lists: { spells: entries.flatMap((one) => rowsFromCatalogEntry("spells", one).map((row) => row.row)) },
        }),
        live: {},
        catalogs: { spells: entries },
      },
      { id: "ogre", name: "Ogre", side: "enemy", block: ogre },
    ],
    board: { grid, placements: { wizard: { x: 2, y: 7 }, ogre: { x: 14, y: 7 } } },
  });
  state.order = ["wizard", "ogre"];
  state.turn = 0;

  // ── Cast on the ogre: it falls 100 feet upward, twenty levels, and hangs there ──
  const option = rulesetCombatOptions(definition, state, "wizard").find((one) => one.label === "Reverse Gravity")!;
  const cast = applyRulesetCombatChoice(
    definition,
    state,
    { actorId: "wizard", optionId: option.id, targetIds: [], at: { x: 14, y: 7 } },
    () => 10,
  );
  assert.deepEqual(of(cast.events, "refused"), []);
  const lifted = rulesetCombatant(cast.state, "ogre")!;
  assert.equal(lifted.altitude, 20);
  assert.deepEqual(
    of(cast.events, "lifted").map((one) => [one.targetId, one.from, one.to]),
    [["ogre", 0, 20]],
  );
  assert.equal(rulesetCombatant(cast.state, "wizard")!.altitude, undefined, "the wizard stood outside it");

  // ── The area gone: the ogre comes down ──
  const after = structuredClone(cast.state);
  for (const one of after.combatants) delete one.zones;
  const ended = applyRulesetCombatChoice(
    definition,
    after,
    {
      actorId: "wizard",
      optionId: rulesetCombatOptions(definition, after, "wizard").find((one) => one.kind === "end-turn")!.id,
      targetIds: [],
    },
    () => 10,
  );
  assert.deepEqual(of(ended.events, "refused"), []);
  assert.equal(rulesetCombatant(ended.state, "ogre")!.altitude, undefined);

  // ── The install gate ──
  {
    const gate =
      "A ruleset with a condition that lifts its holder into the air (lifts) requires schemaVersion 2 and capabilityApi 1.513 or newer";
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
    assert.equal(getCapabilityPackageInstallIssue(manifest(512) as never, document()), gate);
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(513) as never, document()), gate);
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(512) as never, JSON.parse(fiveEText)), gate);
  }

  console.log(
    "Reverse Gravity: everyone inside the area falls 100 feet upward and hangs there, and comes down when it goes; gated at 1.513.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
