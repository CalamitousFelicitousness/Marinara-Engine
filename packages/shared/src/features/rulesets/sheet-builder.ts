// The guided builder (Capability API 1.81): a ruleset's `sheet.builder` walks a player through making a
// character in steps, and the catalog entries picked on the way say what they `grant`. What the player
// chose is kept beside the build, in the sheet envelope's `builder`, so a step can be reopened; the
// build itself stays the sheet every other part of the Engine reads.
//
// Applying is a pure step from (build, choices) to build, and it only ever changes what the builder
// itself wrote: what it wrote last time is kept in `applied`, so unpicking a race takes back its
// increases and its rows, and an edit the player made in the full form survives until the builder's
// own answer for that value changes.

import { z } from "zod";
import {
  catalogRowRef,
  rowsFromCatalogEntry,
  RULESET_CATALOG_ROW_KEY,
  type RulesetBuilderStep,
  type RulesetCatalogEntriesById,
  type RulesetCatalogEntry,
  type RulesetCatalogGrants,
  type RulesetDefinition,
  type RulesetSheetBuild,
} from "../../schemas/ruleset.schema.js";
import { defaultRulesetSheetBuild, resolveRulesetValueRef } from "./sheet-math.js";

type Scalar = number | string | boolean;
type StepOf<K extends RulesetBuilderStep["kind"]> = Extract<RulesetBuilderStep, { kind: K }>;

export type RulesetBuilderMethod = "pointBuy" | "standardArray" | "roll" | "manual";

/** What the builder wrote into the build last time it ran, so the next run can take it back. */
export interface RulesetBuilderApplied {
  increases: Record<string, number>;
  /** The scores the builder wrote from a method's base, so an edit made since is kept until they change. */
  scores: Record<string, number>;
  skills: Record<string, string>;
  saves: Record<string, string>;
  fields: Record<string, Scalar>;
  rows: string[];
}

/** The player's choices, as the envelope's `builder` holds them. */
export interface RulesetBuilderState {
  method?: RulesetBuilderMethod;
  /** Bought or typed scores, by ability (point buy and manual). */
  base?: Record<string, number>;
  /** Rolled totals, in the order they were rolled. */
  rolled?: number[];
  /** Which array value or rolled total each ability took, by its index. */
  assign?: Record<string, number>;
  /** Entry ids picked at each catalog step. */
  picks?: Record<string, string[]>;
  /** Abilities chosen for a grant's `abilities.choose`, keyed by `rulesetBuilderChoiceKey`. */
  abilityChoices?: Record<string, string[]>;
  /** Skills or saves chosen for a grant's or a trained step's `choose`. */
  trainedChoices?: Record<string, string[]>;
  /** Catalog entries chosen for a grant's `entries.choose` (1.86). */
  entryChoices?: Record<string, string[]>;
  applied?: RulesetBuilderApplied;
  /** Picks describe the character as it already is: what they grant is recorded as given, and the
   *  sheet is not changed. For a character made before the builder, until the player says done. */
  describing?: boolean;
  /** Set once the builder starts a blank sheet: only such a character takes a step's `default` method
   *  (1.82). One it described never does, so ending describing keeps its scores. */
  made?: "builder";
}

const idList = z.array(z.string().max(80)).max(120);
const stateShape = {
  method: z.enum(["pointBuy", "standardArray", "roll", "manual"]).optional(),
  base: z.record(z.number().finite()).optional(),
  rolled: z.array(z.number().finite()).max(40).optional(),
  assign: z.record(z.number().int().min(0).max(40)).optional(),
  picks: z.record(idList).optional(),
  abilityChoices: z.record(idList).optional(),
  trainedChoices: z.record(idList).optional(),
  entryChoices: z.record(idList).optional(),
  describing: z.boolean().optional(),
  made: z.literal("builder").optional(),
  applied: z
    .object({
      increases: z.record(z.number().finite()).default({}),
      scores: z.record(z.number().finite()).default({}),
      skills: z.record(z.string().max(40)).default({}),
      saves: z.record(z.string().max(40)).default({}),
      fields: z.record(z.union([z.number().finite(), z.string().max(4000), z.boolean()])).default({}),
      rows: z.array(z.string().max(200)).max(1000).default([]),
    })
    .optional(),
};

/** The builder state an envelope carries, read tolerantly key by key: a key it cannot read is no choice
 *  yet, and never costs the others. */
export function readRulesetBuilderState(envelope: unknown): RulesetBuilderState {
  const raw = envelope && typeof envelope === "object" ? (envelope as { builder?: unknown }).builder : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const state: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(stateShape)) {
    const parsed = schema.safeParse((raw as Record<string, unknown>)[key]);
    if (parsed.success && parsed.data !== undefined) state[key] = parsed.data;
  }
  return state as RulesetBuilderState;
}

