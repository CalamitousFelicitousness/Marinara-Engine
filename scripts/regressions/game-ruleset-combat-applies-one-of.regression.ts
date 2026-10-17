/**
 * Putting on one of an entry's applies, picked as it is used (Capability API 1.395).
 *
 *   - Primeval Awareness: its one mile, or six in favored terrain, offered as modes; the one picked
 *     is put on alone, and with none picked the first.
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
  rowsFromCatalogEntry,
  rulesetCombatant,
  rulesetCombatOptions,
  rulesetSheetBuildSchema,
  supportedCapabilityApi,
  type RulesetCatalogEntry,
  type RulesetCombatEvent,
  type RulesetDefinition,
} from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-applies-one-of-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");

try {
  assert.ok(supportedCapabilityApi.minor >= 395);
  const fiveEText = readFileSync(
    fileURLToPath(new URL("../../docs/development/ruleset-5e-2014.example.json", import.meta.url)),
    "utf8",
  );
  const awareness = (more: Record<string, unknown>) => ({
    id: "primeval-awareness",
    label: "Primeval Awareness",
    rows: [{ list: "spells", values: { name: "Primeval Awareness", level: 1, prepared: true } }],
    mechanics: {
      kind: "buff",
      targets: "self",
      budget: "action",
      cost: [{ pool: "slots_1", amount: 1 }],
      appliesOneOf: true,
      applies: [
        { condition: "primeval", duration: { rounds: 10 } },
        { condition: "primeval_far", duration: { rounds: 10 } },
      ],
      ...more,
    },
  });
  const fiveE = (more: Record<string, unknown> = {}): Record<string, any> => {
    const doc = JSON.parse(fiveEText) as Record<string, any>;
    doc.sheet.live.conditions.push(
      { id: "primeval", label: "One mile" },
      { id: "primeval_far", label: "Six miles (favored terrain)" },
    );
    doc.combat.conditions.push({ condition: "primeval", effects: [] }, { condition: "primeval_far", effects: [] });
    doc.catalogs.push({ id: "ranger", label: "Ranger", feeds: ["spells"], entries: [awareness(more)] });
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
  const of = <T extends RulesetCombatEvent["type"]>(events: RulesetCombatEvent[], type: T) =>
    events.filter((one): one is Extract<RulesetCombatEvent, { type: T }> => one.type === type);
  const holds = (definition: RulesetDefinition, mode: string | undefined) => {
    const entries = definition.catalogs!.find((catalog) => catalog.id === "ranger")!.entries! as RulesetCatalogEntry[];
    const state = createRulesetEncounter({
      definition,
      seed: 1,
      roller: () => 10,
      combatants: [
        {
          id: "ranger",
          name: "Ranger",
          side: "party",
          build: rulesetSheetBuildSchema.parse({
            abilities: { str: 12, dex: 16, con: 14, int: 10, wis: 14, cha: 8 },
            fields: {
              level: 9,
              ac: 15,
              speed: 30,
              hp_max: 70,
              spellcasting_ability: "wis",
              slots_max_1: 4,
              slots_max_2: 3,
              slots_max_3: 2,
            },
            lists: { spells: entries.flatMap((entry) => rowsFromCatalogEntry("ranger", entry).map((one) => one.row)) },
          }),
          live: {},
          catalogs: { ranger: entries },
        },
        {
          id: "wolf",
          name: "Wolf",
          side: "enemy",
          block: { health: 11, defense: 13, initiativeModifier: 0, speed: 40, actions: [] } as never,
        },
      ],
    });
    state.order = ["ranger", "wolf"];
    state.turn = 0;
    const option = rulesetCombatOptions(definition, state, "ranger").find((one) => one.label === "Primeval Awareness");
    assert.ok(
      option,
      rulesetCombatOptions(definition, state, "ranger")
        .map((one) => one.label)
        .join(", "),
    );
    assert.deepEqual(
      option.modes?.map((one) => [one.id, one.label]),
      [
        ["applies-0", "One mile"],
        ["applies-1", "Six miles (favored terrain)"],
      ],
    );
    const step = applyRulesetCombatChoice(
      definition,
      state,
      { actorId: "ranger", optionId: option.id, targetIds: ["ranger"], ...(mode ? { mode } : {}) },
      () => 10,
    );
    assert.deepEqual(of(step.events, "refused"), [], JSON.stringify(of(step.events, "refused")));
    return rulesetCombatant(step.state, "ranger")!
      .tracked.map((one) => one.condition)
      .filter((one) => one.startsWith("primeval"));
  };

  // ── Primeval Awareness ──
  {
    const definition = parsed(fiveE());
    assert.deepEqual(holds(definition, "applies-1"), ["primeval_far"], "six miles, alone");
    assert.deepEqual(holds(definition, "applies-0"), ["primeval"]);
    assert.deepEqual(holds(definition, undefined), ["primeval"], "none picked: the first");
  }

  // ── Refusals ──
  refused(fiveE({ applies: [{ condition: "primeval", duration: { rounds: 10 } }] }), /at least two/);
  refused(fiveE({ cureOneOf: true, ends: { conditions: ["charmed", "frightened"], count: 1 } }), /goes without/);

  // ── The install gate ──
  {
    const gate =
      "A ruleset whose entries put on one of their applies, picked as they are used (appliesOneOf), requires schemaVersion 2 and capabilityApi 1.395 or newer";
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
    assert.equal(getCapabilityPackageInstallIssue(manifest(394) as never, fiveE()), gate);
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(395) as never, fiveE()), gate);
    assert.notEqual(getCapabilityPackageInstallIssue(manifest(394) as never, fiveE({ appliesOneOf: undefined })), gate);
  }

  console.log(
    "Applies one of: Primeval Awareness offers its one mile or six as modes and puts on only the one picked, the first when none is; gated at 1.395.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
