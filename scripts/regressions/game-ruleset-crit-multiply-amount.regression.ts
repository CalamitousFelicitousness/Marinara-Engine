/**
 * Three ruleset keys 5e needed (Capability API 1.76, 1.77, 1.78):
 *
 *   - 1.76 `combat.attackRoll.criticalFrom`: a critical range off the attacker's sheet (its fight is
 *     proven in game-ruleset-combat-core). Gated here.
 *   - 1.77 a derived value that `multiply`s: a 5e hit point maximum's Constitution modifier times the
 *     level. Worked out with the rest of the sheet, in the order the sheet lists them; gated.
 *   - 1.78 a catalog entry's `amountAdd`: a sheet value added to its amount (Second Wind's 1d10 plus the
 *     fighter's level; its fight is proven in game-ruleset-combat-core). Refused without an amount and
 *     on a rider; the catalog's line names it; gated inline and in a catalog file.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultRulesetSheetBuild,
  evaluateRulesetSheet,
  parseRulesetDefinition,
  rulesetCatalogEntryIssues,
  type RulesetDefinition,
} from "../../packages/shared/src/index.js";
import { catalogMechanicsLabels, formatCatalogMechanics } from "../../packages/client/src/lib/ruleset-catalog.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-crit-multiply-amount-"));
process.env.DATA_DIR = dataDir;
process.env.MARINARA_DATA_DIR = dataDir;
const { getCapabilityPackageInstallIssue } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");

try {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const fiveEText = read("../../docs/development/ruleset-5e-2014.example.json");
  const variant = (edit: (doc: Record<string, any>) => void = () => {}) => {
    const doc = JSON.parse(fiveEText) as Record<string, any>;
    edit(doc);
    return doc;
  };
  const parsed = (doc: unknown): RulesetDefinition => {
    const result = parseRulesetDefinition(doc);
    assert.ok(result.ok, result.ok ? "" : result.issues.join("; "));
    return result.definition;
  };

  // ── 1.77 multiply ──
  const multiplied = variant((doc) => {
    doc.sheet.derived.push(
      {
        id: "con_hp",
        label: "Hit points from Constitution",
        op: "multiply",
        of: [{ abilityMod: "con" }, { field: "level" }],
      },
      { id: "con_hp_twice", label: "Twice that", op: "multiply", of: [{ derived: "con_hp" }, { const: 2 }] },
    );
  });
  {
    const definition = parsed(multiplied);
    const base = defaultRulesetSheetBuild(definition);
    const build = { ...base, abilities: { ...base.abilities, con: 16 }, fields: { ...base.fields, level: 5 } };
    const derived = evaluateRulesetSheet(definition, build).derived;
    assert.deepEqual([derived.con_hp, derived.con_hp_twice], [15, 30], "+3 times level 5, then doubled");
    const negative = { ...build, abilities: { ...build.abilities, con: 6 } };
    assert.equal(evaluateRulesetSheet(definition, negative).derived.con_hp, -10, "a negative modifier multiplies too");
    const one = parseRulesetDefinition(
      variant((doc) => doc.sheet.derived.push({ id: "alone", label: "Alone", op: "multiply", of: [{ const: 2 }] })),
    );
    assert.equal(one.ok, false, "multiplying needs two values");
  }

  // ── 1.78 amountAdd ──
  const secondWind = {
    id: "second-wind",
    label: "Second Wind",
    mechanics: { kind: "heal", targets: "self", amount: { dice: "1d10" }, amountAdd: { field: "level" } },
  };
  {
    const definition = parsed(JSON.parse(fiveEText));
    const issues = (entry: Record<string, any>) =>
      rulesetCatalogEntryIssues(definition, definition.catalogs!.find((catalog) => catalog.id === "feats")!, [entry as never])
        .map((issue) => issue.message)
        .join("; ");
    assert.equal(issues(secondWind), "");
    assert.match(
      issues({ ...secondWind, mechanics: { kind: "heal", amountAdd: { field: "level" } } }),
      /amountAdd adds to an amount/,
    );
    assert.match(
      issues({ ...secondWind, mechanics: { ...secondWind.mechanics, amountAdd: { field: "nope" } } }),
      /nope/,
    );
    const t = ((key: string, params?: Record<string, unknown>) =>
      key === "game.ruleset.catalog.mechanics.amountAdd" ? `${params!.amount} + ${params!.value}` : key) as never;
    const line = formatCatalogMechanics(
      secondWind.mechanics as never,
      catalogMechanicsLabels(definition, { units: undefined } as never),
      t,
    );
    const level = definition.sheet.fields.find((field) => field.id === "level")!.label;
    assert.ok(line.includes(`1d10 + ${level}`), line);
  }

  // ── The gates ──
  {
    const manifest = (minor: number) => ({
      schemaVersion: 2,
      capabilityApi: { major: 1, minor },
      builtAgainst: { engineVersion: "2.4.6", engineCommit: "0".repeat(40) },
      id: "ruleset-hooks",
      name: "Hooks",
      version: "0.1.0",
      description: "A packaged ruleset with the 5e hooks.",
      engine: { min: "2.4.6", maxExclusive: "4.0.0" },
      kind: ["ruleset"],
      entrypoints: {},
      contributions: { assets: { paths: ["ruleset.json"] } },
      files: [{ path: "ruleset.json", sha256: "0".repeat(64), bytes: 10 }],
      permissions: [],
      restartRequired: false,
    });
    const issue = (minor: number, doc: Record<string, any>, files?: Map<string, unknown>, paths?: string[]) =>
      getCapabilityPackageInstallIssue(
        (paths ? { ...manifest(minor), contributions: { assets: { paths } } } : manifest(minor)) as any,
        doc,
        files as any,
      );
    const critical = variant((doc) => (doc.combat.attackRoll.criticalFrom = { const: 19 }));
    assert.match(issue(75, critical) ?? "", /critical range.*1\.76/);
    assert.equal(issue(76, critical), null);
    assert.match(issue(76, multiplied) ?? "", /multiplies.*1\.77/);
    assert.equal(issue(77, multiplied), null);
    const inline = variant((doc) => doc.catalogs.find((catalog: { holds?: string }) => !catalog.holds).entries.push(secondWind));
    assert.match(issue(77, inline) ?? "", /add a sheet value to their amount.*1\.78/);
    assert.equal(issue(78, inline), null);
    // In a catalog file, read at install.
    const filed = variant((doc) => {
      doc.catalogs[0].asset = "catalogs/one.json";
      delete doc.catalogs[0].entries;
    });
    const entries = [...(JSON.parse(fiveEText).catalogs[0].entries ?? []), secondWind];
    const files = new Map<string, unknown>([["catalogs/one.json", { entries }]]);
    const paths = ["ruleset.json", "catalogs/one.json"];
    assert.match(issue(77, filed, files, paths) ?? "", /1\.78/);
    assert.equal(issue(78, filed, files, paths), null);
    assert.equal(issue(74, variant()), null, "an older package still validates");
  }

  console.log(
    "Ruleset hooks: a critical range off the sheet, a derived value that multiplies, and a sheet value added to an amount.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