/** The key a grant's choice is kept under: the step and entry that granted it, and which choice. A
 *  trained step's own choices have no entry. */
export function rulesetBuilderChoiceKey(stepId: string, entryId: string | null, index: number): string {
  return `${stepId}/${entryId ?? ""}/${index}`;
}

function filterHas(entry: RulesetCatalogEntry, filterId: string, value: string | number): boolean {
  const have = entry.filters?.[filterId];
  return Array.isArray(have) ? typeof value === "string" && have.includes(value) : have === value;
}

/** The entries a catalog step offers: its fixed filters, and under `within` only those that name an
 *  entry still picked at the earlier step. */
export function rulesetBuilderOptions(
  definition: RulesetDefinition,
  step: StepOf<"catalog">,
  state: RulesetBuilderState,
  catalogs: RulesetCatalogEntriesById,
  /** The sheet as it stands, which a step's `upTo` reads; no limit without it. */
  build?: RulesetSheetBuild,
): RulesetCatalogEntry[] {
  const entries = catalogs[step.catalog] ?? [];
  // Read off the sheet as it stands; an entry without the filter is never held back by it.
  const limit = step.upTo && build ? resolveRulesetValueRef(definition, build, step.upTo.value) : null;
  const parentPicks = step.within ? rulesetBuilderPicks(definition, step.within.step, state, catalogs, build) : null;
  return entries.filter((entry) => {
    for (const [filterId, value] of Object.entries(step.filters ?? {})) {
      if (!filterHas(entry, filterId, value)) return false;
    }
    if (step.upTo && limit !== null) {
      const at = entry.filters?.[step.upTo.filter];
      if (typeof at === "number" && at > limit) return false;
    }
    // Offered only while the sheet as it stands says so (1.94): a second class's prerequisites.
    if (entry.offeredWhen && build && !(resolveRulesetValueRef(definition, build, entry.offeredWhen) > 0)) return false;
    if (step.within && parentPicks) {
      if (!parentPicks.some((picked) => filterHas(entry, step.within!.filter, picked.id))) return false;
    }
    return true;
  });
}

/** How many entries a catalog step asks for and at most takes: its `countFrom` read off the sheet as it
 *  stands (1.85), whole and between 0 and its `max`, or else its own `min` and `max`. */
export function rulesetBuilderStepCount(
  definition: RulesetDefinition,
  step: StepOf<"catalog">,
  build?: RulesetSheetBuild,
): { min: number; max: number } {
  if (!step.countFrom || !build) return { min: step.min, max: step.max };
  const value = resolveRulesetValueRef(definition, build, step.countFrom);
  const count = Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 0), step.max) : 0;
  return { min: count, max: count };
}

function stepById(definition: RulesetDefinition, stepId: string): RulesetBuilderStep | undefined {
  return definition.sheet.builder?.steps.find((step) => step.id === stepId);
}

/** The entries picked at a catalog step that it still offers, in the order they were picked. A pick
 *  whose parent was unpicked, or that left the catalog, counts for nothing but is kept. */
export function rulesetBuilderPicks(
  definition: RulesetDefinition,
  stepId: string,
  state: RulesetBuilderState,
  catalogs: RulesetCatalogEntriesById,
  /** The sheet as it stands, which a step's `upTo` reads; no limit without it. */
  build?: RulesetSheetBuild,
): RulesetCatalogEntry[] {
  const step = stepById(definition, stepId);
  if (!step || step.kind !== "catalog") return [];
  // `within` only ever names an earlier step (the ruleset is refused otherwise), so this ends.
  const offered = rulesetBuilderOptions(definition, step, state, catalogs, build);
  const byId = new Map(offered.map((entry) => [entry.id, entry]));
  // One pick of an `exclusive` group counts (1.89): the latest, since picking replaces; earlier ones
  // of the same group count for nothing.
  const picked = (state.picks?.[stepId] ?? [])
    .map((id) => byId.get(id))
    .filter((entry): entry is RulesetCatalogEntry => !!entry);
  const lastOfGroup = new Map<string, RulesetCatalogEntry>();
  for (const entry of picked) if (entry.exclusive) lastOfGroup.set(entry.exclusive, entry);
  return picked
    .filter((entry) => !entry.exclusive || lastOfGroup.get(entry.exclusive) === entry)
    .slice(0, rulesetBuilderStepCount(definition, step, build).max);
}

/** The stored picks of a step with `id` added: one of an `exclusive` group (1.89) replaces the step's
 *  other picks of that group, and any other is added at the end. */
