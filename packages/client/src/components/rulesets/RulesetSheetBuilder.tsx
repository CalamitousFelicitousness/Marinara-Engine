// The guided builder (Capability API 1.81): a ruleset's `sheet.builder` as steps across the top, each
// with the choices it still waits on, Back and Next that never block, and the character as it stands
// beside them. Everything it writes goes through the shared builder, which keeps the build the one
// sheet the rest of the Engine reads and takes back what an unpicked entry gave.
import { Check, ChevronLeft, ChevronRight, Dices, Minus, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useTranslation as useUiTranslation } from "react-i18next";
import {
  applyRulesetBuilder,
  rulesetBuilderAbilityIds,
  rulesetBuilderAbilitySlots,
  rulesetBuilderBaseScores,
  rulesetBuilderCatalogIds,
  rulesetBuilderOptions,
  rulesetBuilderPicks,
  rulesetBuilderRemaining,
  rulesetBuilderTrainedSlots,
  evaluateRulesetSheet,
  rulesetPointBuySpent,
  type DiceRollResult,
  type RulesetBuilderAbilitySlot,
  type RulesetBuilderMethod,
  type RulesetBuilderState,
  type RulesetBuilderStep,
  type RulesetBuilderTrainedSlot,
  type RulesetCatalogEntriesById,
  type RulesetCatalogPayload,
  type RulesetDefinition,
  type RulesetLayerOptions,
  type RulesetSheetBuild,
} from "@marinara-engine/shared";
import { rulesetCatalogQuery } from "../../hooks/use-capability-packages";
import { api } from "../../lib/api-client";
import { visibleCatalogEntries } from "../../lib/ruleset-catalog";
import { rulesetCheckValueText } from "../../lib/ruleset-resolution";
import { DraftNumberInput } from "../ui/DraftNumberInput";
import { clamp, inputClass, labelClass, TypedInput } from "./RulesetTypedInput";

/** A bonus with its sign, as a sheet prints one. */
const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

type StepOf<K extends RulesetBuilderStep["kind"]> = Extract<RulesetBuilderStep, { kind: K }>;

const chipClass =
  "rounded-lg border px-2 py-1 text-[0.6875rem] transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const chipOn = "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--foreground)]";
const chipOff = "border-[var(--border)] text-[var(--foreground)] hover:bg-[var(--accent)]";
const buttonClass =
  "inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2 py-1 text-[0.6875rem] text-[var(--foreground)] hover:bg-[var(--accent)] disabled:opacity-50";

