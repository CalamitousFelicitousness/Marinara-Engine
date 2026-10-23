// Times the guided builder's reads for a level-20 character (not a regression).
import { readFileSync, readdirSync } from "node:fs";
import {
  applyRulesetBuilder,
  defaultRulesetSheetBuild,
  parseRulesetDefinition,
  rulesetBuilderAbilitySlots,
  rulesetBuilderAllocations,
  rulesetBuilderEntrySlots,
  rulesetBuilderOptions,
  rulesetBuilderRemaining,
  rulesetBuilderSpending,
  rulesetBuilderStepCount,
  rulesetBuilderTrainedSlots,
  withRulesetPlanMemoIn,
  evaluateRulesetSheet,
} from "../../packages/shared/src/index.js";
const dir = process.env.RS ?? "/mnt/project-files/ruleset/5e-2014-current";
const doc = JSON.parse(readFileSync(`${dir}/ruleset.json`, "utf8"));
const parsed = parseRulesetDefinition(doc);
if (!parsed.ok) throw new Error(parsed.issues.slice(0, 5).join("; "));
const definition = parsed.definition;
const catalogs: Record<string, any[]> = {};
for (const file of readdirSync(`${dir}/catalogs`)) {
  const c = JSON.parse(readFileSync(`${dir}/catalogs/${file}`, "utf8"));
  catalogs[typeof c.catalog === "string" ? c.catalog : c.catalog.id] = c.entries;
}
const cls = process.argv[2] ?? "wizard";
const lvl = Number(process.argv[3] ?? 20);
const t = (label: string, f: () => unknown) => {
  const s = performance.now();
  const r = f();
  console.log(label.padEnd(28), (performance.now() - s).toFixed(0), "ms");
  return r as any;
};
let build = defaultRulesetSheetBuild(definition);
build.fields = { ...build.fields, [`level_${cls}`]: lvl };
let state: any = { picks: { race: ["human"], class: [cls] } };
const applied = t("apply", () => applyRulesetBuilder(definition, build, state, catalogs as never));
build = applied.build;
state = applied.state;
// Fill every catalog step with what it offers, up to what it takes, as a player clicking through would.
for (const step of definition.sheet.builder!.steps) {
  if (step.kind !== "catalog" || step.id === "race" || step.id === "class") continue;
  const count = rulesetBuilderStepCount(definition, step, build);
  if (count.max === 0) continue;
  const offered = rulesetBuilderOptions(definition, step, state, catalogs as never, build) as any[];
  const ids = offered.map((o) => o.id).slice(0, count.max);
  if (!ids.length) continue;
  const next = t(`pick ${step.id} x${ids.length}`, () =>
    applyRulesetBuilder(definition, build, { ...state, picks: { ...state.picks, [step.id]: ids } }, catalogs as never),
  );
  build = next.build;
  state = next.state;
}
for (let round = 0; round < 2; round++) {
  const memo = new Map();
  const read = <T,>(f: () => T) => withRulesetPlanMemoIn(memo, f);
  console.log("-- round", round);
  t("evaluate", () => evaluateRulesetSheet(definition, build));
  t("remaining", () => read(() => rulesetBuilderRemaining(definition, build, state, catalogs as never)));
  t("abilitySlots", () => read(() => rulesetBuilderAbilitySlots(definition, state, catalogs as never, build)));
  t("trainedSlots", () => read(() => rulesetBuilderTrainedSlots(definition, state, catalogs as never, build)));
  t("allocations", () => read(() => rulesetBuilderAllocations(definition, build, state, catalogs as never)));
  t("spending", () => read(() => rulesetBuilderSpending(definition, build, state, catalogs as never)));
  t("entrySlots", () => read(() => rulesetBuilderEntrySlots(definition, state, catalogs as never, build)));
  t("asked(options all steps)", () => {
    for (const step of definition.sheet.builder!.steps) {
      if (step.kind !== "catalog") continue;
      if (!step.takesAll && rulesetBuilderStepCount(definition, step, build).max === 0) continue;
      read(() => rulesetBuilderOptions(definition, step, state, catalogs as never, build));
    }
  });
  t("apply again", () => applyRulesetBuilder(definition, build, state, catalogs as never));
}
if (process.env.OUT) (await import("node:fs")).writeFileSync(process.env.OUT, JSON.stringify({ build, state }));