export function rulesetBuilderPickAdded(
  step: StepOf<"catalog">,
  stored: readonly string[],
  id: string,
  catalogs: RulesetCatalogEntriesById,
): string[] {
  const entries = catalogs[step.catalog] ?? [];
  const group = entries.find((entry) => entry.id === id)?.exclusive;
  const kept = stored.filter(
    (each) => each !== id && (!group || entries.find((entry) => entry.id === each)?.exclusive !== group),
  );
  return step.max === 1 ? [id] : [...kept, id];
}

/** Every pick that counts, with the step that made it, in step order. */
export function rulesetBuilderGranting(
  definition: RulesetDefinition,
  state: RulesetBuilderState,
  catalogs: RulesetCatalogEntriesById,
  /** The sheet as it stands, which a step's `upTo` reads; no limit without it. */
  build?: RulesetSheetBuild,
): { step: StepOf<"catalog">; entry: RulesetCatalogEntry }[] {
  // One entry picked at two steps on one catalog (a feat and a bonus feat) grants once.
  const seen = new Set<string>();
  return (definition.sheet.builder?.steps ?? []).flatMap((step) =>
    step.kind === "catalog"
      ? rulesetBuilderPicks(definition, step.id, state, catalogs, build)
          .filter((entry) => {
            const ref = catalogRowRef(step.catalog, entry.id);
            if (seen.has(ref)) return false;
            seen.add(ref);
            return true;
          })
          .map((entry) => ({ step, entry }))
      : [],
  );
}

/** One choice a player still has to make or has made, and which step shows it. */
export interface RulesetBuilderChoiceSlot {
  key: string;
  /** The step it is shown and counted at. */
  stepId: string;
  /** The entry that granted it; none for a trained step's own choice. */
  entry: RulesetCatalogEntry | null;
  count: number;
  /** What may be chosen. */
  from: string[];
  chosen: string[];
}

export interface RulesetBuilderAbilitySlot extends RulesetBuilderChoiceSlot {
  amount: number;
  /** No score goes past this through the choice (1.91). */
  upTo?: number;
  /** One score may be chosen more than once (1.88). */
  repeat?: boolean;
}

export interface RulesetBuilderTrainedSlot extends RulesetBuilderChoiceSlot {
  what: "skills" | "saves";
  tier: string;
}

export interface RulesetBuilderEntrySlot extends RulesetBuilderChoiceSlot {
  /** The catalog the entries are chosen from; `from` holds their ids. */
  catalog: string;
}

/** The tier a grant trains to: its own, the builder's, or the first above untrained the sheet offers
 *  for skills or saves. */
function grantTier(
  definition: RulesetDefinition,
  grants: RulesetCatalogGrants | undefined,
  what: "skills" | "saves",
): string {
  const tiers = definition.resolution.proficiencyTiers;
  const offered = what === "skills" ? definition.sheet.skillTiers : definition.sheet.saveTiers;
  const firstOffered = tiers.slice(1).find((tier) => !offered || offered.includes(tier.id));
  return grants?.trained?.tier ?? definition.sheet.builder?.tier ?? firstOffered?.id ?? tiers[1]?.id ?? tiers[0]!.id;
}

/** Every ability choice the picks offer. Each is shown at the abilities step, or where the entry was
 *  picked when the builder has none. */
export function rulesetBuilderAbilitySlots(
  definition: RulesetDefinition,
  state: RulesetBuilderState,
  catalogs: RulesetCatalogEntriesById,
  /** The sheet as it stands, which a step's `upTo` reads; no limit without it. */
  build?: RulesetSheetBuild,
): RulesetBuilderAbilitySlot[] {
  const host = definition.sheet.builder?.steps.find((step) => step.kind === "abilities")?.id;
  const all = definition.sheet.abilities.map((ability) => ability.id);
  return rulesetBuilderGranting(definition, state, catalogs, build).flatMap(({ step, entry }) =>
    (entry.grants?.abilities?.choose ?? []).map((choice, index) => {
      const key = rulesetBuilderChoiceKey(step.id, entry.id, index);
      const from = all.filter((id) => !choice.except?.includes(id));
      // A choice that repeats (1.88) may name one score more than once; any other names each once.
      const stored = (state.abilityChoices?.[key] ?? []).filter((id) => from.includes(id));
      const chosen = choice.repeat ? stored : [...new Set(stored)];
      return {
        key,
        stepId: host ?? step.id,
        entry,
        count: choice.count,
        amount: choice.amount,
        from,
        chosen: chosen.slice(0, choice.count),
        ...(choice.repeat ? { repeat: true } : {}),
        ...(choice.upTo !== undefined ? { upTo: choice.upTo } : {}),
      };
    }),
  );
}

/** Every skill or save choice: the picks' and the trained steps' own. Shown at the first trained step,
 *  or where the entry was picked when the builder has none. */
