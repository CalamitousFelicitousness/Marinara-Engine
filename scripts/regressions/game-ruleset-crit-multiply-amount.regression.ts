/**
 * Ruleset keys 5e needed (Capability API 1.76 to 1.80):
 *
 *   - 1.76 `combat.attackRoll.criticalFrom`: a critical range off the attacker's sheet (its fight is
 *     proven in game-ruleset-combat-core). Gated here.
 *   - 1.77 a derived value that `multiply`s: a 5e hit point maximum's Constitution modifier times the
 *     level. Worked out with the rest of the sheet, in the order the sheet lists them; gated.
 *   - 1.78 a catalog entry's `amountAdd`: a sheet value added to its amount (Second Wind's 1d10 plus the
 *     fighter's level; its fight is proven in game-ruleset-combat-core). Refused without an amount and
 *     on a rider; the catalog's line names it; gated inline and in a catalog file.
 *   - 1.79 up to 120 derived values on a sheet (60 before); more than 60 is gated.
 *   - 1.80 a list's number column filled by a roll: its dice read off the row's own column, a number
 *     or the sheet; refused where the sides cannot be read; gated.
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
  rulesetDieSides,
  rulesetListRollNotation,
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
      rulesetCatalogEntryIssues(
        definition,
        definition.catalogs!.find((catalog) => catalog.id === "feats")!,
        [entry as never],
      )
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
    // An item's use reads its own stats, never the sheet's: amountAdd is not an item's.
    const gravewatch = JSON.parse(read("../../docs/examples/rulesets/gravewatch.json"));
    gravewatch.catalogs
      .find((catalog: { id: string }) => catalog.id === "kit")
      .entries.find((entry: { id: string }) => entry.id === "warming-tonic").item.use.amountAdd = { const: 1 };
    assert.equal(parseRulesetDefinition(gravewatch).ok, false, "an item's use cannot add a sheet value");
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

  // ── 1.80 a list column filled by a roll ──
  const rolled = (sides: unknown, edit: (doc: Record<string, any>) => void = () => {}) =>
    variant((doc) => {
      doc.sheet.lists.push({
        id: "hp_rolls",
        label: "Hit point rolls",
        maxItems: 20,
        columns: [
          { id: "level", label: "Level", type: "text", maxLength: 20 },
          { id: "die", label: "Die", type: "enum", values: ["d6", "d8", "d10", "d12"] },
          { id: "roll", label: "Roll", type: "number", min: 1, max: 12, roll: { sides } },
        ],
      });
      edit(doc);
    });
  {
    const byColumn = parsed(rolled({ column: "die" }));
    const list = byColumn.sheet.lists.find((entry) => entry.id === "hp_rolls")!;
    const column = list.columns.find((entry) => entry.id === "roll")!;
    const build = defaultRulesetSheetBuild(byColumn);
    assert.equal(rulesetListRollNotation(byColumn, build, column, { die: "d10" }), "1d10", "the row's own die");
    assert.equal(
      rulesetListRollNotation(byColumn, build, column, {}),
      "1d6",
      "an empty die reads as the editor shows it",
    );
    assert.equal(rulesetListRollNotation(byColumn, build, column, { die: "huge" }), null, "a die that does not read");
    assert.equal(
      rulesetListRollNotation(byColumn, build, list.columns[0]!, { die: "d10" }),
      null,
      "not a rolled column",
    );
    const twice = parsed(rolled({ column: "die" }, (doc) => (doc.sheet.lists.at(-1).columns[2].roll.count = 2)));
    const twiceColumn = twice.sheet.lists.find((entry) => entry.id === "hp_rolls")!.columns[2]!;
    assert.equal(rulesetListRollNotation(twice, build, twiceColumn, { die: "d8" }), "2d8", "its count of dice");
    // A number die column left empty reads as the editor shows it: its default, else its minimum.
    const numbered = parsed(
      rolled({ column: "die" }, (doc) => {
        doc.sheet.lists.at(-1).columns[1] = { id: "die", label: "Die", type: "number", min: 4, max: 12 };
      }),
    );
    const numberedColumn = numbered.sheet.lists.find((entry) => entry.id === "hp_rolls")!.columns[2]!;
    assert.equal(rulesetListRollNotation(numbered, build, numberedColumn, {}), "1d4");
    const fixed = parsed(rolled(8));
    const fixedColumn = fixed.sheet.lists.find((entry) => entry.id === "hp_rolls")!.columns[2]!;
    assert.equal(rulesetListRollNotation(fixed, build, fixedColumn, {}), "1d8");
    const fromSheet = parsed(
      rolled({ derived: "hp_die_sides" }, (doc) =>
        doc.sheet.derived.push({ id: "hp_die_sides", label: "Hit die sides", op: "sum", of: [{ const: 12 }] }),
      ),
    );
    const sheetColumn = fromSheet.sheet.lists.find((entry) => entry.id === "hp_rolls")!.columns[2]!;
    assert.equal(rulesetListRollNotation(fromSheet, defaultRulesetSheetBuild(fromSheet), sheetColumn, {}), "1d12");
    assert.deepEqual(
      [
        rulesetDieSides("d8"),
        rulesetDieSides("D12"),
        rulesetDieSides(6),
        rulesetDieSides("d1"),
        rulesetDieSides("big"),
      ],
      [8, 12, 6, null, null],
    );
    const refused = (sides: unknown, edit?: (doc: Record<string, any>) => void) => {
      const result = parseRulesetDefinition(rolled(sides, edit));
      assert.equal(result.ok, false, JSON.stringify(sides));
      return result.ok ? "" : result.issues.join("; ");
    };
    assert.match(refused({ column: "nope" }), /not another column of this list/);
    assert.match(refused({ column: "roll" }), /not another column of this list/);
    assert.match(refused({ column: "level" }), /Sides read a number column or an enum of dice/);
    assert.match(
      refused({ column: "die" }, (doc) => doc.sheet.lists.at(-1).columns[1].values.push("lots")),
      /"lots" does not read as a die/,
    );
    assert.match(refused({ derived: "no_such" }), /no_such/);
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
    const inline = variant((doc) =>
      doc.catalogs.find((catalog: { holds?: string }) => !catalog.holds).entries.push(secondWind),
    );
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
    // 1.79: more than 60 derived values, up to 120.
    const many = (count: number) =>
      variant((doc) => {
        const have = doc.sheet.derived.length;
        for (let i = have; i < count; i++)
          doc.sheet.derived.push({ id: `extra_${i}`, label: `Extra ${i}`, op: "sum", of: [{ const: 1 }] });
      });
    assert.equal(parseRulesetDefinition(many(120)).ok, true, "120 derived values read");
    assert.equal(parseRulesetDefinition(many(240)).ok, true, "240 since 1.83");
    assert.equal(parseRulesetDefinition(many(400)).ok, true, "400 since 1.106");
    assert.equal(parseRulesetDefinition(many(401)).ok, false, "401 do not");
    assert.match(issue(78, many(61)) ?? "", /more than 60 derived values.*1\.79/);
    assert.equal(issue(79, many(61)), null);
    assert.equal(issue(78, many(60)), null, "60 is still 1.78's");
    // 1.83: more than 120, up to 240.
    assert.match(issue(82, many(121)) ?? "", /more than 120 derived values.*1\.83/);
    assert.equal(issue(83, many(121)), null);
    assert.equal(issue(82, many(120)), null, "120 is still 1.79's");
    assert.match(issue(79, rolled({ column: "die" })) ?? "", /list column filled by a roll.*1\.80/);
    assert.equal(issue(80, rolled({ column: "die" })), null);
  }

  console.log(
    "Ruleset hooks: a critical range off the sheet, a derived value that multiplies, and a sheet value added to an amount.",
  );
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