/** A choice of `count` among `from`, as toggles: a full choice takes no more until one is let go. */
function ChoiceSlot({
  title,
  slot,
  labelOf,
  onChange,
}: {
  title: string;
  slot: RulesetBuilderAbilitySlot | RulesetBuilderTrainedSlot;
  labelOf: (id: string) => string;
  onChange: (chosen: string[]) => void;
}) {
  const { t } = useUiTranslation();
  const full = slot.chosen.length >= slot.count;
  const left = Math.max(0, Math.min(slot.count, slot.from.length) - slot.chosen.length);
  return (
    <fieldset className="space-y-1.5 rounded-lg border border-[var(--border)] p-2">
      <legend className="px-1 text-[0.6875rem] font-semibold text-[var(--foreground)]">
        {title}{" "}
        <span className="font-normal text-[var(--muted-foreground)]">
          {t("ui.rulesets.builder.remaining", { count: left })}
        </span>
      </legend>
      <div className="flex flex-wrap gap-1.5">
        {slot.from.map((id) => {
          const on = slot.chosen.includes(id);
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              disabled={!on && full}
              onClick={() => onChange(on ? slot.chosen.filter((each) => each !== id) : [...slot.chosen, id])}
              className={`${chipClass} ${on ? chipOn : chipOff}`}
            >
              {labelOf(id)}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function RulesetSheetBuilder({
  definition,
  layerOptions,
  build,
  state,
  evaluated,
  onApply,
}: {
  definition: RulesetDefinition;
  layerOptions?: RulesetLayerOptions;
  build: RulesetSheetBuild;
  state: RulesetBuilderState;
  evaluated: ReturnType<typeof evaluateRulesetSheet>;
  /** The build with the choices applied, and the choices: one envelope change. */
  onApply: (build: RulesetSheetBuild, state: RulesetBuilderState) => void;
}) {
  const { t } = useUiTranslation();
  const builder = definition.sheet.builder!;
  const [stepIndex, setStepIndex] = useState(0);
  const [openInfo, setOpenInfo] = useState<string | null>(null);
  const [rolling, setRolling] = useState(false);
  const [rollFailed, setRollFailed] = useState(false);

  // Every catalog the steps read, loaded before anything is applied: a pick whose catalog has not
  // arrived would grant nothing, which would take back what it gave.
  const catalogIds = useMemo(() => rulesetBuilderCatalogIds(definition), [definition]);
  const combine = useCallback(
    (results: readonly { data: RulesetCatalogPayload | undefined; isError: boolean }[]) => {
      const loaded: RulesetCatalogEntriesById = {};
      results.forEach((result, index) => {
        const catalogId = catalogIds[index]!;
        if (result.data) {
          loaded[catalogId] = visibleCatalogEntries(definition, layerOptions, catalogId, result.data.entries);
        }
      });
      return {
        catalogs: loaded,
        ready: results.every((result) => !!result.data),
        failed: results.some((result) => result.isError),
      };
    },
    [catalogIds, definition, layerOptions],
  );
  const { catalogs, ready, failed } = useQueries({
    queries: catalogIds.map((catalogId) => rulesetCatalogQuery(definition.id, catalogId, definition.version)),
    combine,
  });

  const step = builder.steps[Math.min(stepIndex, builder.steps.length - 1)]!;
  const remaining = useMemo(
    () => (ready ? rulesetBuilderRemaining(definition, build, state, catalogs) : {}),
    [build, catalogs, definition, ready, state],
  );
  const abilitySlots = useMemo(
    () => (ready ? rulesetBuilderAbilitySlots(definition, state, catalogs) : []),
    [catalogs, definition, ready, state],
  );
  const trainedSlots = useMemo(
    () => (ready ? rulesetBuilderTrainedSlots(definition, state, catalogs) : []),
    [catalogs, definition, ready, state],
  );

  const update = (next: RulesetBuilderState) => {
    if (!ready) return;
    const applied = applyRulesetBuilder(definition, build, next, catalogs);
    onApply(applied.build, applied.state);
  };

  const abilityLabel = (id: string) => definition.sheet.abilities.find((ability) => ability.id === id)?.label ?? id;
  const skillLabel = (id: string) => definition.sheet.skills.find((skill) => skill.id === id)?.label ?? id;
  const saveLabel = (id: string) => definition.sheet.saves.find((save) => save.id === id)?.label ?? id;

  const slotsHere = (
    <>
      {abilitySlots
        .filter((slot) => slot.stepId === step.id)
        .map((slot) => (
          <ChoiceSlot
            key={slot.key}
            title={t("ui.rulesets.builder.chooseScores", {
              from: slot.entry?.label ?? step.label,
              count: slot.count,
              amount: signed(slot.amount),
            })}
            slot={slot}
            labelOf={abilityLabel}
            onChange={(chosen) => update({ ...state, abilityChoices: { ...state.abilityChoices, [slot.key]: chosen } })}
          />
        ))}
      {trainedSlots
        .filter((slot) => slot.stepId === step.id)
        .map((slot) => (
          <ChoiceSlot
            key={slot.key}
            title={t(slot.what === "skills" ? "ui.rulesets.builder.chooseSkills" : "ui.rulesets.builder.chooseSaves", {
              from: slot.entry?.label ?? step.label,
              count: slot.count,
            })}
            slot={slot}
            labelOf={slot.what === "skills" ? skillLabel : saveLabel}
            onChange={(chosen) => update({ ...state, trainedChoices: { ...state.trainedChoices, [slot.key]: chosen } })}
          />
        ))}
    </>
  );

  const catalogStep = (current: StepOf<"catalog">) => {
    const options = rulesetBuilderOptions(definition, current, state, catalogs);
    const picked = rulesetBuilderPicks(definition, current.id, state, catalogs).map((entry) => entry.id);
    const toggle = (id: string) => {
      const on = picked.includes(id);
      const next = on ? picked.filter((each) => each !== id) : current.max === 1 ? [id] : [...picked, id];
      update({ ...state, picks: { ...state.picks, [current.id]: next } });
    };
    if (options.length === 0) {
      return (
        <p className="text-xs text-[var(--muted-foreground)]">
          {current.within ? t("ui.rulesets.builder.pickEarlier") : t("ui.rulesets.builder.noOptions")}
        </p>
      );
    }
    return (
      <div className="space-y-2">
        <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
          {t("ui.rulesets.builder.pickCount", { count: current.max, picked: picked.length })}
        </p>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {options.map((entry) => {
            const on = picked.includes(entry.id);
            const full = !on && current.max > 1 && picked.length >= current.max;
            const infoId = `${current.id}:${entry.id}`;
            return (
              <li
                key={entry.id}
                className={`flex flex-col gap-1 rounded-lg border p-2 ${on ? "border-[var(--primary)]" : "border-[var(--border)]"} bg-[var(--card)]`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-xs font-semibold text-[var(--foreground)]">{entry.label}</span>
                  <div className="flex shrink-0 items-center gap-1">
                    {entry.summary && (
                      <button
                        type="button"
                        aria-expanded={openInfo === infoId}
                        onClick={() => setOpenInfo(openInfo === infoId ? null : infoId)}
                        aria-label={t("ui.rulesets.builder.infoFor", { name: entry.label })}
                        className={`${chipClass} ${chipOff}`}
                      >
                        {t("ui.rulesets.builder.info")}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-pressed={on}
                      disabled={full}
                      onClick={() => toggle(entry.id)}
                      aria-label={t(on ? "ui.rulesets.builder.unpick" : "ui.rulesets.builder.pick", {
                        name: entry.label,
                      })}
                      className={`${chipClass} ${on ? chipOn : chipOff}`}
                    >
                      {on ? <Check size={12} aria-hidden="true" /> : t("ui.rulesets.builder.select")}
                    </button>
                  </div>
                </div>
                {openInfo === infoId && entry.summary && (
                  <p className="text-[0.6875rem] text-[var(--muted-foreground)]">{entry.summary}</p>
                )}
              </li>
            );
          })}
        </ul>
        {slotsHere}
      </div>
    );
  };

  const fieldsStep = (current: StepOf<"fields">) => (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {current.fields.map((id) => {
        const field = definition.sheet.fields.find((each) => each.id === id);
        if (!field) return null;
        return (
          <label key={id} className={`flex min-w-0 flex-col gap-1 ${field.type === "longtext" ? "col-span-full" : ""}`}>
            <span className={labelClass}>{field.label}</span>
            <TypedInput
              spec={field}
              value={build.fields[id]}
              onChange={(value) => onApply({ ...build, fields: { ...build.fields, [id]: value } }, state)}
              ariaLabel={field.label}
            />
          </label>
        );
      })}
    </div>
  );

  const abilitiesStep = (current: StepOf<"abilities">) => {
    const ids = rulesetBuilderAbilityIds(definition, current);
    const methods = (["pointBuy", "standardArray", "roll", "manual"] as const).filter(
      (method) => current.methods[method] !== undefined,
    );
    const method = state.method && current.methods[state.method] ? state.method : undefined;
    const base = rulesetBuilderBaseScores(definition, state);
    const increases = state.applied?.increases ?? {};
    const pointBuy = current.methods.pointBuy;
    const spent = method === "pointBuy" && pointBuy ? rulesetPointBuySpent(pointBuy, base, ids) : null;
    const values = method === "standardArray" ? (current.methods.standardArray ?? []) : (state.rolled ?? []);
    const takenBy = new Map<number, string>();
    for (const id of ids) {
      const index = state.assign?.[id];
      if (index !== undefined && !takenBy.has(index)) takenBy.set(index, id);
    }
    const choose = (next: RulesetBuilderMethod) => update({ ...state, method: next });
    const roll = async () => {
      const spec = current.methods.roll;
      if (!spec) return;
      setRolling(true);
      setRollFailed(false);
      try {
        const totals: number[] = [];
        for (let i = 0; i < ids.length; i++) {
          const { result } = await api.post<{ result: DiceRollResult }>("/game/dice/roll", {
            notation: `${spec.count}d${spec.sides}`,
          });
          const kept = [...result.rolls].sort((a, b) => b - a).slice(0, spec.keep);
          totals.push(kept.reduce((sum, value) => sum + value, 0));
        }
        update({ ...state, method: "roll", rolled: totals, assign: {} });
      } catch {
        // Nothing is written when the dice did not come back, and the step says so.
        setRollFailed(true);
      } finally {
        setRolling(false);
      }
    };
    return (
      <div className="space-y-2">
        <div role="radiogroup" aria-label={t("ui.rulesets.builder.method")} className="flex flex-wrap gap-1.5">
          {methods.map((each) => (
            <button
              key={each}
              type="button"
              role="radio"
              aria-checked={method === each}
              onClick={() => choose(each)}
              className={`${chipClass} ${method === each ? chipOn : chipOff}`}
            >
              {t(`ui.rulesets.builder.methods.${each}`)}
            </button>
          ))}
        </div>
        {method === "pointBuy" && pointBuy && (
          <p className="text-[0.6875rem] text-[var(--muted-foreground)]" role="status">
            {spent === null
              ? t("ui.rulesets.builder.pointsOffTable")
              : t("ui.rulesets.builder.pointsLeft", { left: pointBuy.budget - spent, budget: pointBuy.budget })}
          </p>
        )}
        {method === "roll" && current.methods.roll && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={rolling} onClick={() => void roll()} className={buttonClass}>
              <Dices size={12} aria-hidden="true" />
              {t(state.rolled?.length ? "ui.rulesets.builder.rollAgain" : "ui.rulesets.builder.rollScores", {
                notation: `${current.methods.roll.count}d${current.methods.roll.sides}`,
                keep: current.methods.roll.keep,
              })}
            </button>
            {state.rolled?.length ? (
              <span className="text-[0.6875rem] text-[var(--muted-foreground)]">
                {t("ui.rulesets.builder.rolled", { values: state.rolled.join(", ") })}
              </span>
            ) : null}
            {rollFailed && (
              <span role="status" className="text-[0.625rem] text-[var(--destructive)]">
                {t("ui.rulesets.sheet.rollFailed")}
              </span>
            )}
          </div>
        )}
        {method && (
          <div className="space-y-1">
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,6.5rem)_2.5rem_2.5rem_2.5rem] gap-1.5 text-[0.625rem] text-[var(--muted-foreground)]">
              <span />
              <span>{t("ui.rulesets.builder.base")}</span>
              <span className="text-center">{t("ui.rulesets.builder.bonus")}</span>
              <span className="text-center">{t("ui.rulesets.builder.total")}</span>
              <span className="text-center">{t("ui.rulesets.builder.mod")}</span>
            </div>
            {ids.map((id) => {
              const ability = definition.sheet.abilities.find((each) => each.id === id)!;
              const increase = increases[id] ?? 0;
              let control: React.ReactNode = null;
              if (method === "pointBuy" && pointBuy) {
                const score = base[id] ?? pointBuy.costs[0]![0];
                const costOf = (value: number) => pointBuy.costs.find(([each]) => each === value)?.[1];
                const up = costOf(score + 1);
                const now = costOf(score) ?? 0;
                const canUp = up !== undefined && spent !== null && spent - now + up <= pointBuy.budget;
                const set = (value: number) => update({ ...state, base: { ...base, [id]: value } });
                control = (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={costOf(score - 1) === undefined}
                      onClick={() => set(score - 1)}
                      aria-label={t("ui.rulesets.builder.lower", { name: ability.label })}
                      className={`${chipClass} ${chipOff} px-1.5`}
                    >
                      <Minus size={12} aria-hidden="true" />
                    </button>
                    <span className="w-6 text-center text-xs tabular-nums text-[var(--foreground)]">{score}</span>
                    <button
                      type="button"
                      disabled={!canUp}
                      onClick={() => set(score + 1)}
                      aria-label={t("ui.rulesets.builder.raise", { name: ability.label })}
                      className={`${chipClass} ${chipOff} px-1.5`}
                    >
                      <Plus size={12} aria-hidden="true" />
                    </button>
                  </div>
                );
              } else if (method === "manual") {
                control = (
                  <DraftNumberInput
                    value={base[id] ?? (build.abilities[id] ?? ability.default) - increase}
                    onCommit={(next) =>
                      update({ ...state, base: { ...base, [id]: clamp(next, ability.min, ability.max) } })
                    }
                    min={ability.min}
                    max={ability.max}
                    integer
                    ariaLabel={t("ui.rulesets.builder.baseFor", { name: ability.label })}
                    className={`${inputClass} text-center`}
                  />
                );
              } else {
                const index = state.assign?.[id];
                control = (
                  <select
                    value={index !== undefined && takenBy.get(index) === id ? String(index) : ""}
                    disabled={values.length === 0}
                    onChange={(event) => {
                      const assign = { ...state.assign };
                      if (event.target.value === "") delete assign[id];
                      else {
                        const chosen = Number(event.target.value);
                        // The value moves here from whichever score had it.
                        for (const [other, at] of Object.entries(assign)) if (at === chosen) delete assign[other];
                        assign[id] = chosen;
                      }
                      update({ ...state, assign });
                    }}
                    aria-label={t("ui.rulesets.builder.baseFor", { name: ability.label })}
                    className={inputClass}
                  >
                    <option value="">{t("ui.rulesets.builder.unassigned")}</option>
                    {values.map((value, valueIndex) => (
                      <option key={valueIndex} value={String(valueIndex)}>
                        {takenBy.has(valueIndex) && takenBy.get(valueIndex) !== id
                          ? t("ui.rulesets.builder.valueTaken", {
                              value,
                              by: definition.sheet.abilities.find((each) => each.id === takenBy.get(valueIndex))?.short,
                            })
                          : String(value)}
                      </option>
                    ))}
                  </select>
                );
              }
              return (
                <div
                  key={id}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,6.5rem)_2.5rem_2.5rem_2.5rem] items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-1"
                >
                  <span className="min-w-0 truncate text-xs text-[var(--foreground)]">{ability.label}</span>
                  {control}
                  <span className="text-center text-xs tabular-nums text-[var(--muted-foreground)]">
                    {increase !== 0 ? signed(increase) : ""}
                  </span>
                  <span className="text-center text-xs font-semibold tabular-nums text-[var(--foreground)]">
                    {evaluated.abilityScores[id] ?? ability.default}
                  </span>
                  <span className="text-center text-xs tabular-nums text-[var(--foreground)]">
                    {rulesetCheckValueText(definition, evaluated.abilityMods[id] ?? 0, t)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {slotsHere}
      </div>
    );
  };

  const trainedStep = () => {
    const fixed = (["skills", "saves"] as const).flatMap((what) =>
      Object.keys(state.applied?.[what] ?? {}).map((id) => (what === "skills" ? skillLabel(id) : saveLabel(id))),
    );
    return (
      <div className="space-y-2">
        {fixed.length > 0 && (
          <p className="text-[0.6875rem] text-[var(--muted-foreground)]">
            {t("ui.rulesets.builder.trainedNow", { names: fixed.join(", ") })}
          </p>
        )}
        {slotsHere}
        {trainedSlots.every((slot) => slot.stepId !== step.id) && (
          <p className="text-xs text-[var(--muted-foreground)]">{t("ui.rulesets.builder.nothingToChoose")}</p>
        )}
      </div>
    );
  };

  const gearStep = () => (
    <div className="space-y-1.5">
      <p className="text-xs text-[var(--muted-foreground)]">{t("ui.rulesets.builder.gearHint")}</p>
      <ul className="space-y-1">
        {(definition.items?.startingGear ?? []).map((gear) => (
          <li key={gear.id} className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs">
            <span className="font-semibold text-[var(--foreground)]">{gear.label}</span>
            {gear.summary && <span className="ml-1 text-[var(--muted-foreground)]">{gear.summary}</span>}
          </li>
        ))}
      </ul>
    </div>
  );

  const trainedNames = (what: "skills" | "saves") => {
    const tiers = evaluated[what === "skills" ? "skillTiers" : "saveTiers"];
    const untrained = definition.resolution.proficiencyTiers[0]!.id;
    return Object.entries(tiers)
      .filter(([, tier]) => tier !== untrained)
      .map(([id]) => (what === "skills" ? skillLabel(id) : saveLabel(id)));
  };
  const pickedFields = builder.steps.flatMap((each) =>
    each.kind === "catalog" && each.field ? [each.field] : each.kind === "fields" ? each.fields : [],
  );

  return (
    <div className="space-y-3">
      <nav aria-label={t("ui.rulesets.builder.steps")}>
        <ol className="flex flex-wrap gap-1.5">
          {builder.steps.map((each, index) => {
            const left = remaining[each.id] ?? 0;
            return (
              <li key={each.id}>
                <button
                  type="button"
                  aria-current={each.id === step.id ? "step" : undefined}
                  onClick={() => setStepIndex(index)}
                  className={`${chipClass} inline-flex items-center gap-1 ${each.id === step.id ? chipOn : chipOff}`}
                >
                  {each.label}
                  {ready && left > 0 ? (
                    <span
                      className="rounded-full bg-[var(--primary)] px-1.5 text-[0.625rem] font-semibold text-[var(--primary-foreground)]"
                      aria-label={t("ui.rulesets.builder.remaining", { count: left })}
                    >
                      {left}
                    </span>
                  ) : ready ? (
                    <Check size={12} aria-label={t("ui.rulesets.builder.done")} />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_14rem]">
        <section aria-label={step.label} className="min-w-0 space-y-2">
          <h4 className="text-xs font-semibold text-[var(--foreground)]">{step.label}</h4>
          {failed ? (
            <p role="alert" className="text-xs text-[var(--destructive)]">
              {t("ui.rulesets.builder.loadFailed")}
            </p>
          ) : !ready ? (
            <p className="text-xs text-[var(--muted-foreground)]">{t("ui.rulesets.builder.loading")}</p>
          ) : step.kind === "catalog" ? (
            catalogStep(step)
          ) : step.kind === "fields" ? (
            fieldsStep(step)
          ) : step.kind === "abilities" ? (
            abilitiesStep(step)
          ) : step.kind === "trained" ? (
            trainedStep()
          ) : (
            gearStep()
          )}
          <div className="flex justify-between gap-2 pt-1">
            <button
              type="button"
              disabled={stepIndex === 0}
              onClick={() => setStepIndex(stepIndex - 1)}
              className={buttonClass}
            >
              <ChevronLeft size={12} aria-hidden="true" />
              {t("ui.rulesets.builder.back")}
            </button>
            <button
              type="button"
              disabled={stepIndex >= builder.steps.length - 1}
              onClick={() => setStepIndex(stepIndex + 1)}
              className={buttonClass}
            >
              {t("ui.rulesets.builder.next")}
              <ChevronRight size={12} aria-hidden="true" />
            </button>
          </div>
        </section>

        <aside
          aria-label={t("ui.rulesets.builder.summary")}
          className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--card)] p-2"
        >
          <h4 className="text-xs font-semibold text-[var(--foreground)]">{t("ui.rulesets.builder.summary")}</h4>
          {pickedFields.length > 0 && (
            <dl className="space-y-0.5 text-[0.6875rem]">
              {[...new Set(pickedFields)].map((id) => {
                const field = definition.sheet.fields.find((each) => each.id === id);
                const value = build.fields[id];
                if (!field || value === undefined || value === "") return null;
                return (
                  <div key={id} className="flex justify-between gap-2">
                    <dt className="text-[var(--muted-foreground)]">{field.label}</dt>
                    <dd className="truncate text-right text-[var(--foreground)]">
                      {field.type === "enum" ? (field.valueLabels?.[String(value)] ?? String(value)) : String(value)}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
          {definition.sheet.abilities.length > 0 && (
            <div className="grid grid-cols-3 gap-1">
              {definition.sheet.abilities.map((ability) => (
                <div key={ability.id} className="rounded border border-[var(--border)] px-1 py-0.5 text-center">
                  <div className="text-[0.625rem] text-[var(--muted-foreground)]">{ability.short ?? ability.label}</div>
                  <div className="text-xs font-semibold tabular-nums text-[var(--foreground)]">
                    {evaluated.abilityScores[ability.id] ?? ability.default}
                  </div>
                  <div className="text-[0.625rem] tabular-nums text-[var(--muted-foreground)]">
                    {rulesetCheckValueText(definition, evaluated.abilityMods[ability.id] ?? 0, t)}
                  </div>
                </div>
              ))}
            </div>
          )}
          {(["saves", "skills"] as const).map((what) => {
            const names = trainedNames(what);
            return names.length > 0 ? (
              <p key={what} className="text-[0.6875rem] text-[var(--foreground)]">
                <span className="text-[var(--muted-foreground)]">
                  {t(what === "skills" ? "ui.rulesets.sheet.skills" : "ui.rulesets.sheet.saves")}:
                </span>{" "}
                {names.join(", ")}
              </p>
            ) : null;
          })}
        </aside>
      </div>
    </div>
  );
}