export function rulesetBuilderTrainedSlots(
  definition: RulesetDefinition,
  state: RulesetBuilderState,
  catalogs: RulesetCatalogEntriesById,
  /** The sheet as it stands, which a step's `upTo` reads; no limit without it. */
  build?: RulesetSheetBuild,
): RulesetBuilderTrainedSlot[] {
  const steps = definition.sheet.builder?.steps ?? [];
  const host = steps.find((step) => step.kind === "trained")?.id;
  const known = {
    skills: definition.sheet.skills.map((skill) => skill.id),
    saves: definition.sheet.saves.map((save) => save.id),
  };
  const slot = (
    key: string,
    stepId: string,
    entry: RulesetCatalogEntry | null,
    choice: { what: "skills" | "saves"; count: number; from?: string[] },
    tier: string,
  ): RulesetBuilderTrainedSlot => {
    const from = choice.from ? known[choice.what].filter((id) => choice.from!.includes(id)) : known[choice.what];
    const chosen = [...new Set(state.trainedChoices?.[key] ?? [])].filter((id) => from.includes(id));
    return {
      key,
      stepId,
      entry,
      what: choice.what,
      count: choice.count,
      from,
      chosen: chosen.slice(0, choice.count),
      tier,
    };
  };
  const granted = rulesetBuilderGranting(definition, state, catalogs, build).flatMap(({ step, entry }) =>
    (entry.grants?.trained?.choose ?? []).map((choice, index) =>
      slot(
        rulesetBuilderChoiceKey(step.id, entry.id, index),
        host ?? step.id,
        entry,
        choice,
        grantTier(definition, entry.grants, choice.what),
      ),
    ),
  );
  const own = steps.flatMap((step) =>
    step.kind === "trained"
      ? (step.choose ?? []).map((choice, index) =>
          slot(
            rulesetBuilderChoiceKey(step.id, null, index),
            step.id,
            null,
            choice,
            grantTier(definition, undefined, choice.what),
          ),
        )
      : [],
  );
  return [...granted, ...own];
}

/** Every choice of catalog entries the picks grant (1.86), shown at the first `choices` step for its
 *  catalog. Only entries that write rows are offered, since rows are all a choice puts on the sheet. An
 *  entry is never chosen twice: one chosen at an earlier slot is that slot's, and is not offered to
 *  the others, so a slot never waits on a choice nobody can make. */
export function rulesetBuilderEntrySlots(
  definition: RulesetDefinition,
  state: RulesetBuilderState,
  catalogs: RulesetCatalogEntriesById,
  /** The sheet as it stands, which a step's `upTo` reads; no limit without it. */
  build?: RulesetSheetBuild,
): RulesetBuilderEntrySlot[] {
  const steps = definition.sheet.builder?.steps ?? [];
  const taken = new Set<string>();
  const slots = rulesetBuilderGranting(definition, state, catalogs, build).flatMap(({ step, entry }) =>
    (entry.grants?.entries?.choose ?? []).map((choice, index): RulesetBuilderEntrySlot => {
      const key = rulesetBuilderChoiceKey(step.id, entry.id, index);
      const host = steps.find((each) => each.kind === "choices" && each.catalog === choice.catalog)?.id;
      const from = (catalogs[choice.catalog] ?? [])
        .filter(
          (option) =>
            (option.rows?.length ?? 0) > 0 &&
            Object.entries(choice.filters ?? {}).every(([filterId, value]) => filterHas(option, filterId, value)) &&
            (!choice.ids || choice.ids.includes(option.id)),
        )
        .map((option) => option.id);
      const chosen = [...new Set(state.entryChoices?.[key] ?? [])]
        .filter((id) => from.includes(id) && !taken.has(`${choice.catalog}/${id}`))
        .slice(0, choice.count);
      for (const id of chosen) taken.add(`${choice.catalog}/${id}`);
      return { key, stepId: host ?? step.id, entry, catalog: choice.catalog, count: choice.count, from, chosen };
    }),
  );
  // What another slot holds is not this one's to offer.
  return slots.map((slot) => {
    const elsewhere = new Set(
      slots.filter((other) => other !== slot && other.catalog === slot.catalog).flatMap((other) => other.chosen),
    );
    return { ...slot, from: slot.from.filter((id) => slot.chosen.includes(id) || !elsewhere.has(id)) };
  });
}

/** The abilities an abilities step sets. */
export function rulesetBuilderAbilityIds(definition: RulesetDefinition, step: StepOf<"abilities">): string[] {
  const all = definition.sheet.abilities.map((ability) => ability.id);
  return step.abilities ? all.filter((id) => step.abilities!.includes(id)) : all;
}

/** What point buy has spent on these scores, or null when one of them is not on the cost table. */
export function rulesetPointBuySpent(
  pointBuy: NonNullable<StepOf<"abilities">["methods"]["pointBuy"]>,
  scores: Record<string, number>,
  ids: readonly string[],
): number | null {
  let spent = 0;
  for (const id of ids) {
    const row = pointBuy.costs.find(([score]) => score === scores[id]);
    if (!row) return null;
    spent += row[1];
  }
  return spent;
}

/** The method the scores are set by: the player's, else the step's `default` (1.82) for a character the
 *  builder makes, never for one it describes; none when the step does not offer it. */
export function rulesetBuilderMethod(
  definition: RulesetDefinition,
  state: RulesetBuilderState,
): RulesetBuilderMethod | undefined {
  const step = definition.sheet.builder?.steps.find((each): each is StepOf<"abilities"> => each.kind === "abilities");
  if (!step) return undefined;
  const method = state.method ?? (state.made === "builder" && !state.describing ? step.default : undefined);
  return method && step.methods[method] ? method : undefined;
}

/** The scores the chosen method gives, before any increase. An ability the method has not set yet
 *  is left out, and keeps what the sheet has. */
export function rulesetBuilderBaseScores(
  definition: RulesetDefinition,
  state: RulesetBuilderState,
): Record<string, number> {
  const step = definition.sheet.builder?.steps.find((each): each is StepOf<"abilities"> => each.kind === "abilities");
  const method = rulesetBuilderMethod(definition, state);
  if (!step || !method) return {};
  const ids = rulesetBuilderAbilityIds(definition, step);
  const base: Record<string, number> = {};
  if (method === "pointBuy" || method === "manual") {
    const costs = step.methods.pointBuy?.costs;
    const lowest = costs?.[0]?.[0];
    const highest = costs?.[costs.length - 1]?.[0];
    for (const id of ids) {
      const value = state.base?.[id];
      if (method === "pointBuy" && lowest !== undefined && highest !== undefined) {
        // A score typed by hand and then bought starts from the nearest score on the table.
        base[id] = typeof value === "number" ? clamp(value, lowest, highest) : lowest;
      } else if (typeof value === "number") base[id] = value;
    }
    return base;
  }
  const values = method === "standardArray" ? (step.methods.standardArray ?? []) : (state.rolled ?? []);
  const taken = new Set<number>();
  for (const id of ids) {
    const index = state.assign?.[id];
    // Each value goes to one score: a second claim on it is no claim.
    if (index === undefined || taken.has(index) || values[index] === undefined) continue;
    taken.add(index);
    base[id] = values[index]!;
  }
  return base;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** The text or enum value a catalog step writes to its field for these picks, or undefined for none. */
function stepFieldValue(
  definition: RulesetDefinition,
  step: StepOf<"catalog">,
  picks: readonly RulesetCatalogEntry[],
): Scalar | undefined {
  const field = step.field ? definition.sheet.fields.find((each) => each.id === step.field) : undefined;
  if (!field || picks.length === 0) return undefined;
  if (field.type === "enum") {
    for (const entry of picks) {
      if (field.values.includes(entry.id)) return entry.id;
      if (field.values.includes(entry.label)) return entry.label;
    }
    return undefined;
  }
  if (field.type === "text" || field.type === "longtext") {
    return picks
      .map((entry) => entry.label)
      .join(", ")
      .slice(0, field.maxLength);
  }
  return undefined;
}

/** What the builder's choices come to, worked out from scratch. */
/** An increase a choice with `upTo` gives (1.91), applied after every other so it stops at its cap. */
interface CappedIncrease {
  id: string;
  by: number;
  upTo: number;
}

function desired(
  definition: RulesetDefinition,
  state: RulesetBuilderState,
  catalogs: RulesetCatalogEntriesById,
  /** The sheet as it stands, which a step's `upTo` reads; no limit without it. */
  build?: RulesetSheetBuild,
): RulesetBuilderApplied & { capped: CappedIncrease[] } {
  const out: RulesetBuilderApplied & { capped: CappedIncrease[] } = {
    increases: {},
    scores: {},
    skills: {},
    saves: {},
    fields: {},
    rows: [],
    capped: [],
  };
  const abilities = new Set(definition.sheet.abilities.map((ability) => ability.id));
  const known = {
    skills: new Set(definition.sheet.skills.map((skill) => skill.id)),
    saves: new Set(definition.sheet.saves.map((save) => save.id)),
  };
  const fieldIds = new Set(definition.sheet.fields.map((field) => field.id));
  const bump = (id: string, by: number) => {
    if (abilities.has(id)) out.increases[id] = (out.increases[id] ?? 0) + by;
  };
  const train = (what: "skills" | "saves", id: string, tier: string) => {
    if (known[what].has(id)) out[what][id] = tier;
  };
  for (const { step, entry } of rulesetBuilderGranting(definition, state, catalogs, build)) {
    const grants = entry.grants;
    for (const [id, by] of Object.entries(grants?.abilities?.add ?? {})) bump(id, by);
    for (const what of ["skills", "saves"] as const)
      for (const id of grants?.trained?.[what] ?? []) train(what, id, grantTier(definition, grants, what));
    for (const [id, value] of Object.entries(grants?.sets ?? {})) if (fieldIds.has(id)) out.fields[id] = value;
    if (entry.rows) out.rows.push(catalogRowRef(step.catalog, entry.id));
  }
  for (const step of definition.sheet.builder?.steps ?? []) {
    if (step.kind !== "catalog") continue;
    const value = stepFieldValue(definition, step, rulesetBuilderPicks(definition, step.id, state, catalogs, build));
    if (value !== undefined && step.field) out.fields[step.field] = value;
  }
  for (const slot of rulesetBuilderAbilitySlots(definition, state, catalogs, build)) {
    for (const id of slot.chosen) {
      if (slot.upTo !== undefined) {
        if (abilities.has(id)) out.capped.push({ id, by: slot.amount, upTo: slot.upTo });
      } else bump(id, slot.amount);
    }
  }
  for (const slot of rulesetBuilderTrainedSlots(definition, state, catalogs, build)) {
    for (const id of slot.chosen) train(slot.what, id, slot.tier);
  }
  for (const slot of rulesetBuilderEntrySlots(definition, state, catalogs, build)) {
    for (const id of slot.chosen) {
      const ref = catalogRowRef(slot.catalog, id);
      if (!out.rows.includes(ref)) out.rows.push(ref);
    }
  }
  return out;
}

/** Whether a build is still the ruleset's blank sheet: nothing typed, trained or listed. A character
 *  that is not was made some other way, and the builder starts by describing it. */
export function rulesetSheetBuildIsBlank(definition: RulesetDefinition, build: RulesetSheetBuild): boolean {
  const blank = defaultRulesetSheetBuild(definition);
  const same = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => a[key] === b[key]);
  return (
    same(build.abilities, blank.abilities) &&
    same(build.fields, blank.fields) &&
    Object.keys(build.skills).length === 0 &&
    Object.keys(build.saves).length === 0 &&
    Object.values(build.bonuses ?? {}).every((value) => !value) &&
    Object.values(build.lists).every((rows) => !Array.isArray(rows) || rows.length === 0)
  );
}

/** Every catalog the builder's steps read, so a caller can load them before applying anything. */
export function rulesetBuilderCatalogIds(definition: RulesetDefinition): string[] {
  const ids = (definition.sheet.builder?.steps ?? []).flatMap((step) =>
    step.kind === "catalog" || step.kind === "choices" ? [step.catalog] : [],
  );
  return [...new Set(ids)];
}

/**
 * The build with the builder's choices applied, and the state that records what was written.
 *
 * `catalogs` must hold every catalog the builder reads (`rulesetBuilderCatalogIds`): a pick whose
 * catalog is missing grants nothing, which would take back what it gave.
 */
export function applyRulesetBuilder(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  given: RulesetBuilderState,
  catalogs: RulesetCatalogEntriesById,
): { build: RulesetSheetBuild; state: RulesetBuilderState } {
  // A blank sheet the builder starts is the builder's, and keeps the method it starts on (1.82), so a
  // later change to the ruleset's default never moves its scores.
  let state = given;
  if (!state.describing && !state.made && state.applied === undefined && rulesetSheetBuildIsBlank(definition, build)) {
    state = { ...state, made: "builder" };
  }
  if (state.made === "builder" && !state.describing && !state.method) {
    const method = rulesetBuilderMethod(definition, state);
    if (method) state = { ...state, method };
  }
  // A pick can change what a step's `upTo` reads (a class that sets the level), so the builder's
  // answer is worked out again on what it wrote until it settles.
  let result = applyRulesetBuilderOnce(definition, build, state, catalogs);
  for (let pass = 0; pass < 3; pass++) {
    const again = applyRulesetBuilderOnce(definition, result.build, result.state, catalogs);
    if (JSON.stringify(again) === JSON.stringify(result)) break;
    result = again;
  }
  return result;
}

function applyRulesetBuilderOnce(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  state: RulesetBuilderState,
  catalogs: RulesetCatalogEntriesById,
): { build: RulesetSheetBuild; state: RulesetBuilderState } {
  const previous: RulesetBuilderApplied = state.applied ?? {
    increases: {},
    scores: {},
    skills: {},
    saves: {},
    fields: {},
    rows: [],
  };
  const { capped, ...want } = desired(definition, state, catalogs, build);
  /** The increase capped choices add to a score that stands at `from` before them, each stopping at
   *  its own cap and never taking away (1.91). */
  const cappedOn = (id: string, from: number) => {
    let score = from;
    for (const each of capped) {
      if (each.id !== id) continue;
      score += Math.max(0, Math.min(each.by, each.upTo - score));
    }
    return score - from;
  };
  if (state.describing) {
    // Describing: every pick's grants are recorded as given (so a later change takes them back, as far
    // as the sheet still shows them), and nothing is written, now or when describing ends.
    // A value the player changed in the builder's own fields step stays theirs to the builder.
    const fields = { ...want.fields };
    for (const [id, value] of Object.entries(previous.fields)) {
      if (id in fields && build.fields[id] === value) fields[id] = value;
    }
    // A capped increase is recorded as what it gave a score that already shows it: the largest amount,
    // up to all of it, that the cap would have let through from the score without it.
    const increases = { ...want.increases };
    for (const ability of definition.sheet.abilities) {
      const id = ability.id;
      const full = capped.filter((each) => each.id === id).reduce((sum, each) => sum + each.by, 0);
      if (full === 0) continue;
      const current = typeof build.abilities[id] === "number" ? build.abilities[id]! : ability.default;
      const uncapped = want.increases[id] ?? 0;
      let gave = 0;
      for (let x = full; x >= 0; x--) {
        if (cappedOn(id, current - uncapped - x) === x) {
          gave = x;
          break;
        }
      }
      if (uncapped + gave !== 0) increases[id] = uncapped + gave;
    }
    return { build, state: { ...state, applied: { ...want, increases, fields, scores: {} } } };
  }
  // What this run actually writes, which is all the next run takes back: a value the sheet already
  // had of the player's own is never recorded, so unpicking never takes it.
  const next: RulesetBuilderApplied = { increases: {}, scores: {}, skills: {}, saves: {}, fields: {}, rows: [] };

  // Scores: the method's base plus the increases, written when that total changes; else what the sheet
  // has, moved by the change in increases, as far as the score's bounds let it (and only that far is
  // taken back). Either way a score typed in the full form since is kept until the builder's own answer
  // for it changes.
  const base = rulesetBuilderBaseScores(definition, state);
  const abilities = { ...build.abilities };
  for (const ability of definition.sheet.abilities) {
    const id = ability.id;
    const before = previous.increases[id] ?? 0;
    const uncapped = want.increases[id] ?? 0;
    if (base[id] !== undefined) {
      const after = uncapped + cappedOn(id, base[id]! + uncapped);
      const total = clamp(base[id]! + after, ability.min, ability.max);
      next.scores[id] = total;
      next.increases[id] = total - base[id]!;
      if (previous.scores[id] !== total) abilities[id] = total;
      continue;
    }
    const current = typeof abilities[id] === "number" ? abilities[id]! : ability.default;
    const without = current - before;
    const after = uncapped + cappedOn(id, without + uncapped);
    const total = clamp(without + after, ability.min, ability.max);
    if (total - without !== 0) next.increases[id] = total - without;
    if (total !== current) abilities[id] = total;
  }

  // Training: a tier the builder gave is set when its answer changes, and taken back only while the
  // sheet still shows it; a tier the player set by hand is theirs.
  const untrained = definition.resolution.proficiencyTiers[0]!.id;
  const trained = (what: "skills" | "saves") => {
    const out = { ...build[what] };
    for (const [id, tier] of Object.entries(previous[what])) {
      if (want[what][id] === undefined && out[id] === tier) delete out[id];
    }
    for (const [id, tier] of Object.entries(want[what])) {
      const current = out[id];
      if (previous[what][id] === tier) {
        next[what][id] = tier;
        continue;
      }
      if (
        current === undefined ||
        current === untrained ||
        (previous[what][id] !== undefined && current === previous[what][id])
      ) {
        out[id] = tier;
        next[what][id] = tier;
      }
    }
    return out;
  };
  const skills = trained("skills");
  const saves = trained("saves");

  // Fields: written when the builder's answer changes, cleared when it has none and the sheet still
  // shows the old one. A field the player filled in themselves (a level 5 typed before a class was
  // picked) is never written over: only one still blank, or one the builder already answers for.
  const blankFields = defaultRulesetSheetBuild(definition).fields;
  const fields = { ...build.fields };
  for (const [id, value] of Object.entries(previous.fields)) {
    if (want.fields[id] === undefined && fields[id] === value) delete fields[id];
  }
  for (const [id, value] of Object.entries(want.fields)) {
    if (previous.fields[id] === value) next.fields[id] = value;
    // Already the answer, and only because it is the sheet's blank: the builder's from now on.
    else if (fields[id] === value && value === blankFields[id]) next.fields[id] = value;
    else if (
      fields[id] !== value &&
      (previous.fields[id] !== undefined ||
        fields[id] === undefined ||
        fields[id] === "" ||
        fields[id] === blankFields[id])
    ) {
      fields[id] = value;
      next.fields[id] = value;
    }
  }

  // Rows: an entry's rows go when it is unpicked and come when it is picked, never twice. A row the
  // player had already added from the catalog is theirs.
  let lists: RulesetSheetBuild["lists"] = { ...build.lists };
  const gone = new Set(previous.rows.filter((ref) => !want.rows.includes(ref)));
  if (gone.size > 0) {
    lists = Object.fromEntries(
      Object.entries(lists).map(([listId, rows]) => [
        listId,
        Array.isArray(rows) ? rows.filter((row) => !gone.has(String(row?.[RULESET_CATALOG_ROW_KEY] ?? ""))) : rows,
      ]),
    );
  }
  const has = (ref: string) =>
    Object.values(lists).some(
      (rows) => Array.isArray(rows) && rows.some((row) => row?.[RULESET_CATALOG_ROW_KEY] === ref),
    );
  const entriesByRef = new Map<string, RulesetCatalogEntry>();
  for (const { step, entry } of rulesetBuilderGranting(definition, state, catalogs, build)) {
    entriesByRef.set(catalogRowRef(step.catalog, entry.id), entry);
  }
  for (const slot of rulesetBuilderEntrySlots(definition, state, catalogs, build)) {
    for (const id of slot.chosen) {
      const entry = (catalogs[slot.catalog] ?? []).find((each) => each.id === id);
      if (entry) entriesByRef.set(catalogRowRef(slot.catalog, id), entry);
    }
  }
  for (const ref of want.rows) {
    if (previous.rows.includes(ref)) {
      next.rows.push(ref);
      continue;
    }
    if (has(ref)) continue;
    const entry = entriesByRef.get(ref);
    if (!entry) continue;
    const catalogId = ref.slice(0, ref.indexOf("/"));
    let wrote = false;
    for (const { list, row } of rowsFromCatalogEntry(catalogId, entry)) {
      const spec = definition.sheet.lists.find((each) => each.id === list);
      const rows = Array.isArray(lists[list]) ? lists[list]! : [];
      // A full list takes no more; the pick still counts for everything else it grants, and its rows
      // are tried again on the next change.
      if (!spec || rows.length >= spec.maxItems) continue;
      lists = { ...lists, [list]: [...rows, row] };
      wrote = true;
    }
    if (wrote) next.rows.push(ref);
  }

  return {
    build: { ...build, abilities, skills, saves, fields, lists },
    state: { ...state, applied: next },
  };
}

/** How many choices each step still waits on, by step id. A step never blocks the next: this is
 *  what its badge shows. */
export function rulesetBuilderRemaining(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  state: RulesetBuilderState,
  catalogs: RulesetCatalogEntriesById,
): Record<string, number> {
  const remaining: Record<string, number> = {};
  const add = (stepId: string, count: number) => (remaining[stepId] = (remaining[stepId] ?? 0) + Math.max(0, count));
  for (const step of definition.sheet.builder?.steps ?? []) {
    add(step.id, 0);
    if (step.kind === "catalog") {
      // Never more than the step can offer: a race with no subraces leaves nothing to choose.
      const offered = rulesetBuilderOptions(definition, step, state, catalogs, build).length;
      add(
        step.id,
        Math.min(rulesetBuilderStepCount(definition, step, build).min, offered) -
          rulesetBuilderPicks(definition, step.id, state, catalogs, build).length,
      );
    } else if (step.kind === "fields") {
      add(
        step.id,
        step.fields.filter((id) => {
          if (step.optional?.includes(id)) return false;
          const value = build.fields[id];
          return value === undefined || value === "";
        }).length,
      );
    } else if (step.kind === "abilities") {
      const method = rulesetBuilderMethod(definition, state);
      const ids = rulesetBuilderAbilityIds(definition, step);
      if (!method) add(step.id, 1);
      else if (method === "pointBuy") {
        const spent = rulesetPointBuySpent(step.methods.pointBuy!, rulesetBuilderBaseScores(definition, state), ids);
        add(step.id, spent === null || spent < step.methods.pointBuy!.budget ? 1 : 0);
      } else if (method !== "manual") {
        const base = rulesetBuilderBaseScores(definition, state);
        add(step.id, ids.filter((id) => base[id] === undefined).length);
      }
    }
  }
  for (const slot of [
    ...rulesetBuilderAbilitySlots(definition, state, catalogs, build),
    ...rulesetBuilderTrainedSlots(definition, state, catalogs, build),
    ...rulesetBuilderEntrySlots(definition, state, catalogs, build),
  ]) {
    const repeats = "repeat" in slot && !!slot.repeat;
    add(slot.stepId, (repeats ? slot.count : Math.min(slot.count, slot.from.length)) - slot.chosen.length);
  }
  return remaining;
}
