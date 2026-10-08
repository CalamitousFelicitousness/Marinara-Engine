// Starting a fight, and the small reads every later step shares.
//
// Everything a combatant can do is resolved ONCE, here: an attack row becomes a to-hit number and a
// damage roll, a catalog-marked ability row becomes what its `mechanics` says it does, and an
// opponent's block is read as it stands. The build does not move mid-fight in this kind, so nothing
// re-reads it afterwards; health, conditions and resources are the parts that change, and those are
// read through the sheet's own helpers every time they are touched. What a condition does to a
// number is added where the number is used, never written into the combatant.

import {
  RULESET_CATALOG_ROW_KEY,
  RULESET_ITEM_CHARGES_MAX,
  rulesetSheetBuildSchema,
  type RulesetCatalogEntriesById,
  type RulesetCatalogEntry,
  type RulesetCatalogItem,
  type RulesetCatalogMechanics,
  type RulesetItemUse,
  type RulesetCombat,
  type RulesetCombatAbilitySource,
  type RulesetCombatAttackSource,
  type RulesetCombatCondition,
  type RulesetCombatDistanceSource,
  type RulesetCreatureHideEntry,
  type RulesetDefinition,
  type RulesetSheetBuild,
  type RulesetTargetIs,
  type RulesetValueRef,
} from "../../schemas/ruleset.schema.js";
import type { TacticalGrid } from "../tactical-combat/types.js";
import {
  applyRulesetSheetOp,
  evaluateRulesetSheetLive,
  readRulesetLive,
  type RulesetLiveState,
  type RulesetSheetOp,
} from "../rulesets/live-state.js";
import {
  rulesetSaveAgainstMatches,
  type RulesetSaveAgainst,
  rulesetItemGateCheck,
  rulesetItemSources,
  rulesetSheetHideSources,
  type RulesetCheckSource,
} from "../rulesets/check-effects.js";
import { rulesetItemGateDifficulty, rulesetItemGateLabel } from "../rulesets/item-book.js";
import { rulesetCatalogEntriesByRef } from "../rulesets/scaled-rows.js";
import {
  lookupStepTable,
  resolveRulesetValueRef,
  resolveRulesetAbilityValues,
  rulesetCheckAdjust,
  rulesetCheckModifier,
  type EvaluatedRulesetSheet,
  type RulesetCheckTarget,
  type RulesetSheetItem,
} from "../rulesets/sheet-math.js";
import {
  findRulesetCreatureEntry,
  isRulesetPlainStatBlock,
  rulesetCreatureBlock,
  rulesetReactionAnswers,
} from "./creatures.js";
import { parseRulesetCombatDice, rollRulesetDice, rulesetCombatRoller, sumOf } from "./dice.js";
import {
  rulesetCellBlocked,
  rulesetFills,
  rulesetFootprint,
  rulesetFootprintAt,
  rulesetFootprintsSee,
  rulesetInCells,
  rulesetPositionOf,
  rulesetSpanOf,
  rulesetZoneCells,
} from "./grid.js";
import { rulesetCombatAdvantage, rulesetCombatIsPool, rulesetPoolDie, throwRulesetCombatPool } from "./pool.js";
import { rulesetPaidLevel, rulesetReactionsAt } from "./options.js";
import { RULESET_MOVE_MODES } from "./types.js";
import type {
  RulesetMoveMode,
  RulesetMoveSpeeds,
  RulesetCombatAction,
  RulesetCombatAmount,
  RulesetCombatant,
  RulesetCombatantInput,
  RulesetCombatBoard,
  RulesetCombatDamage,
  RulesetCombatDamageAlternative,
  RulesetCombatDamageClause,
  RulesetCombatMode,
  RulesetCombatEvent,
  RulesetCombatRider,
  RulesetCombatRoller,
  RulesetCombatSoak,
  RulesetCombatZone,
  RulesetEncounterState,
  RulesetStatBlockAction,
  RulesetStatBlock,
} from "./types.js";

/** The dice of a catalog entry's `amount`, which the schema already holds to `<count>d<sides>`. */
function amountOf(amount: RulesetCatalogMechanics["amount"]): RulesetCombatAmount | null {
  if (!amount) return null;
  const dice = amount.dice ? parseRulesetCombatDice(amount.dice) : null;
  if (!dice && amount.flat === undefined) return null;
  return {
    count: dice?.count ?? 0,
    sides: dice?.sides ?? 0,
    flat: (dice?.flat ?? 0) + (amount.flat ?? 0),
  };
}

// ── Reading a combatant ──

export function rulesetCombatant(state: RulesetEncounterState, id: string): RulesetCombatant | undefined {
  return state.combatants.find((combatant) => combatant.id === id);
}

export function currentRulesetActor(state: RulesetEncounterState): RulesetCombatant | undefined {
  const id = state.order[state.turn];
  return id === undefined ? undefined : rulesetCombatant(state, id);
}

/** Whether it is this combatant's own turn, which is where a cap on attacks a turn counts. */
export function rulesetOnOwnTurn(state: RulesetEncounterState, combatant: RulesetCombatant): boolean {
  return state.order[state.turn] === combatant.id;
}

/** Whether an action is an attack, as a cap on attacks counts them: it rolls to hit, it is a sequence
 *  of them, or it is a contest that takes the place of a strike (a grapple, a shove). */
export function rulesetIsAttack(action: RulesetCombatAction): boolean {
  return action.toHit !== undefined || !!action.sequence || !!action.contest?.strike;
}

export interface RulesetCombatHealth {
  value: number;
  max: number;
  temp: number;
}

/**
 * Health as it stands. A party member's lives in their sheet, so it is read from there every time
 * rather than copied into the encounter, and a reload mid-fight is exact.
 *
 * A WOUND TRACK is reported as the levels it has LEFT: `value` is how many boxes are still clear
 * and `max` is the track's length. That is deliberate and it is what keeps the rest of the fight
 * written in its own words: "down" is a combatant at zero, and a full track is a combatant with no
 * boxes left, so `dropToZero`, the dying rules, the recap and the screen all keep asking the one
 * question they already ask. A track carries no buffer, so `temp` is always 0 on one.
 */
export function rulesetCombatHealth(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
): RulesetCombatHealth {
  // A copy, always: an opponent's health lives in the state, and a caller that read it before a
  // blow has to still be holding what it was before. An opponent without a sheet is written in
  // plain numbers whichever shape the party's health takes; one with a sheet is read below, exactly
  // as a party member is.
  if (!combatant.sheet)
    return halvedHealth(definition, combat, combatant, { ...(combatant.health ?? { value: 0, max: 0, temp: 0 }) });
  const live = readRulesetLive(definition, combatant.sheet.build, combatant.sheet.live);
  const health = combat.health;
  if ("track" in health) {
    const track = live.tracks.find((entry) => entry.id === health.track);
    if (!track?.wound) return { value: 0, max: 0, temp: 0 };
    return { value: track.wound.levels.length - track.wound.filled, max: track.wound.levels.length, temp: 0 };
  }
  const pool = live.pools.find((entry) => !entry.listId && entry.key === health.pool);
  return pool
    ? halvedHealth(definition, combat, combatant, { value: pool.value, max: pool.max, temp: pool.temp })
    : { value: 0, max: 0, temp: 0 };
}

/** Health in points as what the holder suffers halves its maximum (1.110), 5e's fourth level of
 *  exhaustion: the maximum rounded down, never below 1, and what they have held to it. A wound track
 *  has boxes rather than a maximum, so nothing halves it. */
function halvedHealth(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
  health: RulesetCombatHealth,
): RulesetCombatHealth {
  const halves = rulesetConditionModifiers(definition, combat, combatant, "health-max").length;
  if (halves === 0 || health.max <= 0) return health;
  const max = Math.max(1, Math.floor(health.max / 2 ** halves));
  return { ...health, max, value: Math.min(health.value, max) };
}

/**
 * Where a combatant's size sits among `combat.sizes`, 0 for the smallest (Capability API 1.98), or
 * undefined when the ruleset has no sizes or nothing says this one's.
 */
export function rulesetSizeRank(combat: RulesetCombat, combatant: RulesetCombatant): number | undefined {
  if (!combat.sizes || combatant.size === undefined) return undefined;
  const rank = combat.sizes.order.findIndex((size) => size.id === combatant.size);
  return rank < 0 ? undefined : rank;
}

/** A size read off a sheet: 1 is the first of `combat.sizes`, rounded and held to the list. */
function sheetSize(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  build: RulesetSheetBuild,
  evaluated: Parameters<typeof resolveRulesetValueRef>[3],
): string | undefined {
  const sizes = combat.sizes;
  if (!sizes) return undefined;
  if (!sizes.sheet) return sizes.default;
  const read = Math.round(resolveRulesetValueRef(definition, build, sizes.sheet, evaluated));
  if (!Number.isFinite(read) || read < 1) return sizes.default;
  return sizes.order[Math.min(read, sizes.order.length) - 1]!.id;
}

/**
 * The damage an action deals as it stands now (Capability API 1.97). A creature's action may name
 * amounts it deals instead of its first while something holds, the first that holds winning: a
 * `twoHanded` one unless the creature carries a shield, a `selfHealthAtMost` one while its health is
 * at most that share of its most (a wound track counts the levels it has left). Only the dice and
 * the flat part change; the type, the clauses, the qualities and the rest stay the action's own.
 * Damage with no alternative that holds comes back as it was given.
 */
export function rulesetDamageInEffect(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  actor: RulesetCombatant,
  damage: RulesetCombatDamage,
): RulesetCombatDamage {
  if (!damage.alternatives?.length) return damage;
  let share: number | undefined;
  const holds = (when: RulesetCombatDamageAlternative["when"]) => {
    if (when === "twoHanded") return !actor.block?.shield;
    if (share === undefined) {
      const health = rulesetCombatHealth(definition, combat, actor);
      share = health.max > 0 ? health.value / health.max : 1;
    }
    return share <= when.selfHealthAtMost;
  };
  const chosen = damage.alternatives.find((alternative) => holds(alternative.when));
  return chosen ? { ...damage, count: chosen.count, sides: chosen.sides, flat: chosen.flat } : damage;
}

/**
 * Which kind of mark this fight's damage is, on a ruleset whose health is a wound track.
 *
 * The mapping is the ruleset's own and nothing here guesses: a type it names lands as the kind it
 * named, and everything else, a blow with no type included, lands as the declared `default`. The
 * match ignores case, exactly as a creature's resistances and the block's own `damageTypes` do.
 *
 * The empty string is returned only for a ruleset whose health is a pool, where nobody asks.
 */
export function rulesetCombatDamageKind(combat: RulesetCombat, damageType: string | undefined): string {
  const kinds = combat.damageKinds;
  if (!kinds) return "";
  const wanted = damageType?.trim().toLowerCase();
  if (!wanted) return kinds.default;
  for (const [type, kind] of Object.entries(kinds.byType ?? {})) {
    if (type.trim().toLowerCase() === wanted) return kind;
  }
  return kinds.default;
}

/** One command through the sheet's own rules. A refusal changes nothing and says so, exactly as it
 *  does for the player's own buttons and the Game Master's commands. */
export function writeRulesetSheet(
  definition: RulesetDefinition,
  combatant: RulesetCombatant,
  op: RulesetSheetOp,
): boolean {
  if (!combatant.sheet) return false;
  const result = applyRulesetSheetOp(definition, combatant.sheet.build, combatant.sheet.live, op);
  if (!result.ok) return false;
  combatant.sheet.live = result.live;
  return true;
}

/** Every condition on this combatant. A party member's are the sheet's own, so one they walked into
 *  the fight with counts from the first turn and one the fight applied is still there afterwards. */
export function rulesetCombatConditions(definition: RulesetDefinition, combatant: RulesetCombatant): string[] {
  const ids = new Set(combatant.tracked.map((entry) => entry.condition));
  if (combatant.sheet) {
    const live = readRulesetLive(definition, combatant.sheet.build, combatant.sheet.live);
    for (const condition of live.conditions) if (condition.active) ids.add(condition.id);
  }
  return [...ids];
}

/**
 * Whether whoever put this condition on somebody is still in their sight.
 *
 * A condition nobody applied, one whose source has left the fight, and every fight with no board at
 * all all read as "yes": a fight that measures nothing has no line for anything to break.
 */
function sourceInSight(
  combatant: RulesetCombatant,
  condition: string,
  state: RulesetEncounterState | undefined,
): boolean {
  const sourceId = combatant.tracked.find((entry) => entry.condition === condition)?.source;
  const grid = state?.board?.grid;
  if (!sourceId || !state || !grid) return true;
  const source = rulesetCombatant(state, sourceId);
  if (!source || !rulesetPositionOf(combatant) || !rulesetPositionOf(source)) return true;
  // Any cell of one to any cell of the other (1.189).
  return rulesetFootprintsSee(grid, combatant, source);
}

/**
 * The condition entries that are ON this combatant right now, with their gates read.
 *
 * One place, because everything a condition does reads it: what it stops, what it makes harder, and
 * which saves it is about. `state` is what a gate that measures anything needs; without it a gated
 * condition simply counts, which is what it does in a fight with no board anyway.
 */
export function rulesetActiveConditions(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
  state?: RulesetEncounterState,
  rawLevels = false,
): RulesetActiveCondition[] {
  const active = new Set(rulesetCombatConditions(definition, combatant));
  // Standing in a zone that says so (1.174): its conditions are on whoever is there, and what it
  // keeps off or stops reads as one more source, named for the zone.
  const inside = state ? zonesStoodIn(state, combatant) : [];
  for (const { rule } of inside) for (const condition of rule.inside?.conditions ?? []) active.add(condition);
  const zoned = inside.flatMap(({ label, rule }): RulesetActiveCondition[] =>
    rule.inside?.immune || rule.forbids
      ? [
          {
            condition: label,
            zone: true,
            effects: [],
            ...(rule.inside?.immune ? { immune: [...rule.inside.immune] } : {}),
            ...(rule.forbids ? { forbids: { components: [...rule.forbids.components] } } : {}),
          },
        ]
      : [],
  );
  const conditions = (combat.conditions ?? []).flatMap((entry): RulesetActiveCondition[] => {
    if (!active.has(entry.condition)) return [];
    const gate = entry.whileSourceInSight;
    if (!gate || sourceInSight(combatant, entry.condition, state)) return [entry];
    // Out of sight: `true` takes the whole condition off, and a list takes off only what it names,
    // so an effect nobody has to see to suffer stays.
    if (gate === true) return [];
    // A list gates the effects it NAMES and nothing else. `failsSaves` and `saves` are not effects
    // and were never named, so the entry stays even when the gate took every effect it had: a
    // fright you fail a save against whether or not you can see it is exactly what the list is for.
    return [{ ...entry, effects: entry.effects.filter((effect) => !gate.includes(effect)) }];
  });
  const levels = combat.levels?.length ? activeLevels(definition, combat, combatant, rawLevels) : [];
  // And what the fighter's items do, each named for the stack, as a level is named for its track.
  const items = heldSources(definition, combatant).map((source): RulesetActiveCondition => ({
    condition: source.name,
    item: true,
    effects: [...(source.effects ?? [])] as RulesetCombatCondition["effects"],
    ...(source.modifiers ? { modifiers: [...source.modifiers] } : {}),
    ...(source.failsSaves ? { failsSaves: [...source.failsSaves] } : {}),
    ...(source.saves ? { saves: [...source.saves] } : {}),
    ...(source.skills ? { skills: [...source.skills] } : {}),
    ...(source.resist ? { resist: [...source.resist] } : {}),
    ...(source.vulnerable ? { vulnerable: [...source.vulnerable] } : {}),
    ...(source.immune ? { immune: [...source.immune] } : {}),
    ...(source.conditionImmunities ? { conditionImmunities: [...source.conditionImmunities] } : {}),
    ...(source.senses ? { senses: { ...source.senses } } : {}),
  }));
  return [...conditions, ...levels, ...items, ...zoned];
}

/** The standing zones whose cells this combatant is in now, or that hold them off a board (1.174). */
function zonesStoodIn(
  state: RulesetEncounterState,
  combatant: RulesetCombatant,
): Array<{
  key: string;
  label: string;
  rule: NonNullable<RulesetCombatAction["zone"]>;
  caster: RulesetCombatant;
  zone: RulesetCombatZone;
}> {
  const at = rulesetPositionOf(combatant);
  const grid = state.board?.grid;
  return state.combatants.flatMap((caster) =>
    (caster.zones ?? []).flatMap((zone) => {
      const rule = caster.actions.find((entry) => entry.id === zone.actionId)?.zone;
      if (!rule || (!rule.inside && !rule.forbids && !rule.wards)) return [];
      // Any cell they fill (1.189).
      const inIt =
        grid && at
          ? rulesetZoneCells(state, caster, zone).some((cell) => rulesetFills(combatant, cell))
          : !!zone.held?.includes(combatant.id);
      return inIt ? [{ key: `${caster.id}/${zone.actionId}`, label: zone.label, rule, caster, zone }] : [];
    }),
  );
}

/** The conditions standing zones put on this combatant now (1.174): Silence's deafened. */
export function rulesetZoneConditions(state: RulesetEncounterState, combatant: RulesetCombatant): string[] {
  return [...new Set(zonesStoodIn(state, combatant).flatMap(({ rule }) => rule.inside?.conditions ?? []))];
}

/** The zones warding whoever stands in them (1.174), each by its caster and action, with what it
 *  keeps out. */
export function rulesetWardsOn(
  state: RulesetEncounterState,
  combatant: RulesetCombatant,
): Array<{
  key: string;
  wards: NonNullable<NonNullable<RulesetCombatAction["zone"]>["wards"]>;
  caster: RulesetCombatant;
  zone: RulesetCombatZone;
}> {
  return zonesStoodIn(state, combatant).flatMap(({ key, rule, caster, zone }) =>
    rule.wards ? [{ key, wards: rule.wards, caster, zone }] : [],
  );
}

/** A condition can take away a sense an effect needs (1.122), so its holder is left out entirely. */
export function rulesetTargetHasSenses(
  definition: RulesetDefinition,
  state: RulesetEncounterState,
  target: RulesetCombatant,
  needs: readonly string[] | undefined,
): boolean {
  const combat = definition.combat;
  if (!combat || !needs?.length) return true;
  return !rulesetActiveConditions(definition, combat, target, state).some((entry) =>
    entry.lacks?.some((sense) => needs.includes(sense)),
  );
}

/** What a combatant is (1.163): a creature's own type and tags, or else a character's type read off
 *  `combat.creatureTypes.field`, or the ruleset's `default`. Nothing without creature types. */
export function rulesetCreatureKind(
  definition: RulesetDefinition,
  combatant: RulesetCombatant,
): { type?: string; tags: string[] } {
  const kinds = definition.combat?.creatureTypes;
  if (!kinds) return { tags: [] };
  const block = combatant.block;
  if (block?.type !== undefined || block?.tags) {
    return { ...(block.type !== undefined ? { type: block.type } : {}), tags: [...(block.tags ?? [])] };
  }
  if (!combatant.sheet) return { tags: [] };
  const read = kinds.field ? combatant.sheet.build.fields?.[kinds.field] : undefined;
  const type = typeof read === "string" && kinds.types.some((one) => one.id === read) ? read : kinds.default;
  return { ...(type !== undefined ? { type } : {}), tags: [] };
}

/** Whether a combatant is what a target test asks (1.163): any of its types or tags. No test passes. */
export function rulesetTargetIs(
  definition: RulesetDefinition,
  combatant: RulesetCombatant,
  test: RulesetTargetIs | undefined,
): boolean {
  if (!test) return true;
  const kind = rulesetCreatureKind(definition, combatant);
  return (
    (kind.type !== undefined && !!test.types?.includes(kind.type)) ||
    kind.tags.some((tag) => !!test.tags?.includes(tag))
  );
}

/** Whether an action may be pointed at or catch this combatant, by what it is (1.163). */
export function rulesetTargetTypesAllow(
  definition: RulesetDefinition,
  combatant: RulesetCombatant,
  targetTypes:
    | {
        is?: RulesetTargetIs;
        not?: RulesetTargetIs;
        abilityAtMost?: Record<string, number>;
        abilityAtLeast?: Record<string, number>;
        notImmuneTo?: string[];
      }
    | undefined,
): boolean {
  if (!targetTypes) return true;
  if (targetTypes.is && !rulesetTargetIs(definition, combatant, targetTypes.is)) return false;
  if (targetTypes.not && rulesetTargetIs(definition, combatant, targetTypes.not)) return false;
  // Its ability scores at most these (1.180); a score nobody wrote down keeps nobody out.
  for (const [ability, most] of Object.entries(targetTypes.abilityAtMost ?? {})) {
    const score = rulesetAbilityScore(definition, combatant, ability);
    if (score !== undefined && score > most) return false;
  }
  // And at least these (1.186), read the same way.
  for (const [ability, least] of Object.entries(targetTypes.abilityAtLeast ?? {})) {
    const score = rulesetAbilityScore(definition, combatant, ability);
    if (score !== undefined && score < least) return false;
  }
  // And not immune to any of these conditions (1.180).
  if (targetTypes.notImmuneTo?.length) {
    const immune = rulesetCombatHide(definition, combatant).conditionImmunities.map((id) => id.trim().toLowerCase());
    if (targetTypes.notImmuneTo.some((id) => immune.includes(id.trim().toLowerCase()))) return false;
  }
  return true;
}

/** One of a combatant's ability scores (1.180): off their sheet, or as their stat block writes it.
 *  Undefined for a creature written without it. */
export function rulesetAbilityScore(
  definition: RulesetDefinition,
  combatant: RulesetCombatant,
  ability: string,
): number | undefined {
  if (combatant.sheet) {
    if (!definition.sheet.abilities.some((entry) => entry.id === ability)) return undefined;
    return resolveRulesetValueRef(definition, combatant.sheet.build, { abilityScore: ability } as RulesetValueRef);
  }
  return combatant.block?.abilities?.[ability];
}

/** What a fighter's items do, as they hold them in this fight: see `rulesetItemSources`. A requirement
 *  reads the sheet with the live state as it stands. Nothing for a fighter with no sheet or no items. */
function heldSources(definition: RulesetDefinition, combatant: RulesetCombatant): RulesetCheckSource[] {
  const sheet = combatant.sheet;
  if (!sheet?.items?.length) return [];
  let evaluated: EvaluatedRulesetSheet | undefined;
  return rulesetItemSources(
    definition,
    sheet.build,
    sheet.items,
    () => (evaluated ??= evaluateRulesetSheetLive(definition, sheet.build, sheet.live, sheet.items)),
  );
}

/** What a fighter's hide is made of, including conditions, levels and sheet rows (Capability API 1.127). */
export function rulesetCombatHide(
  definition: RulesetDefinition,
  combatant: RulesetCombatant,
  state?: RulesetEncounterState,
  rawLevels = false,
): {
  resist: RulesetCreatureHideEntry[];
  vulnerable: string[];
  immune: RulesetCreatureHideEntry[];
  conditionImmunities: string[];
} {
  const sources = definition.combat
    ? rulesetActiveConditions(definition, definition.combat, combatant, state, rawLevels)
    : heldSources(definition, combatant);
  const all = [...sources, ...(combatant.sheet ? rulesetSheetHideSources(definition, combatant.sheet.build) : [])];
  return {
    resist: [...(combatant.block?.resist ?? []), ...all.flatMap((source) => source.resist ?? [])],
    vulnerable: [...(combatant.block?.vulnerable ?? []), ...all.flatMap((source) => source.vulnerable ?? [])],
    immune: [...(combatant.block?.immune ?? []), ...all.flatMap((source) => source.immune ?? [])],
    conditionImmunities: [
      ...(combatant.block?.conditionImmunities ?? []),
      ...all.flatMap((source) => source.conditionImmunities ?? []),
    ],
  };
}

/** A condition entry that is on somebody right now: one of the fight's own conditions, a level of a
 *  live track or a derived value, or what an item does, each of which reads exactly like one. `level`
 *  is set only on a level, whose `condition` is then the track's id, or the derived value's where
 *  `derived` is set (the two may share an id). `item` is set on an item's, whose `condition` is then
 *  the stack's name. */
export type RulesetActiveCondition = RulesetCombatCondition & {
  level?: number;
  derived?: true;
  item?: true;
  /** A level that takes its holder out of the fight (1.110). */
  defeats?: true;
  /** What standing in a zone does (1.174), named for the zone. */
  zone?: true;
};

/** The levels of the holder's own tracks, and of their derived values, that are reached. A sheet has
 *  both; a combatant written in plain numbers has only the tracks it was given (1.110). A derived
 *  value is worked out with the live state as it stands and what they held as the fight began. A
 *  track the holder is immune to has no levels on them at all. */
function activeLevels(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
  rawLevels = false,
): RulesetActiveCondition[] {
  if (!combat.levels?.length) return [];
  const sheet = combatant.sheet;
  if (!sheet && !combatant.tracks) return [];
  const live = sheet ? readRulesetLive(definition, sheet.build, sheet.live) : undefined;
  let derived: Record<string, number> | undefined;
  // Even the non-recursive read must honor the creature's and items' existing track immunities.
  const baseImmunities = rawLevels
    ? [
        ...(combatant.block?.conditionImmunities ?? []),
        ...heldSources(definition, combatant).flatMap((source) => source.conditionImmunities ?? []),
      ].map((id) => id.trim().toLowerCase())
    : [];
  return combat.levels.flatMap((level) => {
    if (level.derived !== undefined && !sheet) return [];
    if (
      level.track !== undefined &&
      (rawLevels
        ? baseImmunities.includes(level.track.trim().toLowerCase())
        : rulesetImmuneToCondition(combatant, level.track, definition))
    )
      return [];
    const value =
      level.derived !== undefined
        ? ((derived ??= evaluateRulesetSheetLive(definition, sheet!.build, sheet!.live, sheet!.items).derived)[
            level.derived
          ] ?? 0)
        : live
          ? (live.tracks.find((track) => track.id === level.track)?.value ?? 0)
          : (combatant.tracks?.[level.track!] ?? 0);
    if (value < level.at) return [];
    return [
      {
        ...(level.resist ? { resist: level.resist } : {}),
        ...(level.vulnerable ? { vulnerable: level.vulnerable } : {}),
        ...(level.immune ? { immune: level.immune } : {}),
        ...(level.conditionImmunities ? { conditionImmunities: level.conditionImmunities } : {}),
        condition: level.track ?? level.derived!,
        level: level.at,
        ...(level.derived !== undefined ? { derived: true as const } : {}),
        effects: level.effects,
        ...(level.modifiers ? { modifiers: level.modifiers } : {}),
        ...(level.failsSaves ? { failsSaves: level.failsSaves } : {}),
        ...(level.saves ? { saves: level.saves } : {}),
        ...(level.skills ? { skills: level.skills } : {}),
        ...(level.defeats ? { defeats: true as const } : {}),
      },
    ];
  });
}

/** One number one condition changes, with the condition it came from. */
export interface RulesetConditionModifier {
  condition: string;
  level?: number;
  derived?: true;
  item?: true;
  modifier: NonNullable<RulesetCombatCondition["modifiers"]>[number];
}

/**
 * Everything this combatant's conditions (and levels) do to one number. For a save, a change that
 * names its saves (its own, else its condition's) changes only those; everything else it changes
 * whatever the roll is for. A change to checks narrowed to some skills reaches a fight only on a check
 * that names one of them (an item's gate), since its contests roll the fight's own checks; a change
 * that only rolls twice adds nothing here.
 */
export function rulesetConditionModifiers(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
  to: NonNullable<RulesetCombatCondition["modifiers"]>[number]["to"],
  state?: RulesetEncounterState,
  /** The save rolled, for modifiers to saves; the skill rolled, for modifiers to checks, so what is
   *  narrowed to it counts (a contest names none, and reads only what is narrowed to nothing). */
  save?: string,
  against?: RulesetSaveAgainst,
  /** The ability an attack or a check is made with (1.183), so what is narrowed to it counts; with
   *  none, a change narrowed to an ability reads nothing. */
  ability?: string,
): RulesetConditionModifier[] {
  // A ruleset with no items and no condition or level that changes a number has nothing to read. One
  // with items reads them once, below, with everything else that is on the combatant.
  if (
    !definition.items &&
    !combat.conditions?.some((entry) => entry.modifiers) &&
    !combat.levels?.some((level) => level.modifiers)
  ) {
    return [];
  }
  return rulesetActiveConditions(definition, combat, combatant, state).flatMap((entry) => {
    return (entry.modifiers ?? [])
      .filter((modifier) => {
        if (modifier.to !== to || !rulesetSaveAgainstMatches(modifier.against, against)) return false;
        if (
          modifier.flat === undefined &&
          modifier.dice === undefined &&
          modifier.times === undefined &&
          modifier.diceTimes === undefined
        )
          return false;
        const skills = modifier.skills ?? entry.skills;
        if (to === "checks" && skills && !(save !== undefined && skills.includes(save))) return false;
        if (!rulesetAbilityNarrowing(modifier, to, ability)) return false;
        const saves = modifier.saves ?? entry.saves;
        return !(to === "saves" && save !== undefined && saves && !saves.includes(save));
      })
      .map((modifier) => ({
        condition: entry.condition,
        ...(entry.level !== undefined ? { level: entry.level } : {}),
        ...(entry.derived ? { derived: entry.derived } : {}),
        ...(entry.item ? { item: entry.item } : {}),
        modifier,
      }));
  });
}

/** What those conditions DO, as the closed effect list. */
export function rulesetCombatEffects(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
  state?: RulesetEncounterState,
): Set<string> {
  const effects = new Set<string>();
  for (const entry of rulesetActiveConditions(definition, combat, combatant, state)) {
    for (const effect of entry.effects) effects.add(effect);
  }
  return effects;
}

/** Whether a condition makes this save fail without rolling. */
export function rulesetCombatFailsSave(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
  save: string,
  state?: RulesetEncounterState,
): boolean {
  return rulesetActiveConditions(definition, combat, combatant, state).some(
    (entry) => entry.failsSaves?.includes(save) === true,
  );
}

/** How this combatant's own saves are rolled: the conditions on them, narrowed to the ones that
 *  are about THIS save, with advantage and disadvantage cancelling each other out exactly as they
 *  do on an attack. A ruleset that never rolls twice keeps its single roll. */
export function rulesetSaveMode(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
  save: string,
  state?: RulesetEncounterState,
  against?: RulesetSaveAgainst,
  /** What the save itself says about who rolls it twice (1.180): Sunbeam, against an undead. */
  lean?: "advantage" | "disadvantage",
): "normal" | "advantage" | "disadvantage" {
  if (!rulesetCombatAdvantage(combat)) return "normal";
  let advantage = lean === "advantage";
  let disadvantage = lean === "disadvantage";
  for (const entry of rulesetActiveConditions(definition, combat, combatant, state)) {
    // A change to saves that rolls twice counts like the effect, narrowed by its own saves first.
    for (const modifier of entry.modifiers ?? []) {
      const saves = modifier.saves ?? entry.saves;
      if (modifier.to !== "saves" || !modifier.mode || (saves && !saves.includes(save))) continue;
      if (!rulesetSaveAgainstMatches(modifier.against, against)) continue;
      if (modifier.mode === "advantage") advantage = true;
      else disadvantage = true;
    }
    if (entry.saves && !entry.saves.includes(save)) continue;
    if (entry.effects.includes("own-saves-advantage")) advantage = true;
    if (entry.effects.includes("own-saves-disadvantage")) disadvantage = true;
  }
  // Dodging is not only about being harder to hit: where the ruleset says so, the saves that are
  // about getting out of the way are rolled with advantage too, for as long as the dodge lasts.
  if (combatant.flags.dodging && combat.standardEffects?.dodge?.saves.includes(save)) advantage = true;
  if (advantage === disadvantage) return "normal";
  return advantage ? "advantage" : "disadvantage";
}

/** Whether a change narrowed to an ability reaches a roll made with this one (1.183): attacks by
 *  `ability`, checks by `abilities`. A roll that names no ability reaches only what is not narrowed. */
export function rulesetAbilityNarrowing(
  modifier: { to: string; ability?: string; abilities?: string[] },
  to: string,
  ability: string | undefined,
): boolean {
  if (to === "attacks" && modifier.ability !== undefined) return modifier.ability === ability;
  if (to === "checks" && modifier.abilities) return ability !== undefined && modifier.abilities.includes(ability);
  return true;
}

/** The ability a check is made with (1.183): an ability by its own id, a skill's ability, or the one
 *  a fight's check reads its number off. Nothing when none of them says. */
export function rulesetCheckAbility(definition: RulesetDefinition, check: string | undefined): string | undefined {
  if (!check) return undefined;
  const { sheet } = definition;
  if (sheet.abilities.some((ability) => ability.id === check)) return check;
  const skill = sheet.skills.find((entry) => entry.id === check);
  if (skill) return skill.ability;
  const value = definition.combat?.checks?.find((entry) => entry.id === check)?.value as
    { abilityMod?: string; skillMod?: string } | undefined;
  if (value?.abilityMod) return value.abilityMod;
  return value?.skillMod ? sheet.skills.find((entry) => entry.id === value.skillMod)?.ability : undefined;
}

/** The ability an item's gate is rolled with (1.183): a raw ability check's own, or a skill's as it is
 *  rolled. A value off the sheet names none. */
function gateAbility(target: RulesetCheckTarget | null | undefined): string | undefined {
  if (target?.type === "ability") return target.id;
  return target?.type === "skill" ? (target.withAbility ?? target.ability) : undefined;
}

/** How this combatant's own side of a contest is thrown: the check effects of their conditions and
 *  their changes to checks that roll twice, cancelling each other out as they do on an attack. What is
 *  narrowed to some skills stays out, since a contest rolls the fight's own checks. A ruleset that never
 *  rolls twice keeps its single throw. */
export function rulesetCheckMode(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
  state?: RulesetEncounterState,
  /** The skill rolled, where a check names one (an item's gate), so what is narrowed to it counts. */
  skill?: string,
  /** The ability the check is made with (1.183), so what is narrowed to it counts. */
  ability?: string,
): "normal" | "advantage" | "disadvantage" {
  if (!rulesetCombatAdvantage(combat)) return "normal";
  let advantage = false;
  let disadvantage = false;
  const narrowedAway = (skills: readonly string[] | undefined) =>
    !!skills && !(skill !== undefined && skills.includes(skill));
  for (const entry of rulesetActiveConditions(definition, combat, combatant, state)) {
    for (const modifier of entry.modifiers ?? []) {
      if (modifier.to !== "checks" || !modifier.mode || narrowedAway(modifier.skills ?? entry.skills)) continue;
      if (!rulesetAbilityNarrowing(modifier, "checks", ability)) continue;
      if (modifier.mode === "advantage") advantage = true;
      else disadvantage = true;
    }
    if (narrowedAway(entry.skills)) continue;
    if (entry.effects.includes("own-checks-advantage")) advantage = true;
    if (entry.effects.includes("own-checks-disadvantage")) disadvantage = true;
  }
  if (advantage === disadvantage) return "normal";
  return advantage ? "advantage" : "disadvantage";
}

/** A combatant who can still be acted on and still take a turn. */
export function rulesetCombatStanding(combatant: RulesetCombatant): boolean {
  return !combatant.defeated && !combatant.down;
}

// ── Building what a combatant can do ──

const ABILITY_COLUMN_MISS = 0;

/**
 * What `resolution.adjust` adds to one roll a fight makes, as it adds to a check: every entry meant for
 * all rolls, and every one limited to an ability the roll is made with. `rolled` is that roll, a check
 * target or the value reference its number is. A reference to an ability's modifier or score, a
 * skill's or a save's is a roll made with that ability; any other takes only the entries for all rolls.
 */
function fightAdjust(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  evaluated: EvaluatedRulesetSheet,
  rolled: RulesetCheckTarget | RulesetValueRef | null | undefined,
): number {
  if (!definition.resolution.adjust?.length) return 0;
  const target = rolled && "type" in rolled ? rolled : refTarget(definition, build, rolled);
  return rulesetCheckAdjust(definition, build, evaluated, target);
}

/** The roll a value reference stands for, where it stands for one. */
function refTarget(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  ref: RulesetValueRef | null | undefined,
): RulesetCheckTarget | null {
  if (!ref) return null;
  const field = ref.abilityModFromField !== undefined ? build.fields?.[ref.abilityModFromField] : undefined;
  const abilityId = ref.abilityMod ?? ref.abilityScore ?? (typeof field === "string" ? field : undefined);
  if (abilityId !== undefined) {
    const ability = definition.sheet.abilities.find((entry) => entry.id === abilityId);
    return ability ? { type: "ability", id: ability.id, label: ability.label } : null;
  }
  const trained = ref.skillMod
    ? { type: "skill" as const, entry: definition.sheet.skills.find((skill) => skill.id === ref.skillMod) }
    : ref.saveMod
      ? { type: "save" as const, entry: definition.sheet.saves.find((save) => save.id === ref.saveMod) }
      : null;
  if (!trained?.entry) return null;
  const { entry } = trained;
  return { type: trained.type, id: entry.id, label: entry.label, ...(entry.ability ? { ability: entry.ability } : {}) };
}

function columnValue(row: Record<string, unknown>, column: string | undefined): unknown {
  if (column === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(row, column) ? row[column] : undefined;
}

/** An ability modifier named by one cell of the row. A value that is not an ability id adds
 *  nothing, exactly as `abilityModFromField` reads one. */
function abilityFromColumn(evaluated: EvaluatedRulesetSheet, row: Record<string, unknown>, column?: string): number {
  const value = columnValue(row, column);
  return typeof value === "string" ? (evaluated.abilityMods[value] ?? ABILITY_COLUMN_MISS) : ABILITY_COLUMN_MISS;
}

function numberFromColumn(row: Record<string, unknown>, column?: string): number {
  const value = columnValue(row, column);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textFromColumn(row: Record<string, unknown>, column?: string): string | undefined {
  const value = columnValue(row, column);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * One distance of an attack row, in cells: the number in its own column, or the same number on
 * every row. Read only when the fight has a cell size to measure it in.
 *
 * Zero is "this row does not carry that distance", which is what a number column on a sheet reads
 * as when the player left it alone: a sword is not thrown because its range column says 0, and a
 * weapon with no long distance has 0 in that column rather than a second row.
 */
function distanceInCells(
  source: RulesetCombatDistanceSource | undefined,
  row: Record<string, unknown>,
  perCell: number | undefined,
): number | undefined {
  if (!source || perCell === undefined) return undefined;
  const value = "const" in source ? source.const : columnValue(row, source.column);
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return rulesetInCells(value, perCell);
}

/** What a row adds to hit from its ability and skill columns. A skill adds what a check of that skill
 *  adds, with the row's own ability in place of the skill's when it names one, exactly as a check's
 *  `with=` swaps it; without a skill, the ability alone. A value that names neither adds nothing. */
function rowAbilityAndSkill(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  source: RulesetCombatAttackSource,
  row: Record<string, unknown>,
  evaluated: EvaluatedRulesetSheet,
): number {
  return abilityAndSkill(
    definition,
    build,
    evaluated,
    columnValue(row, source.toHit.skill?.column),
    columnValue(row, source.toHit.ability?.column),
  );
}

/** What an attack adds to hit from one skill and one ability, each an id or anything else, which
 *  names nothing: see `rowAbilityAndSkill`. */
function abilityAndSkill(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  evaluated: EvaluatedRulesetSheet,
  skillId: unknown,
  ability: unknown,
): number {
  const skill = typeof skillId === "string" ? definition.sheet.skills.find((entry) => entry.id === skillId) : undefined;
  if (!skill) {
    const named =
      typeof ability === "string" ? definition.sheet.abilities.find((entry) => entry.id === ability) : undefined;
    return (
      (named ? (evaluated.abilityMods[named.id] ?? ABILITY_COLUMN_MISS) : ABILITY_COLUMN_MISS) +
      fightAdjust(definition, build, evaluated, named ? { type: "ability", id: named.id, label: named.label } : null)
    );
  }
  const withAbility =
    typeof ability === "string" && ability in evaluated.abilityMods && ability !== skill.ability ? ability : undefined;
  const target: RulesetCheckTarget = {
    type: "skill",
    id: skill.id,
    label: skill.label,
    ...(skill.ability ? { ability: skill.ability } : {}),
    ...(withAbility ? { withAbility } : {}),
  };
  return rulesetCheckModifier(evaluated, target) + fightAdjust(definition, build, evaluated, target);
}

function attackActions(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  source: RulesetCombatAttackSource,
  index: number,
  build: RulesetSheetBuild,
  evaluated: EvaluatedRulesetSheet,
  perCell: number | undefined,
): RulesetCombatAction[] {
  const rows = build.lists?.[source.list];
  if (!Array.isArray(rows)) return [];
  // How many strikes one spend of this list's budget buys, read off the sheet once. A number below
  // one is the one strike every spend has always bought, so a sheet left alone changes nothing.
  const strikes = source.strikes
    ? Math.max(1, Math.trunc(resolveRulesetValueRef(definition, build, source.strikes, evaluated)))
    : undefined;
  const actions: RulesetCombatAction[] = [];
  rows.forEach((raw, rowIndex) => {
    if (!raw || typeof raw !== "object") return;
    const row = raw as Record<string, unknown>;
    const name = textFromColumn(row, source.name);
    const parsed = parseRulesetCombatDice(columnValue(row, source.damage.dice.column));
    // A pool fight counts a damage column's dice, of its own die, and an ability's rating on top: a
    // row with none of its own still has what its hits add past the successes they needed.
    const pooled = rulesetCombatIsPool(combat);
    const dice = pooled ? (parsed ?? { count: 0, sides: rulesetPoolDie(definition), flat: 0 }) : parsed;
    if (!name || !dice) return;
    const proficient = columnValue(row, source.toHit.proficiency?.column) === true;
    const namedAbility = columnValue(row, source.toHit.ability?.column);
    const ability =
      typeof namedAbility === "string" && namedAbility in evaluated.abilityMods
        ? namedAbility
        : definition.sheet.skills.find((entry) => entry.id === columnValue(row, source.toHit.skill?.column))?.ability;
    const reach = distanceInCells(source.reach, row, perCell);
    const normal = distanceInCells(source.range?.normal, row, perCell);
    const long = distanceInCells(source.range?.long, row, perCell);
    actions.push({
      id: `attack:${index}:${rowIndex}`,
      ...(ability ? { ability } : {}),
      kind: "attack",
      label: name,
      budget: source.budget,
      targets: { side: "enemy", count: 1 },
      // A row its own column holds to one strike keeps none in hand: a crossbow is one shot a turn
      // however many attacks its wielder has. Said per ROW, because the count is the list's.
      ...(strikes !== undefined && columnValue(row, source.strikesCappedBy?.column) !== true ? { strikes } : {}),
      ...(reach !== undefined ? { reach } : {}),
      // A row whose long distance came out shorter than its ordinary one is the player's row, not
      // the ruleset's rule, so it is read as having nothing beyond the ordinary one.
      ...(normal !== undefined ? { range: { normal, ...(long !== undefined && long > normal ? { long } : {}) } } : {}),
      toHit:
        rowAbilityAndSkill(definition, build, source, row, evaluated) +
        (proficient ? evaluated.proficiencyBonus : 0) +
        numberFromColumn(row, source.toHit.bonus?.column),
      damage: pooled
        ? {
            // Dice of the ruleset's own die: the column's count and the ability's rating. What is
            // added flat is automatic successes, never thrown.
            count: Math.max(0, dice.count + abilityFromColumn(evaluated, row, source.damage.ability?.column)),
            sides: rulesetPoolDie(definition),
            flat: Math.max(0, dice.flat + numberFromColumn(row, source.damage.bonus?.column)),
            ...(textFromColumn(row, source.damage.type?.column)
              ? { type: textFromColumn(row, source.damage.type?.column) }
              : {}),
          }
        : {
            count: dice.count,
            sides: dice.sides,
            flat:
              dice.flat +
              abilityFromColumn(evaluated, row, source.damage.ability?.column) +
              numberFromColumn(row, source.damage.bonus?.column),
            ...(textFromColumn(row, source.damage.type?.column)
              ? { type: textFromColumn(row, source.damage.type?.column) }
              : {}),
          },
    });
  });
  return actions;
}

/** One value of an item's attack: written as it is, or read off the item's own stat. A stat the item
 *  gives nothing is as if the value were not written. */
function itemAttackValue(item: RulesetCatalogItem, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const stat = (value as { stat?: unknown }).stat;
  if (typeof stat !== "string" || !item.stats || !Object.prototype.hasOwnProperty.call(item.stats, stat)) {
    return undefined;
  }
  return item.stats[stat];
}

/** The abilities an attack value names: a list of them, or the one an enum stat holds. */
function attackAbilities(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  return typeof value === "string" ? [value] : [];
}

/** What an item adds to hit, read the way an attack row's is: the best of its abilities (with its
 *  skill, the ability swapped in), the proficiency bonus where its `proficiency` reads above 0 off the
 *  holder's sheet, its bonus, and in a pool fight its own per-die target. */
function itemToHit(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  evaluated: EvaluatedRulesetSheet,
  item: RulesetCatalogItem,
  toHit: NonNullable<RulesetItemUse["toHit"]>,
  pooled: boolean,
): { toHit: number; target?: number; ability?: string } {
  const read = (value: unknown) => itemAttackValue(item, value);
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const skill = read(toHit.skill);
  const hitWith = attackAbilities(read(toHit.abilities));
  const ability = hitWith.length
    ? hitWith.reduce((best, one) =>
        abilityAndSkill(definition, build, evaluated, skill, one) >
        abilityAndSkill(definition, build, evaluated, skill, best)
          ? one
          : best,
      )
    : definition.sheet.skills.find((entry) => entry.id === skill)?.ability;
  const base = abilityAndSkill(definition, build, evaluated, skill, ability);
  const proficient =
    toHit.proficiency !== undefined && resolveRulesetValueRef(definition, build, toHit.proficiency, evaluated) > 0;
  const target = read(toHit.target);
  // What the holder brings to it off their own sheet (Capability API 1.90: an archer's +2 to ranged).
  const fromSheet =
    toHit.sheetBonus !== undefined
      ? Math.trunc(resolveRulesetValueRef(definition, build, toHit.sheetBonus, evaluated))
      : 0;
  return {
    ...(ability ? { ability } : {}),
    toHit:
      base +
      (proficient ? evaluated.proficiencyBonus : 0) +
      number(read(toHit.bonus)) +
      (Number.isFinite(fromSheet) ? fromSheet : 0),
    ...(pooled && typeof target === "number" && Number.isFinite(target) ? { target } : {}),
  };
}

/**
 * The items a fighter may use, as actions: each held item with a `use`, from the bag, or worn where it
 * takes a slot or binds. What it does is its use's, read as a catalog entry's mechanics are; its own
 * to-hit and save difficulty stand in for a sheet row's; and it spends one off its stack or some of
 * its charges. One whose charges, or whose save's number, read off a stat it does not give is never
 * used.
 */
function itemUseActions(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  items: readonly RulesetSheetItem[] | undefined,
  build: RulesetSheetBuild,
  evaluated: EvaluatedRulesetSheet,
  perCell: number | undefined,
): RulesetCombatAction[] {
  if (!items?.some((held) => held.item.use)) return [];
  const pooled = rulesetCombatIsPool(combat);
  const actions: RulesetCombatAction[] = [];
  items.forEach((held, index) => {
    const { item } = held;
    const use = item.use;
    if (!use) return;
    const wearable = Object.values(item.slots ?? {}).some((count) => count > 0) || !!item.binds;
    if (wearable && !held.worn) return;
    const read = (value: unknown) => itemAttackValue(item, value);
    const whole = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
    // A stat holds its own range, so what it gives is held to the most a written count may be.
    const counted = item.charges ? whole(read(item.charges.max)) : undefined;
    const max = counted === undefined ? undefined : Math.min(RULESET_ITEM_CHARGES_MAX, counted);
    if (use.charges !== undefined && !(max !== undefined && max >= 1)) return;
    const label =
      held.name ??
      definition.items?.categories.find((category) => category.id === item.category)?.label ??
      item.category;
    const action = itemUseMechanics(
      definition,
      item,
      use,
      { id: `use:${index}`, label },
      build,
      evaluated,
      perCell,
      pooled,
    );
    if (!action) return;
    // A fake (1.74) is offered as what it passes for, aimed, timed and spent as that is, so nothing on
    // the menu tells them apart; what it does is what it truly does. One whose true item does nothing a
    // fight can use is spent for nothing.
    const real = held.truly ? fakeUseAction(definition, held.truly.item, build, evaluated, perCell, pooled) : null;
    // A gate read off a stat the item does not give is a check against nothing, as a save's is.
    const gateDifficulty = use.gate ? rulesetItemGateDifficulty(item, use.gate) : undefined;
    if (use.gate && gateDifficulty === undefined) return;
    const gate =
      use.gate && gateDifficulty !== undefined
        ? rulesetItemGateCheck(definition, build, evaluated, use.gate, gateDifficulty)
        : null;
    action.itemUse = {
      item: index,
      ...(held.truly ? { fake: { name: held.truly.name, ...(real ? { does: real } : { dud: true as const }) } } : {}),
      ...(use.consumes ? { consumes: true as const } : {}),
      ...(use.charges !== undefined && max !== undefined
        ? {
            charges: {
              cost: use.charges,
              max,
              ...(item.charges?.breaksOn ? { breaksOn: { ...item.charges.breaksOn } } : {}),
            },
          }
        : {}),
      ...(gate
        ? {
            gate: {
              check: rulesetItemGateLabel(definition, use.gate!),
              ...(gate.target?.type === "skill" ? { skill: gate.target.id } : {}),
              ...(gateAbility(gate.target) ? { ability: gateAbility(gate.target) } : {}),
              modifier: gate.modifier,
              difficulty: gate.difficulty,
            },
          }
        : {}),
    };
    actions.push(action);
  });
  return actions;
}

/** What one use does, as an action holds it: the parts a fake takes from what it truly is (1.74). */
export const RULESET_FAKE_EFFECT_KEYS = [
  "toHit",
  "ability",
  "target",
  "autoHit",
  "damage",
  "heal",
  "temporary",
  "restore",
  "save",
  "saveDifficulty",
  "applies",
  "concentration",
  // What a scroll's spell leaves behind (1.169) is what it truly does too.
  "zone",
] as const satisfies ReadonlyArray<keyof RulesetCombatAction>;

/** The action a use resolves as: for a fake (1.74), the one offered with what it truly does in place
 *  of what it seemed to, so the menu, the forecast and the aim stay what the real thing's are. */
export function rulesetActionAsUsed(action: RulesetCombatAction): RulesetCombatAction {
  const does = action.itemUse?.fake?.does;
  if (!does) return action;
  const used: RulesetCombatAction = { ...action };
  for (const key of RULESET_FAKE_EFFECT_KEYS) delete used[key];
  return { ...used, ...does };
}

/** What an item's use does, as an action: its own to-hit and save difficulty in place of a sheet row's,
 *  and what it restores. Null for a use no menu holds, or one whose save reads a stat the item does
 *  not give (a save against nothing). */
function itemUseMechanics(
  definition: RulesetDefinition,
  item: RulesetCatalogItem,
  use: NonNullable<RulesetCatalogItem["use"]>,
  from: { id: string; label: string },
  build: RulesetSheetBuild,
  evaluated: EvaluatedRulesetSheet,
  perCell: number | undefined,
  pooled: boolean,
): RulesetCombatAction | null {
  const read = itemAttackValue(item, use.saveDifficulty);
  const difficulty = typeof read === "number" && Number.isFinite(read) ? Math.trunc(read) : undefined;
  if (use.saveDifficulty !== undefined && difficulty === undefined) return null;
  const aim = use.toHit ? itemToHit(definition, build, evaluated, item, use.toHit, pooled) : { toHit: 0 };
  const action = mechanicsAction(definition, use, {
    ...from,
    kind: "item",
    budget: use.budget ?? "",
    toHit: aim.toHit,
    ...(aim.ability ? { ability: aim.ability } : {}),
    ...(difficulty !== undefined ? { saveDifficulty: difficulty } : {}),
    build,
    evaluated,
    perCell,
  });
  if (!action) return null;
  if (aim.target !== undefined) action.target = aim.target;
  if (use.casts) action.casts = use.casts;
  const restored = amountOf(use.restore?.amount);
  if (use.restore && restored) action.restore = { pool: use.restore.pool, amount: restored };
  return action;
}

/** What a fake's use truly does: its true item's use, read off that item, as the parts of an action
 *  in `RULESET_FAKE_EFFECT_KEYS`; null where it does nothing a fight can use (no use, one no menu holds, or a
 *  save whose number reads a stat the item does not give). */
function fakeUseAction(
  definition: RulesetDefinition,
  item: RulesetCatalogItem,
  build: RulesetSheetBuild,
  evaluated: EvaluatedRulesetSheet,
  perCell: number | undefined,
  pooled: boolean,
): Partial<RulesetCombatAction> | null {
  const action = item.use
    ? itemUseMechanics(definition, item, item.use, { id: "fake", label: "" }, build, evaluated, perCell, pooled)
    : null;
  if (!action) return null;
  const does: Partial<RulesetCombatAction> = {};
  for (const key of RULESET_FAKE_EFFECT_KEYS)
    if (action[key] !== undefined) Object.assign(does, { [key]: action[key] });
  return does;
}

/** The switches on a fighter's items (1.165): one of an item with a `toggle` turned on or off, on its
 *  budget. Its place in `sheet.items` is what the fight keeps the state by. */
function itemSwitchActions(items: readonly RulesetSheetItem[] | undefined): RulesetCombatAction[] {
  return (items ?? []).flatMap((held, index): RulesetCombatAction[] => {
    const toggle = held.item.toggle;
    if (!toggle || held.quantity !== 1) return [];
    return [
      {
        id: `switch:${index}`,
        kind: "switch",
        label: `${held.name ?? toggle.label}: ${toggle.label}`,
        budget: toggle.budget,
        targets: { side: "self", count: 0 },
        switches: { item: index },
      },
    ];
  });
}

/**
 * The weapons a fighter holds, as attacks: each worn item with an `attack`, read the way an attack
 * row is, with its values in place of columns and each stat it reads off the item itself. It adds
 * to hit the best of its abilities (with its skill, as a row's `with=` swaps one in), deals the best
 * of its damage abilities, and deals its `versatile` dice instead while each slot it takes has room
 * for as much again. What it carries past a resistance is its tags. An item put away offers nothing.
 */
function itemAttackActions(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  items: readonly RulesetSheetItem[] | undefined,
  build: RulesetSheetBuild,
  evaluated: EvaluatedRulesetSheet,
  perCell: number | undefined,
): RulesetCombatAction[] {
  if (!items?.some((held) => held.worn && held.item.attack)) return [];
  const pooled = rulesetCombatIsPool(combat);
  // What the fighter's worn items take of each slot, the weapon's own share included.
  // ponytail: an item put on but not yet bound fills its slot and is not counted here, because a
  // fight's items say only whether each is worn; passing "on" through is the upgrade.
  const used: Record<string, number> = {};
  for (const held of items) {
    if (!held.worn) continue;
    for (const [slot, count] of Object.entries(held.item.slots ?? {}))
      used[slot] = (used[slot] ?? 0) + count * held.quantity;
  }
  const slotCounts = new Map((definition.items?.slots ?? []).map((slot) => [slot.id, slot.count]));
  const cells = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && perCell !== undefined
      ? rulesetInCells(value, perCell)
      : undefined;
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const actions: RulesetCombatAction[] = [];
  items.forEach((held, index) => {
    const { item } = held;
    const attack = item.attack;
    if (!attack || !held.worn) return;
    const read = (value: unknown) => itemAttackValue(item, value);
    const free =
      attack.versatile !== undefined &&
      Object.entries(item.slots ?? {}).every(
        ([slot, count]) => (slotCounts.get(slot) ?? 0) - (used[slot] ?? 0) >= count,
      );
    const parsed = parseRulesetCombatDice(read(free ? attack.versatile!.dice : attack.damage.dice));
    const dice = pooled ? (parsed ?? { count: 0, sides: rulesetPoolDie(definition), flat: 0 }) : parsed;
    if (!dice) return;
    const aim = itemToHit(definition, build, evaluated, item, attack.toHit, pooled);
    const dealtWith = attackAbilities(read(attack.damage.abilities));
    const damageAbility = dealtWith.length
      ? Math.max(...dealtWith.map((ability) => evaluated.abilityMods[ability] ?? ABILITY_COLUMN_MISS))
      : 0;
    // What the holder brings to the damage off their own sheet (1.92: a duelist's +2), only while the
    // weapon is held in one hand when it says so: a versatile weapon wielded two-handed, or one that
    // takes two of a slot, is not.
    const twoHanded = free || Object.values(item.slots ?? {}).some((count) => count >= 2);
    const sheetDamage =
      attack.damage.sheetBonus !== undefined && !(attack.damage.oneHanded && twoHanded)
        ? Math.trunc(resolveRulesetValueRef(definition, build, attack.damage.sheetBonus, evaluated))
        : 0;
    const bonus = number(read(attack.damage.bonus)) + (Number.isFinite(sheetDamage) ? sheetDamage : 0);
    const typeRead = read(attack.damage.type);
    const type = typeof typeRead === "string" && typeRead.trim() ? typeRead.trim() : undefined;
    const strikes = attack.strikes
      ? Math.max(1, Math.trunc(resolveRulesetValueRef(definition, build, attack.strikes, evaluated)))
      : undefined;
    const reach = cells(read(attack.reach));
    const normal = attack.range ? cells(read(attack.range.normal)) : undefined;
    const long = attack.range?.long !== undefined ? cells(read(attack.range.long)) : undefined;
    // A clip holds a number of rounds, so one its stat does not give is a weapon that never fires.
    const clipMax = attack.clip ? read(attack.clip.max) : undefined;
    if (attack.clip && !(typeof clipMax === "number" && Number.isFinite(clipMax) && clipMax >= 1)) return;
    const clip = attack.clip ? { item: index, max: Math.trunc(clipMax as number) } : undefined;
    const ammo = attack.ammo
      ? {
          tag: attack.ammo.tag,
          per: attack.ammo.perAttack ?? 1,
          ...(attack.ammo.recover ? { recover: attack.ammo.recover } : {}),
        }
      : undefined;
    const label =
      held.name ??
      definition.items?.categories.find((category) => category.id === item.category)?.label ??
      item.category;
    if (clip && attack.clip) {
      actions.push({
        id: `reload:${index}`,
        kind: "reload",
        label,
        budget: attack.clip.reload,
        targets: { side: "self", count: 0 },
        clip,
        ...(ammo ? { ammo } : {}),
      });
    }
    // Low damage dice thrown again once, off the holder's sheet, only while the weapon is wielded
    // two-handed (1.93: Great Weapon Fighting's 1s and 2s). A pool fight's damage is successes, not
    // faces, so it has none.
    const rerollRead =
      !pooled && attack.damage.rerollUpTo !== undefined && twoHanded
        ? Math.trunc(resolveRulesetValueRef(definition, build, attack.damage.rerollUpTo, evaluated))
        : 0;
    const rerollUpTo = Number.isFinite(rerollRead) ? Math.max(0, Math.min(rerollRead, dice.sides - 1)) : 0;
    const floorRead = read(attack.floor);
    const floor = typeof floorRead === "number" && Number.isFinite(floorRead) && floorRead >= 1 ? floorRead : 0;
    // A damage ability read as the off hand reads it where the ruleset says so: added only when it
    // takes something away.
    const damageOf = (ability: number) => ({
      ...(pooled
        ? {
            count: Math.max(0, dice.count + ability),
            sides: rulesetPoolDie(definition),
            flat: Math.max(0, dice.flat + bonus),
          }
        : { count: dice.count, sides: dice.sides, flat: dice.flat + ability + bonus }),
      ...(type ? { type } : {}),
      ...(item.tags?.length ? { qualities: [...item.tags] } : {}),
      ...(floor ? { floor: Math.trunc(floor) } : {}),
      ...(rerollUpTo > 0 ? { reroll: rerollUpTo } : {}),
      ...(plus.length ? { plus: plus.map((clause) => ({ ...clause })) } : {}),
    });
    // More damage on the same blow (1.164), each clause its own dice, type, save and target test. A
    // pool fight throws a clause's count of its own dice, as it throws the weapon's.
    const clausesOf = (clauses: typeof attack.plus) =>
      (clauses ?? []).flatMap((clause): RulesetCombatDamageClause[] => {
        const parsedClause = clause.dice ? parseRulesetCombatDice(clause.dice) : null;
        if (clause.dice && !parsedClause) return [];
        const amount = parsedClause
          ? pooled
            ? {
                count: parsedClause.count,
                sides: rulesetPoolDie(definition),
                flat: parsedClause.flat + (clause.flat ?? 0),
              }
            : { ...parsedClause, flat: parsedClause.flat + (clause.flat ?? 0) }
          : { count: 0, sides: pooled ? rulesetPoolDie(definition) : 0, flat: clause.flat ?? 0 };
        return [
          {
            ...amount,
            ...(clause.type ? { type: clause.type } : {}),
            ...(clause.save ? { save: { ...clause.save } } : {}),
            ...(clause.targetIs ? { targetIs: clause.targetIs } : {}),
            ...(clause.when === "critical" ? { onCritical: true as const } : {}),
            ...(clause.when === "toggled" ? { whileOn: index } : {}),
            ...(clause.not ? { not: clause.not } : {}),
            ...(clause.blow ? { blow: clause.blow } : {}),
            ...(clause.tempHp ? { tempHp: true as const } : {}),
            ...(clause.marked ? { marked: clause.marked } : {}),
          },
        ];
      });
    const plus = clausesOf(attack.plus);
    // The item's own charges, which a slay spends (1.182): a stat holds its own range, held to the
    // most a written count may be. One that reads nothing never slays.
    const counted = item.charges ? read(item.charges.max) : undefined;
    const chargesMax =
      typeof counted === "number" && Number.isFinite(counted)
        ? Math.min(RULESET_ITEM_CHARGES_MAX, Math.trunc(counted))
        : undefined;
    const slay = (attack.slay ?? []).flatMap((entry) => {
      if (entry.charges !== undefined && !(chargesMax !== undefined && chargesMax >= 1)) return [];
      const { charges, ...rest } = structuredClone(entry);
      return [
        {
          ...rest,
          ...(charges !== undefined ? { charges: { cost: charges, max: chargesMax!, item: index } } : {}),
        },
      ];
    });
    // A mode's own reach, clauses, bolt and charges (1.185). One that spends charges the item cannot
    // count is never offered; a reach or a bolt needs a board's cells.
    const modeOf = (mode: NonNullable<typeof attack.modes>[number]): RulesetCombatMode[] => {
      if (mode.charges !== undefined && !(chargesMax !== undefined && chargesMax >= 1)) return [];
      const { range, plus: modePlus, line, charges, ...rest } = mode;
      const modeNormal = range ? cells(range.normal) : undefined;
      const modeLong = range?.long !== undefined ? cells(range.long) : undefined;
      const lineDice = line?.dice ? parseRulesetCombatDice(line.dice) : null;
      const moded: RulesetCombatMode = {
        ...rest,
        ...(modeNormal !== undefined
          ? {
              range: {
                normal: modeNormal,
                ...(modeLong !== undefined && modeLong > modeNormal ? { long: modeLong } : {}),
              },
            }
          : {}),
        ...(modePlus?.length ? { plus: clausesOf(modePlus) } : {}),
        ...(line && perCell !== undefined
          ? {
              line: {
                amount: {
                  count: lineDice?.count ?? 0,
                  sides: pooled ? rulesetPoolDie(definition) : (lineDice?.sides ?? 0),
                  flat: (lineDice?.flat ?? 0) + (line.flat ?? 0),
                },
                ...(line.type ? { type: line.type } : {}),
                save: { ...line.save },
              },
            }
          : {}),
        ...(charges !== undefined ? { charges: { cost: charges, max: chargesMax!, item: index } } : {}),
      };
      return [moded];
    };
    const offHand = attack.offHand && combat.offHand ? combat.offHand : undefined;
    const weapon: RulesetCombatAction = {
      id: `item:${index}`,
      kind: "attack",
      label,
      budget: attack.budget,
      targets: { side: "enemy", count: 1 },
      ...(strikes !== undefined ? { strikes } : {}),
      ...(reach !== undefined ? { reach } : {}),
      ...(normal !== undefined ? { range: { normal, ...(long !== undefined && long > normal ? { long } : {}) } } : {}),
      ...(aim.ability ? { ability: aim.ability } : {}),
      toHit: aim.toHit,
      ...(aim.target !== undefined ? { target: aim.target } : {}),
      damage: damageOf(damageAbility),
      ...(ammo ? { ammo } : {}),
      ...(clip ? { clip } : {}),
      ...(attack.modes?.length ? { modes: attack.modes.flatMap((mode) => modeOf(mode)) } : {}),
      ...(attack.onHit?.length
        ? {
            onHit: attack.onHit.map((entry) => ({
              ...entry,
              ...(entry.save ? { save: { ...entry.save } } : {}),
              ...(entry.saveEnds ? { saveEnds: { ...entry.saveEnds } } : {}),
            })),
          }
        : {}),
      ...(attack.against?.length ? { against: structuredClone(attack.against) } : {}),
      ...(slay.length ? { slay } : {}),
      ...(attack.ignoresResistance ? { ignoresResistance: true as const } : {}),
      ...(attack.healedOnlyByRest ? { healedOnlyByRest: true as const } : {}),
      ...(attack.othersWhileMarked ? { othersWhileMarked: { ...attack.othersWhileMarked, item: index } } : {}),
    };
    actions.push(offHand ? { ...weapon, pairs: index } : weapon);
    if (offHand) {
      // The same weapon, struck with again on the off-hand budget: one blow, whatever strikes its
      // main attack buys, and with the damage ability the ruleset lets an off hand keep.
      const { strikes: _strikes, ...single } = weapon;
      actions.push({
        ...single,
        id: `offhand:${index}`,
        budget: offHand.budget,
        // The off hand keeps the full ability for a fighter whose sheet says so (1.92: Two-Weapon
        // Fighting), whatever the ruleset's rule for everyone else.
        damage: damageOf(
          offHand.ability === "penalty-only" &&
            !(
              offHand.fullWhen !== undefined &&
              resolveRulesetValueRef(definition, build, offHand.fullWhen, evaluated) > 0
            )
            ? Math.min(0, damageAbility)
            : damageAbility,
        ),
        offHandOf: index,
      });
    }
  });
  return actions;
}

/** The clauses beside a blow's first amount, with each save's difficulty resolved once: the
 *  clause's own number when it named one, and otherwise the number this source rolls saves against.
 *  A clause with neither dice nor a flat part is refused at import, so nothing here is dropped. */
function clausesOf(
  plus: RulesetCatalogMechanics["plus"] | undefined,
  difficulty: number,
): RulesetCombatDamageClause[] | null {
  if (!plus?.length) return null;
  const clauses = plus.flatMap((clause) => {
    const amount = amountOf(clause);
    if (!amount) return [];
    return [
      {
        ...amount,
        ...(clause.type ? { type: clause.type } : {}),
        ...(clause.targetIs ? { targetIs: clause.targetIs } : {}),
        ...(clause.save
          ? {
              save: {
                save: clause.save.save,
                onSuccess: clause.save.onSuccess,
                difficulty: clause.save.difficulty ?? difficulty,
              },
            }
          : {}),
      },
    ];
  });
  return clauses.length > 0 ? clauses : null;
}

/** Who a catalog entry may be pointed at. What it does decides it when the entry says nothing: a
 *  heal or a buff goes to the actor's own side, anything else to the other one. */
function targetsOf(mechanics: RulesetCatalogMechanics): RulesetCombatAction["targets"] {
  // A `utility` entry is only ever here because it changes what the turn may hold, and what it
  // changes is the holder's own economy: there is nobody to point it at. One that cures (1.171) is
  // pointed at whom it cures, an ally unless it says otherwise.
  // Moving a track or giving back sealed health is one too (1.196).
  const cures =
    !!mechanics.ends || !!mechanics.stabilizes || !!mechanics.revives || !!mechanics.tracks || !!mechanics.unseals;
  // One that leaves an area standing (1.173: Fog Cloud, Darkness) is set down wherever its caster
  // likes, and off a board held on whoever it is cast on.
  if (mechanics.kind === "utility" && mechanics.zone && mechanics.area) {
    return { side: mechanics.targets ?? "any", count: Math.max(1, mechanics.targetCount ?? 1) };
  }
  if (mechanics.kind === "utility" && !cures) return { side: "self", count: 0 };
  if (mechanics.kind === "utility") {
    return { side: mechanics.targets ?? "ally", count: Math.max(1, mechanics.targetCount ?? 1) };
  }
  // An area catches each creature in it (1.187), so off a board, where it is pointed at people by
  // name, it may be pointed at either side unless it spares its caster's own.
  const side =
    mechanics.targets ??
    (mechanics.kind === "heal" || mechanics.kind === "buff"
      ? "ally"
      : mechanics.area && mechanics.friendlyFire !== false
        ? "any"
        : "enemy");
  return { side, count: Math.max(1, mechanics.targetCount ?? 1) };
}

function abilityAction(
  definition: RulesetDefinition,
  source: RulesetCombatAbilitySource,
  row: Record<string, unknown>,
  sourceIndex: number,
  rowIndex: number,
  name: string,
  entry: RulesetCatalogEntry,
  build: RulesetSheetBuild,
  evaluated: EvaluatedRulesetSheet,
  perCell: number | undefined,
): RulesetCombatAction | null {
  const mechanics = entry.mechanics;
  if (!mechanics) return null;
  const values = resolveRulesetAbilityValues(definition, build, source, row, evaluated);
  const rolled = refTarget(definition, build, values.toHitRef);
  const ability = rolled?.type === "ability" ? rolled.id : rolled?.ability;
  return mechanicsAction(definition, mechanics, {
    id: `ability:${sourceIndex}:${rowIndex}`,
    ...(ability ? { ability } : {}),
    kind: "ability",
    label: name,
    budget: mechanics.budget ?? source.budget,
    // An entry that rolls to hit always rolls: a source that names no bonus adds nothing to the dice.
    toHit: values.toHit + fightAdjust(definition, build, evaluated, values.toHitRef),
    ...(values.saveDifficulty !== undefined ? { saveDifficulty: values.saveDifficulty } : {}),
    build,
    evaluated,
    perCell,
  });
}

/**
 * What a catalog entry's `mechanics`, or an item's `use`, does in a fight, as one action: the harm
 * or healing it deals, its save, the conditions it applies, its temporary points, its reach, range
 * and area, and what the turn's economy makes of it. Where it came from says what it is called,
 * which budget it spends, what it adds to hit where it rolls, and what its saves are rolled against.
 */
function mechanicsAction(
  definition: RulesetDefinition,
  mechanics: Partial<RulesetCatalogMechanics> & Pick<RulesetCatalogMechanics, "kind">,
  from: {
    id: string;
    kind: RulesetCombatAction["kind"];
    label: string;
    budget: string;
    toHit: number;
    ability?: string;
    saveDifficulty?: number;
    build: RulesetSheetBuild;
    evaluated: EvaluatedRulesetSheet;
    perCell: number | undefined;
  },
): RulesetCombatAction | null {
  // A reaction answers something, and `reaction: true` says only that much. An entry that names no
  // moment is on no menu at all: not a turn's, because it is not taken on a turn, and not a
  // window's, because nothing here knows which window it belongs in.
  if (mechanics.reaction === true) return null;
  // `false` says the same as leaving it out: not a reaction at all.
  const moment = typeof mechanics.reaction === "object" ? mechanics.reaction : undefined;
  // A `utility` entry has nothing to resolve unless it changes what the turn itself may hold: one
  // that hands a budget back, lets its holder buy a standard action with another one, or stops
  // something from happening at all. Calling something off IS what such an entry does.
  const cancels = moment?.cancels === true;
  // Taking a condition off, steadying the dying or bringing back the dead is something to resolve.
  // Moving a track or giving back sealed health is one too (1.196).
  const cures =
    !!mechanics.ends || !!mechanics.stabilizes || !!mechanics.revives || !!mechanics.tracks || !!mechanics.unseals;
  // And so is leaving an area standing that only hides or blocks (1.173).
  const places = !!mechanics.zone && !!mechanics.area;
  if (mechanics.kind === "utility" && !mechanics.gives && !mechanics.standard && !cancels && !cures && !places) {
    return null;
  }
  const { build, evaluated, perCell } = from;
  const resolve = (ref: RulesetValueRef) => resolveRulesetValueRef(definition, build, ref, evaluated);
  // What the sheet adds to it (1.78), read as the entry is put on the menu: 1d10 plus a level.
  const added = mechanics.amountAdd ? Math.trunc(resolve(mechanics.amountAdd)) : 0;
  const declared = amountOf(mechanics.amount);
  const amount = declared && added ? { ...declared, flat: declared.flat + added } : declared;
  // A scaling amount grows in DICE: the table says how many to add at each step of what it reads.
  const extra = mechanics.scales
    ? Math.max(0, Math.trunc(lookupStepTable(mechanics.scales.table, resolve(mechanics.scales.from))))
    : 0;
  const scaled = amount ? { ...amount, count: amount.count + (amount.count > 0 ? extra : 0) } : null;
  const heals = mechanics.kind === "heal";
  const sourceDifficulty = from.saveDifficulty ?? 0;
  const cost = mechanics.cost?.length === 1 ? mechanics.cost[0]! : undefined;
  const pool = cost ? definition.sheet.live.pools.find((entry2) => entry2.id === cost.pool) : undefined;
  const family = cost ? (pool ? pool.group : cost.pool) : undefined;
  const action: RulesetCombatAction = {
    id: from.id,
    ...(from.ability ? { ability: from.ability } : {}),
    kind: from.kind,
    ...(mechanics.qualities?.length ? { qualities: [...mechanics.qualities] } : {}),
    ...(mechanics.kind === "attack" || mechanics.kind === "debuff" ? { harmful: true as const } : {}),
    label: from.label,
    budget: from.budget,
    targets: targetsOf(mechanics as RulesetCatalogMechanics),
    ...(moment
      ? {
          reaction: {
            on: moment.on,
            // The schema defaults it, but a caller handing entries in unparsed does not, and an
            // `undefined` here would not survive the trip through JSON the state has to make.
            at: moment.at ?? "source",
            ...(moment.cancels ? { cancels: true as const } : {}),
            ...rulesetReactionAnswers(moment, perCell),
            ...(moment.cancelSave ? { cancelSave: { ...moment.cancelSave } } : {}),
            ...(moment.upTo ? { upTo: moment.upTo } : {}),
            ...(moment.above
              ? { above: { modifier: Math.trunc(resolve(moment.above.check)), dc: moment.above.dc } }
              : {}),
          },
        }
      : {}),
    // How it is paid for off the sheet: only what a sheet row names is. An item pays with itself.
    ...(from.kind === "ability"
      ? {
          use: {
            name: from.label,
            ...(cost ? { pool: cost.pool } : {}),
            // A cost names a live pool, and then the family is that pool's, or it names the family
            // itself. Left out entirely when there is no family: the state is written as JSON, and a
            // key holding nothing would not survive the trip.
            ...(family ? { group: family } : {}),
            ...(mechanics.perCostStep
              ? { perCostStep: amountOf(mechanics.perCostStep) ?? { count: 0, sides: 0, flat: 0 } }
              : {}),
            ...(mechanics.targetsPerCostStep ? { targetsPerStep: mechanics.targetsPerCostStep } : {}),
          },
        }
      : {}),
  };
  const plus = clausesOf(mechanics.plus, sourceDifficulty);
  if (scaled && heals) action.heal = scaled;
  else if (scaled) {
    action.damage = {
      ...scaled,
      ...(mechanics.damageType ? { type: mechanics.damageType } : {}),
      ...(plus ? { plus } : {}),
      ...(mechanics.qualities?.length ? { qualities: [...mechanics.qualities] } : {}),
    };
  }
  const temporary = amountOf(mechanics.temporary);
  if (temporary) action.temporary = temporary;
  const healthPool = amountOf(mechanics.healthPool);
  if (healthPool) action.healthPool = healthPool;
  const skips = mechanics.healthPoolSkips;
  if (healthPool && skips) {
    action.healthPoolSkips = {
      ...(skips.conditions ? { conditions: [...skips.conditions] } : {}),
      ...(skips.unseeing ? { unseeing: true } : {}),
    };
  }
  if (mechanics.healthAtMost !== undefined) action.healthAtMost = mechanics.healthAtMost;
  if (mechanics.kills) action.kills = true;
  // Leaving `toHit` unset here would send it down the no-roll path and land it automatically.
  if (mechanics.attackRoll) action.toHit = from.toHit;
  if (mechanics.autoHit) action.autoHit = true;
  if (mechanics.needs) action.needs = [...mechanics.needs];
  if (mechanics.seen) action.seen = true;
  if (mechanics.components) action.components = [...mechanics.components];
  if (mechanics.targetTypes) action.targetTypes = mechanics.targetTypes;
  if (mechanics.maxAgainst) action.maxAgainst = structuredClone(mechanics.maxAgainst);
  if (mechanics.usableWhen) action.usableWhen = { ...mechanics.usableWhen };
  if (mechanics.save) {
    action.save = {
      save: mechanics.save.save,
      onSuccess: mechanics.save.onSuccess,
      difficulty: sourceDifficulty,
      ...(mechanics.save.ignoresCover ? { ignoresCover: true as const } : {}),
      ...(mechanics.save.against ? { against: structuredClone(mechanics.save.against) } : {}),
      ...(mechanics.save.succeeds ? { succeeds: structuredClone(mechanics.save.succeeds) } : {}),
      ...(mechanics.save.modes ? { modes: structuredClone(mechanics.save.modes) } : {}),
    };
  }
  if (from.saveDifficulty !== undefined) action.saveDifficulty = sourceDifficulty;
  if (mechanics.applies?.length) action.applies = mechanics.applies.map((entry2) => ({ ...entry2 }));
  if (mechanics.concentration) action.concentration = true;
  if (mechanics.ends) {
    action.ends = {
      conditions: [...mechanics.ends.conditions],
      ...(mechanics.ends.count !== undefined ? { count: mechanics.ends.count } : {}),
    };
  }
  if (mechanics.stabilizes) action.stabilizes = true;
  if (mechanics.tracks) action.tracks = mechanics.tracks.map((entry) => ({ ...entry }));
  if (mechanics.unseals) action.unseals = true;
  // One cure of several (1.199), picked like a weapon's mode: a condition, a track, or the maximum.
  if (mechanics.cureOneOf) {
    action.cureOneOf = true;
    const conditionLabel = (id: string) => definition.sheet.live.conditions.find((one) => one.id === id)?.label ?? id;
    const health = definition.combat?.health;
    const healthLabel =
      health && !("track" in health)
        ? (definition.sheet.live.pools.find((one) => one.id === health.pool)?.label ?? health.pool)
        : "";
    action.modes = [
      ...(mechanics.ends?.conditions ?? []).map((condition) => ({
        id: `ends-${condition}`,
        label: conditionLabel(condition),
        cure: { ends: condition },
      })),
      ...(mechanics.tracks ?? []).map((entry) => ({
        id: `track-${entry.track}`,
        label: definition.sheet.live.tracks.find((one) => one.id === entry.track)?.label ?? entry.track,
        cure: { track: { ...entry } },
      })),
      ...(mechanics.unseals ? [{ id: "unseals", label: healthLabel, cure: { unseals: true as const } }] : []),
    ];
  }
  const revival = mechanics.revives && amountOf(mechanics.revives.health);
  if (mechanics.revives && revival) action.revives = { withinRounds: mechanics.revives.withinRounds, amount: revival };
  if (mechanics.summons) {
    const { move, reach, ...summons } = mechanics.summons;
    action.summons = {
      ...summons,
      ...(move !== undefined ? { move: rulesetInCells(move, perCell ?? 1) } : {}),
      ...(reach !== undefined ? { reach: rulesetInCells(reach, perCell ?? 1) } : {}),
    };
  }
  if (mechanics.push !== undefined) action.push = rulesetInCells(mechanics.push, perCell ?? 1);
  if (mechanics.zone) {
    action.zone = {
      rounds: mechanics.zone.rounds,
      anchor: mechanics.zone.anchor ?? "point",
      triggers: [...mechanics.zone.triggers],
      atCast: mechanics.zone.atCast !== false,
    };
    const { move, drift, terrain } = mechanics.zone;
    if (move) {
      action.zone.move = {
        budget: move.budget,
        distance: rulesetInCells(move.distance, perCell ?? 1),
        ...(move.ram ? { ram: true } : {}),
      };
    }
    if (drift) action.zone.drift = rulesetInCells(drift.distance, perCell ?? 1);
    if (mechanics.zone.turn) action.zone.turn = { budget: mechanics.zone.turn.budget };
    if (terrain?.towardCaster) action.zone.towardCaster = true;
    const { detonates, burns } = mechanics.zone;
    if (detonates) {
      // What goes off later does nothing as it appears.
      action.zone.atCast = false;
      const grows = amountOf(detonates.grows);
      action.zone.detonates = { ...(grows ? { grows } : {}), ...(detonates.touched ? { touched: true } : {}) };
    }
    if (burns) {
      const amount = amountOf(burns.amount);
      action.zone.burns = {
        by: [...burns.by],
        ...(amount ? { amount } : {}),
        ...(burns.damageType ? { damageType: burns.damageType } : {}),
      };
    }
    if (terrain?.difficult) action.zone.difficult = true;
    if (terrain?.costTimes !== undefined) action.zone.costTimes = terrain.costTimes;
    if (terrain?.halvesSpeed) action.zone.halvesSpeed = true;
    if (mechanics.zone.breaksConcentration) action.zone.breaksConcentration = true;
    if (mechanics.zone.damageCap !== undefined) action.zone.damageCap = mechanics.zone.damageCap;
    if (mechanics.zone.damageType) action.zone.damageType = mechanics.zone.damageType;
    const sections = mechanics.zone.sections;
    if (sections) {
      const broken = sections.broken;
      const brokenAmount = broken ? amountOf(broken.amount) : undefined;
      action.zone.sections = {
        every: Math.max(1, rulesetInCells(sections.every, perCell ?? 1)),
        health: sections.health,
        defense: sections.defense,
        ...(sections.vulnerable ? { vulnerable: [...sections.vulnerable] } : {}),
        ...(sections.resist ? { resist: [...sections.resist] } : {}),
        ...(sections.immune ? { immune: [...sections.immune] } : {}),
        ...(broken && brokenAmount
          ? {
              broken: {
                triggers: [...broken.triggers],
                amount: brokenAmount,
                ...(broken.damageType ? { damageType: broken.damageType } : {}),
                ...(broken.save ? { save: broken.save } : {}),
                ...(broken.onSave ? { onSave: broken.onSave } : {}),
                ...(broken.perCostStep && amountOf(broken.perCostStep)
                  ? { perCostStep: amountOf(broken.perCostStep)! }
                  : {}),
              },
            }
          : {}),
      };
    }
    const blocks = mechanics.zone.blocks;
    if (blocks?.length) {
      action.zone.blocks = {
        ...(blocks.includes("move") ? { move: true } : {}),
        ...(blocks.includes("sight") ? { sight: true } : {}),
      };
    }
    const side = mechanics.zone.side;
    if (side) {
      action.zone.side = { distance: rulesetInCells(side.distance, perCell ?? 1), triggers: [...side.triggers] };
    }
    if (mechanics.zone.obscures) action.zone.obscures = { pierced: [...(mechanics.zone.obscures.pierced ?? [])] };
    const inside = mechanics.zone.inside;
    if (inside) {
      action.zone.inside = {
        ...(inside.conditions ? { conditions: [...inside.conditions] } : {}),
        ...(inside.immune ? { immune: [...inside.immune] } : {}),
      };
    }
    if (mechanics.zone.forbids) action.zone.forbids = { components: [...mechanics.zone.forbids.components] };
    if (mechanics.zone.wards) {
      action.zone.wards = {
        catalogs: [...mechanics.zone.wards.catalogs],
        maxLevel: mechanics.zone.wards.maxLevel,
        ...(mechanics.zone.wards.by ? { by: mechanics.zone.wards.by } : {}),
        ...(mechanics.zone.wards.maxLevelPerCostStep
          ? { maxLevelPerCostStep: mechanics.zone.wards.maxLevelPerCostStep }
          : {}),
      };
    }
    const held = mechanics.zone.whileHeld;
    const heldAmount = held && amountOf(held.amount);
    if (held && heldAmount) {
      action.zone.whileHeld = {
        condition: held.condition,
        amount: heldAmount,
        ...(held.damageType ? { damageType: held.damageType } : {}),
      };
    }
    const harm = terrain?.perDistance && amountOf(terrain.perDistance.amount);
    if (terrain?.perDistance && harm) {
      action.zone.perDistance = {
        every: rulesetInCells(terrain.perDistance.every, perCell ?? 1),
        amount: harm,
        ...(terrain.perDistance.damageType ? { damageType: terrain.perDistance.damageType } : {}),
      };
    }
  }
  // What the turn's own economy makes of it: free of a budget, handing budgets back, or letting
  // its holder buy a standard action with a budget other than the main one.
  if (mechanics.free) action.free = true;
  if (mechanics.gives?.length) action.gives = mechanics.gives.map((gift) => ({ ...gift }));
  if (mechanics.standard) {
    action.standard = { actions: [...mechanics.standard.actions], budget: mechanics.standard.budget };
  }
  // Distance, in the unit this CATALOG declared, or the combat block's when it declared none. A
  // range of zero is self or touch, and touching somebody else is the next cell: a REACH of one,
  // never a range, so the rules for shooting (a foe beside the shooter, long range) do not read it.
  // A shape keeps its range even at zero, because there the number says how far off it may be aimed.
  if (perCell !== undefined) {
    if (mechanics.range === 0 && !mechanics.area) action.reach = 1;
    else if (mechanics.range !== undefined) action.range = { normal: rulesetInCells(mechanics.range, perCell) };
    if (mechanics.area) {
      action.area = {
        shape: mechanics.area.shape,
        size: rulesetInCells(mechanics.area.size, perCell),
        ...(mechanics.area.width !== undefined ? { width: rulesetInCells(mechanics.area.width, perCell) } : {}),
        ...(mechanics.area.ring !== undefined ? { ring: rulesetInCells(mechanics.area.ring, perCell) } : {}),
        ...(mechanics.area.copies !== undefined ? { copies: mechanics.area.copies } : {}),
        ...(mechanics.friendlyFire === false ? { friendlyFire: false } : {}),
      };
    }
  }
  return action;
}

/** Whether one cell of a row says yes. A rider reads a column rather than a word, so a ruleset says
 *  "the rows you can do this with" in its own list without the Engine knowing what a weapon is. */
function truthyColumn(row: Record<string, unknown>, column: string): boolean {
  const value = columnValue(row, column);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The attack actions one rider fires on, resolved once when the fight begins.
 *
 * Undefined is "any hit at all", which is what a rider that names neither an attack list, a column
 * nor weapons means. Naming any turns into the ids of the rows and held weapons that qualify, so the
 * resolution never reads a sheet again: the row a rider needs may have been edited by then. A rider
 * that names only weapons fires on no row, and one that names no weapons on no held weapon.
 */
function riderActionIds(
  combat: RulesetCombat,
  build: RulesetSheetBuild,
  rider: NonNullable<RulesetCatalogMechanics["rider"]>,
  items: readonly RulesetSheetItem[] | undefined,
): string[] | undefined {
  if (!rider.sources && !rider.requires && !rider.weapons) return undefined;
  const ids: string[] = [];
  // A held weapon with one of the tags, and its off-hand strike where it has one (`itemAttackActions`'
  // ids).
  items?.forEach((held, index) => {
    if (!rider.weapons || !held.worn || !held.item.attack) return;
    if (!held.item.tags?.some((tag) => rider.weapons!.tags.includes(tag))) return;
    ids.push(`item:${index}`);
    if (held.item.attack.offHand) ids.push(`offhand:${index}`);
  });
  if (!rider.sources && !rider.requires) return ids;
  (combat.attacks ?? []).forEach((source, index) => {
    if (rider.sources && !rider.sources.includes(source.list)) return;
    const rows = build.lists?.[source.list];
    if (!Array.isArray(rows)) return;
    rows.forEach((raw, rowIndex) => {
      if (!raw || typeof raw !== "object") return;
      if (rider.requires && !truthyColumn(raw as Record<string, unknown>, rider.requires.column)) return;
      ids.push(`attack:${index}:${rowIndex}`);
    });
  });
  return ids;
}

/** The name a row answers to: the column the Game Master sees it under, then the entry's label. */
function rowName(definition: RulesetDefinition, listId: string, row: Record<string, unknown>, fallback: string) {
  const list = definition.sheet.lists.find((entry) => entry.id === listId);
  const column =
    definition.gm.sheetSummary.lists.find((entry) => entry.list === listId)?.nameColumn ??
    list?.pools?.nameColumn ??
    list?.columns.find((entry) => entry.type === "text")?.id;
  return textFromColumn(row, column) ?? fallback;
}

/** One rider a catalog entry carries, with its dice grown by the sheet exactly as an amount's are
 *  and the rows and held weapons it fires on already worked out. */
function riderFrom(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  build: RulesetSheetBuild,
  evaluated: EvaluatedRulesetSheet,
  id: string,
  label: string,
  mechanics: RulesetCatalogMechanics,
  items: readonly RulesetSheetItem[] | undefined,
): RulesetCombatRider | null {
  const declared = mechanics.rider;
  const amount = declared ? amountOf(declared.amount) : null;
  if (!declared || !amount) return null;
  const extra = mechanics.scales
    ? Math.max(
        0,
        Math.trunc(
          lookupStepTable(
            mechanics.scales.table,
            resolveRulesetValueRef(definition, build, mechanics.scales.from, evaluated),
          ),
        ),
      )
    : 0;
  const actions = riderActionIds(combat, build, declared, items);
  return {
    id,
    label,
    on: declared.on,
    ...(actions ? { actions } : {}),
    ...(declared.when?.length ? { when: [...declared.when] } : {}),
    oncePer: declared.oncePer,
    amount: { ...amount, count: amount.count + (amount.count > 0 ? extra : 0) },
    ...(declared.type ? { type: declared.type } : {}),
  };
}

function abilityActions(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  source: RulesetCombatAbilitySource,
  index: number,
  build: RulesetSheetBuild,
  catalogs: RulesetCatalogEntriesById,
  evaluated: EvaluatedRulesetSheet,
  perCell: number | undefined,
  items: readonly RulesetSheetItem[] | undefined,
): { actions: RulesetCombatAction[]; riders: RulesetCombatRider[] } {
  const rows = build.lists?.[source.list];
  if (!Array.isArray(rows)) return { actions: [], riders: [] };
  const byRef = rulesetCatalogEntriesByRef(catalogs);
  /** A catalog states what its own `range` and `area.size` numbers mean; one that does not is read
   *  in the combat block's own unit. */
  const perCellOf = (ref: string) => {
    if (perCell === undefined) return undefined;
    const catalogId = ref.slice(0, ref.indexOf("/"));
    return definition.catalogs?.find((catalog) => catalog.id === catalogId)?.units?.distance?.perCell ?? perCell;
  };
  const actions: RulesetCombatAction[] = [];
  const riders: RulesetCombatRider[] = [];
  const seen = new Set<string>();
  rows.forEach((raw, rowIndex) => {
    if (!raw || typeof raw !== "object") return;
    const row = raw as Record<string, unknown>;
    const ref = columnValue(row, RULESET_CATALOG_ROW_KEY);
    // A hand-typed row says nothing in numbers, so there is nothing to resolve.
    if (typeof ref !== "string" || seen.has(ref)) return;
    const always = source.alwaysWhen && columnValue(row, source.alwaysWhen.column) === source.alwaysWhen.equals;
    if (!always && source.onlyWhen && columnValue(row, source.onlyWhen) !== true) return;
    const entry = byRef.get(ref);
    if (!entry) return;
    const name = rowName(definition, source.list, row, entry.label);
    // A rider is passive: it never becomes an action, and it is carried by whoever holds the row.
    if (entry.mechanics?.kind === "rider") {
      const rider = riderFrom(
        definition,
        combat,
        build,
        evaluated,
        `rider:${index}:${rowIndex}`,
        name,
        entry.mechanics,
        items,
      );
      if (!rider) return;
      seen.add(ref);
      riders.push(rider);
      return;
    }
    const action = abilityAction(
      definition,
      source,
      row,
      index,
      rowIndex,
      name,
      entry,
      build,
      evaluated,
      perCellOf(ref),
    );
    if (!action) return;
    // Which catalog it came from, and which entry, which is what a reaction that answers only some
    // entries reads.
    action.catalog = ref.slice(0, ref.indexOf("/"));
    action.entry = ref;
    seen.add(ref);
    actions.push(action);
  });
  return { actions, riders };
}

/** Spells a creature casts without paying off a sheet (1.118). The entry still supplies everything
 *  it does; only its numbers, level and remaining uses belong to the creature. */
function innateActions(
  definition: RulesetDefinition,
  block: RulesetStatBlock,
  catalogs: RulesetCatalogEntriesById,
  perCell: number | undefined,
): RulesetCombatAction[] {
  const casting = block.spellcasting;
  if (!casting) return [];
  const build = block.sheet ?? rulesetSheetBuildSchema.parse({});
  const evaluated = evaluateRulesetSheetLive(definition, build, {});
  const byRef = rulesetCatalogEntriesByRef(catalogs);
  return casting.spells.flatMap((spell) => {
    const entry = byRef.get(spell.entry);
    if (!entry?.mechanics) return [];
    const catalogId = spell.entry.split("/")[0]!;
    const header = definition.catalogs?.find((catalog) => catalog.id === catalogId);
    const source = definition.combat?.abilities?.find((ability) =>
      entry.rows?.some((row) => row.list === ability.list),
    );
    const resolve = (ref: RulesetValueRef) => resolveRulesetValueRef(definition, build, ref, evaluated);
    const difficulty = casting.saveDifficulty ?? (source?.saveDifficulty ? resolve(source.saveDifficulty) : undefined);
    const action = mechanicsAction(definition, entry.mechanics, {
      id: spell.entry,
      kind: "ability",
      label: entry.label,
      budget: entry.mechanics.budget ?? source?.budget ?? definition.combat!.economy.budgets[0]!.id,
      toHit:
        casting.toHit ??
        (source?.toHit ? resolve(source.toHit) : 0) + fightAdjust(definition, build, evaluated, source?.toHit),
      ...(difficulty !== undefined ? { saveDifficulty: difficulty } : {}),
      build,
      evaluated,
      perCell: perCell === undefined ? undefined : (header?.units?.distance?.perCell ?? perCell),
    });
    if (!action) return [];
    action.catalog = catalogId;
    action.entry = spell.entry;
    const baseLevel = rulesetPaidLevel(definition, { sheet: { build, live: {}, catalogs: {} } }, action);
    action.innate = {
      level: spell.level ?? baseLevel,
      baseLevel,
      ...(spell.coven && casting.coven
        ? { coven: { ...casting.coven, within: casting.coven.within / (perCell ?? 1) } }
        : {}),
    };
    if (spell.uses) action.uses = { ...spell.uses };
    // What casting it this way needs, said by the spell or its trait, in place of the entry's (1.176).
    const components = spell.components ?? casting.components;
    if (components?.length) action.components = [...components];
    else if (components) delete action.components;
    return [action];
  });
}

/** Only the entries this member's own rows point at, so the state stays small enough to persist
 *  while `use` still knows what every ability costs. */
function narrowCatalogs(build: RulesetSheetBuild, catalogs: RulesetCatalogEntriesById): RulesetCatalogEntriesById {
  const refs = new Set<string>();
  for (const rows of Object.values(build.lists ?? {})) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const ref =
        row && typeof row === "object"
          ? columnValue(row as Record<string, unknown>, RULESET_CATALOG_ROW_KEY)
          : undefined;
      if (typeof ref === "string") refs.add(ref);
    }
  }
  const narrowed: Record<string, RulesetCatalogEntry[]> = {};
  for (const [catalogId, entries] of Object.entries(catalogs)) {
    const kept = entries.filter((entry) => refs.has(`${catalogId}/${entry.id}`));
    if (kept.length > 0) narrowed[catalogId] = kept;
  }
  return narrowed;
}

function blockActions(block: RulesetStatBlockLike, perCell: number | undefined): RulesetCombatAction[] {
  const idOf = (index: number) => block.actions[index]?.id ?? `block:${index}`;
  const indexById = new Map(block.actions.map((action, index) => [action.id ?? `block:${index}`, index]));
  /** A block writes its distances in the ruleset's own unit, and a plain number is the ordinary
   *  distance with nothing beyond it. A range of zero is no range at all, as it is on an attack row:
   *  the action is a swing at its reach, never a shot. */
  const rangeOf = (range: RulesetStatBlockAction["range"]) => {
    if (range === undefined || perCell === undefined) return undefined;
    const written = typeof range === "number" ? range : range.normal;
    if (written <= 0) return undefined;
    const normal = rulesetInCells(written, perCell);
    const long =
      typeof range === "number" || range.long === undefined ? undefined : rulesetInCells(range.long, perCell);
    return { normal, ...(long !== undefined && long > normal ? { long } : {}) };
  };
  return block.actions.map((action, index) => ({
    id: idOf(index),
    kind: "block" as const,
    label: action.name,
    budget: action.budget,
    // A sequence may be pointed at as many targets as all of its parts together, so a caller can
    // send each strike somewhere else. Fewer is legal too: every part takes the ones it was given.
    // One that lands on the creature itself points at nobody: its effect is its own.
    targets: action.self
      ? { side: "self" as const, count: 0 }
      : {
          // An area catches each creature in it, the creature's allies too (1.187): off a board it may
          // be pointed at either side, unless it spares its own.
          side: action.targets ?? (action.area && action.area.friendlyFire !== false ? "any" : ("enemy" as const)),
          count: action.sequence
            ? Math.max(
                1,
                action.sequence.reduce((total, step) => {
                  const named = block.actions[indexById.get(step.action) ?? -1];
                  return total + (named ? Math.max(1, named.targetCount ?? 1) * step.times : 0);
                }, 0),
              )
            : Math.max(1, action.targetCount ?? 1),
        },
    ...(action.toHit !== undefined ? { toHit: action.toHit } : {}),
    ...(action.autoHit ? { autoHit: true } : {}),
    ...(action.needs ? { needs: [...action.needs] } : {}),
    ...(action.seen ? { seen: true as const } : {}),
    ...(action.components ? { components: [...action.components] } : {}),
    ...(action.damage
      ? {
          damage: {
            ...action.damage,
            ...(action.damage.plus ? { plus: action.damage.plus.map((clause) => ({ ...clause })) } : {}),
          },
        }
      : {}),
    ...(action.heal ? { heal: { ...action.heal } } : {}),
    ...(action.save ? { save: { ...action.save } } : {}),
    ...(action.saveDifficulty !== undefined ? { saveDifficulty: action.saveDifficulty } : {}),
    ...(action.applies?.length ? { applies: action.applies.map((entry) => ({ ...entry })) } : {}),
    ...(action.uses ? { uses: { ...action.uses } } : {}),
    ...(action.recharge
      ? {
          recharge: {
            dice: { ...action.recharge.dice },
            from: action.recharge.from,
            ...(action.recharge.group ? { group: action.recharge.group } : {}),
          },
        }
      : {}),
    ...(action.sequence
      ? {
          sequence: action.sequence.flatMap((step) =>
            indexById.has(step.action) ? [{ actionId: step.action, times: step.times }] : [],
          ),
        }
      : {}),
    ...(action.signature ? { signature: { cost: action.signature.cost } } : {}),
    ...(action.reaction
      ? {
          reaction: {
            on: action.reaction.on,
            at: action.reaction.at ?? "source",
            ...(action.reaction.cancels ? { cancels: true as const } : {}),
            ...rulesetReactionAnswers(action.reaction, perCell),
            ...(action.reaction.cancelSave ? { cancelSave: { ...action.reaction.cancelSave } } : {}),
            ...(action.reaction.upTo ? { upTo: action.reaction.upTo } : {}),
            ...(action.reaction.above
              ? { above: { modifier: action.reaction.above.check.const ?? 0, dc: action.reaction.above.dc } }
              : {}),
          },
        }
      : {}),
    ...(action.ability ? { ability: action.ability } : {}),
    ...(action.reducesMax ? { reducesMax: { ...action.reducesMax } } : {}),
    ...(perCell !== undefined && action.push !== undefined ? { push: rulesetInCells(action.push, perCell) } : {}),
    // A run is measured on a board (1.181), so a fight with none never charges.
    ...(perCell !== undefined && action.charge
      ? {
          charge: {
            ...structuredClone(action.charge),
            atLeast: rulesetInCells(action.charge.atLeast, perCell),
            ...(action.charge.push !== undefined ? { push: rulesetInCells(action.charge.push, perCell) } : {}),
          },
        }
      : {}),
    // A reach written as 0 is no reach, exactly as a weapon column reading 0 is: without it a
    // creature that only shoots would be read as swinging, and could strike a passer-by.
    ...(perCell !== undefined && action.reach !== undefined && action.reach > 0
      ? { reach: rulesetInCells(action.reach, perCell) }
      : {}),
    ...(rangeOf(action.range) ? { range: rangeOf(action.range)! } : {}),
    ...(perCell !== undefined && action.area
      ? {
          area: {
            shape: action.area.shape,
            size: rulesetInCells(action.area.size, perCell),
            ...(action.area.width !== undefined ? { width: rulesetInCells(action.area.width, perCell) } : {}),
            ...(action.area.friendlyFire === false ? { friendlyFire: false } : {}),
          },
        }
      : {}),
  }));
}

/**
 * A combatant built from a sheet: every number it fights with read off the ruleset's own
 * declarations. A party member is one, and so is an opponent whose creature carries a sheet, which
 * is why this is one function rather than two that could drift apart.
 */
function sheetCombatant(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  input: {
    id: string;
    name: string;
    side: RulesetCombatant["side"];
    /** The initiative dice already thrown, for a ruleset that adds them up; one that throws a pool
     *  throws it here, off the evaluated sheet, with `roll`. */
    initiativeRoll: number[];
    roll: RulesetCombatRoller;
    build: RulesetSheetBuild;
    live: RulesetLiveState;
    catalogs: RulesetCatalogEntriesById;
    perCell: number | undefined;
    items?: ReadonlyArray<RulesetSheetItem>;
  },
): RulesetCombatant {
  const { build, perCell } = input;
  // Against the fighter's live state as the fight found it, so a value that reads a track or a pool
  // (a speed an injury slows) is the one this fight uses; and against what they hold, for a value
  // that reads their items (a defense their armor gives).
  const evaluated = evaluateRulesetSheetLive(definition, build, input.live, input.items);
  const catalogs = narrowCatalogs(build, input.catalogs);
  // Initiative is a roll too, so `resolution.adjust` counts on it as it does on a check.
  const modifier = combat.initiative.modifier
    ? resolveRulesetValueRef(definition, build, combat.initiative.modifier, evaluated) +
      fightAdjust(definition, build, evaluated, combat.initiative.modifier)
    : 0;
  const initiative = combat.initiative.pool
    ? rulesetPoolInitiative(
        definition,
        combat,
        input.roll,
        resolveRulesetValueRef(definition, build, combat.initiative.pool, evaluated) +
          fightAdjust(definition, build, evaluated, combat.initiative.pool),
      )
    : { roll: input.initiativeRoll, modifier, total: sumOf(input.initiativeRoll) + modifier };
  const saves: Record<string, number> = {};
  for (const save of definition.sheet.saves) {
    const target: RulesetCheckTarget = {
      type: "save",
      id: save.id,
      label: save.label,
      ...(save.ability ? { ability: save.ability } : {}),
    };
    saves[save.id] = rulesetCheckModifier(evaluated, target) + fightAdjust(definition, build, evaluated, target);
  }
  // What a contest reads, off the same sheet as everything else. Only when the ruleset has any, so a
  // fight on one that does not carries exactly what it always did.
  const checks = combat.checks?.length
    ? Object.fromEntries(
        combat.checks.map((check) => [
          check.id,
          Math.round(
            resolveRulesetValueRef(definition, build, check.value, evaluated) +
              fightAdjust(definition, build, evaluated, check.value),
          ),
        ]),
      )
    : undefined;
  const abilities = (combat.abilities ?? []).map((source, index) =>
    abilityActions(definition, combat, source, index, build, catalogs, evaluated, perCell, input.items),
  );
  const actions = [
    ...(combat.attacks ?? []).flatMap((source, index) =>
      attackActions(definition, combat, source, index, build, evaluated, perCell),
    ),
    ...itemAttackActions(definition, combat, input.items, build, evaluated, perCell),
    ...itemSwitchActions(input.items),
    ...itemUseActions(definition, combat, input.items, build, evaluated, perCell),
    ...abilities.flatMap((entry) => entry.actions),
  ];
  const riders = abilities.flatMap((entry) => entry.riders);
  // What they soak and what they may spend, read once like their defense.
  const read = (ref: RulesetValueRef) =>
    Math.max(0, Math.round(resolveRulesetValueRef(definition, build, ref, evaluated)));
  const soakRule = combat.pool?.soak;
  const soak: RulesetCombatSoak | undefined = soakRule
    ? {
        ...(soakRule.all ? { all: read(soakRule.all) } : {}),
        ...(soakRule.byKind
          ? { byKind: Object.fromEntries(Object.entries(soakRule.byKind).map(([kind, ref]) => [kind, read(ref)])) }
          : {}),
      }
    : undefined;
  const hardness = combat.pool?.hardness ? read(combat.pool.hardness) : 0;
  const limits = combat.spendLimits?.length
    ? Object.fromEntries(
        combat.spendLimits.map((limit) => [limit.pool, { max: read(limit.max), per: limit.per, spent: 0 }]),
      )
    : undefined;
  return {
    id: input.id,
    name: input.name,
    side: input.side,
    initiativeRoll: initiative.roll,
    initiativeModifier: initiative.modifier,
    initiative: initiative.total,
    budgets: fullBudgets(combat),
    actions,
    uses: startingUses(actions),
    spent: [],
    ...(riders.length > 0 ? { riders } : {}),
    tracked: [],
    concentrating: null,
    flags: {},
    down: false,
    dying: false,
    stable: false,
    defeated: false,
    defense: Math.round(resolveRulesetValueRef(definition, build, combat.defense, evaluated)),
    // A sheet that reads under 2 (a field left at 0 for whoever has no range) is no range at all.
    ...(() => {
      const ref = combat.attackRoll?.criticalFrom;
      const from = ref ? Math.round(resolveRulesetValueRef(definition, build, ref, evaluated)) : NaN;
      return Number.isFinite(from) && from >= 2 ? { criticalFrom: from } : {};
    })(),
    saves,
    ...(checks ? { checks } : {}),
    ...(() => {
      const size = sheetSize(definition, combat, build, evaluated);
      return size !== undefined ? { size } : {};
    })(),
    // How far each of the fight's senses reaches off this sheet (1.173), in cells; nought is none.
    ...(() => {
      const perCell = combat.distance?.perCell;
      if (!combat.senses || perCell === undefined) return {};
      const senses: Record<string, number> = {};
      for (const sense of combat.senses) {
        const range = sense.sheet ? resolveRulesetValueRef(definition, build, sense.sheet, evaluated) : 0;
        if (Number.isFinite(range) && range > 0) senses[sense.id] = rulesetInCells(range, perCell);
      }
      return Object.keys(senses).length > 0 ? { senses } : {};
    })(),
    ...(soak ? { soak } : {}),
    ...(hardness > 0 ? { hardness } : {}),
    ...(limits ? { limits } : {}),
    speed: combat.economy.movement ? resolveRulesetValueRef(definition, build, combat.economy.movement, evaluated) : 0,
    // Ways of moving besides walking, off the same sheet (1.108). Nought is not moving that way.
    ...(() => {
      const speeds: RulesetMoveSpeeds = {};
      for (const mode of RULESET_MOVE_MODES) {
        const ref = combat.economy.movementModes?.[mode];
        const speed = ref ? resolveRulesetValueRef(definition, build, ref, evaluated) : 0;
        if (Number.isFinite(speed) && speed > 0) speeds[mode] = speed;
      }
      return Object.keys(speeds).length > 0 ? { speeds } : {};
    })(),
    sheet: { build, live: input.live, catalogs, ...(input.items ? { items: input.items } : {}) },
  };
}

/**
 * One action per contest the ruleset declares, the same for everybody: whoever is in a fight may grab
 * or shove. A contest that takes the place of a strike buys as many as the actor's own actions on
 * the same budget do, so it is paid for, and paid out of strikes in hand, exactly as they are.
 */
function contestActions(
  combat: RulesetCombat,
  actions: readonly RulesetCombatAction[],
  perCell: number | undefined,
): RulesetCombatAction[] {
  return (combat.contests ?? []).map((contest) => {
    const strikes = contest.strike
      ? Math.max(
          0,
          ...actions.flatMap((action) =>
            action.budget === contest.budget && action.strikes !== undefined ? [action.strikes] : [],
          ),
        )
      : 0;
    return {
      id: `contest:${contest.id}`,
      kind: "contest",
      label: contest.label,
      budget: contest.budget,
      targets: { side: contest.targets ?? "enemy", count: 1 },
      ...(contest.reach !== undefined && perCell !== undefined
        ? { reach: rulesetInCells(contest.reach, perCell) }
        : {}),
      ...(strikes > 0 ? { strikes } : {}),
      contest: {
        id: contest.id,
        ...(contest.strike ? { strike: true as const } : {}),
        attacker: [...contest.attacker.checks],
        defender: [...(contest.defender?.checks ?? [])],
        ...(contest.difficulty !== undefined ? { difficulty: contest.difficulty } : {}),
        ...(contest.targetHolds ? { targetHolds: contest.targetHolds } : {}),
        ...(contest.targetDying ? { targetDying: true as const } : {}),
        ...(contest.onWin.stabilizes ? { stabilizes: true as const } : {}),
        ties: contest.ties,
        ...(contest.from ? { from: contest.from.holding } : {}),
        ...(contest.from?.escapable ? { escapable: true as const } : {}),
        ...(contest.maxSizeAbove !== undefined ? { maxSizeAbove: contest.maxSizeAbove } : {}),
        ...(contest.onWin.applies ? { applies: contest.onWin.applies.map((entry) => ({ ...entry })) } : {}),
        ...(contest.onWin.ends ? { ends: contest.onWin.ends.map((entry) => ({ ...entry })) } : {}),
        ...(contest.onWin.push !== undefined && perCell !== undefined
          ? { push: rulesetInCells(contest.onWin.push, perCell) }
          : {}),
      },
    };
  });
}

/** What an action still has left of itself, before anything is spent on it. */
function startingUses(actions: readonly RulesetCombatAction[]): Record<string, number> {
  const uses: Record<string, number> = {};
  for (const action of actions) if (action.uses && !action.innate?.coven) uses[action.id] = action.uses.count;
  return uses;
}

type RulesetStatBlockLike = NonNullable<RulesetCombatant["block"]>;

/** Full budgets, as a fresh turn and a fresh round hand them out: the declared count, and what the
 *  holder's conditions add or take away (combat C6d), never below none. */
export function refreshRulesetBudgets(
  combat: RulesetCombat,
  budgets: Record<string, number>,
  per: "turn" | "round",
  changes?: ReadonlyMap<string, number>,
) {
  for (const budget of combat.economy.budgets) {
    if (budget.per === per) budgets[budget.id] = Math.max(0, budget.count + (changes?.get(budget.id) ?? 0));
  }
}

/** What a combatant's conditions do to their action economy (combat C6d, as Haste and Slow do): turn
 *  budgets added or taken away, what other budgets may be spent on, budgets of which a turn may spend
 *  only one, and the fewest attacks a turn any of them allows. */
export interface RulesetConditionEconomy {
  budgets: Map<string, number>;
  grants: NonNullable<RulesetCombatCondition["grants"]>[];
  exclusive: Array<[string, string]>;
  attacksPerTurn?: number;
}
export function rulesetConditionEconomy(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
  state?: RulesetEncounterState,
): RulesetConditionEconomy {
  const economy: RulesetConditionEconomy = { budgets: new Map(), grants: [], exclusive: [] };
  for (const entry of rulesetActiveConditions(definition, combat, combatant, state)) {
    for (const change of entry.budgets ?? []) {
      economy.budgets.set(change.budget, (economy.budgets.get(change.budget) ?? 0) + change.flat);
    }
    if (entry.grants) economy.grants.push(entry.grants);
    if (entry.exclusive) economy.exclusive.push(entry.exclusive);
    if (entry.attacksPerTurn !== undefined) {
      economy.attacksPerTurn = Math.min(economy.attacksPerTurn ?? entry.attacksPerTurn, entry.attacksPerTurn);
    }
  }
  return economy;
}

function fullBudgets(combat: RulesetCombat): Record<string, number> {
  const budgets: Record<string, number> = {};
  for (const budget of combat.economy.budgets) budgets[budget.id] = budget.count;
  return budgets;
}

/**
 * How far this combatant may walk in one turn, in CELLS: their own speed in the ruleset's own unit,
 * divided by what a cell is worth and rounded DOWN, and never less than one while they can move at
 * all. A condition that stops them moving makes it nothing.
 *
 * Rounded down rather than up, because a turn's movement is a budget a player spends: rounding it
 * up would quietly hand every fast thing an extra cell it was never given.
 */
export function rulesetMovementAllowance(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
  state?: RulesetEncounterState,
  /** One way of moving's own speed (1.108). Their fastest when left out. */
  base: number = rulesetFastestSpeed(combatant),
): number {
  const perCell = combat.distance?.perCell;
  if (perCell === undefined || !(perCell > 0)) return 0;
  if (rulesetCombatEffects(definition, combat, combatant, state).has("speed-zero")) return 0;
  // What a condition does to speed: every flat change first, then halving or doubling, so "10 feet
  // slower, and half speed" is half of what is left.
  const changes = rulesetConditionModifiers(definition, combat, combatant, "speed", state);
  let speed = base;
  for (const { modifier } of changes) speed += modifier.flat ?? 0;
  for (const { modifier } of changes) speed *= modifier.times ?? 1;
  if (!Number.isFinite(speed) || speed <= 0) return 0;
  return Math.max(1, Math.floor(speed / perCell));
}

/** The fastest way this combatant moves, walking included (1.108). */
export function rulesetFastestSpeed(combatant: RulesetCombatant): number {
  return Math.max(combatant.speed, ...Object.values(combatant.speeds ?? {}).map((speed) => speed ?? 0));
}

/** Each way somebody moves besides walking, and walking, as an allowance in cells (1.108). Undefined
 *  for somebody who only walks. */
export function rulesetModeAllowances(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
  state?: RulesetEncounterState,
): Partial<Record<RulesetMoveMode, number>> | undefined {
  if (!combatant.speeds) return undefined;
  const allowances: Partial<Record<RulesetMoveMode, number>> = {
    walk: combatant.speed > 0 ? rulesetMovementAllowance(definition, combat, combatant, state, combatant.speed) : 0,
  };
  for (const mode of RULESET_MOVE_MODES) {
    const speed = combatant.speeds[mode];
    if (speed) allowances[mode] = rulesetMovementAllowance(definition, combat, combatant, state, speed);
  }
  return allowances;
}

/** A turn's allowance on top of what is left: a dash, or a fresh turn from nothing (1.108 adds each
 *  way of moving's own). */
export function grantRulesetMovement(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
  state?: RulesetEncounterState,
): void {
  combatant.movementLeft =
    (combatant.movementLeft ?? 0) + rulesetMovementAllowance(definition, combat, combatant, state);
  const modes = rulesetModeAllowances(definition, combat, combatant, state);
  if (!modes) return;
  const left = (combatant.modeLeft ??= {});
  for (const [mode, cells] of Object.entries(modes) as Array<[RulesetMoveMode, number]>) {
    left[mode] = (left[mode] ?? 0) + cells;
  }
}

/** Cells moved, or spent standing up: off the allowance, and off every way of moving alike (1.108). */
export function spendRulesetMovement(combatant: RulesetCombatant, cells: number): void {
  combatant.movementLeft = Math.max(0, (combatant.movementLeft ?? 0) - cells);
  if (!combatant.modeLeft) return;
  for (const mode of Object.keys(combatant.modeLeft) as RulesetMoveMode[]) {
    combatant.modeLeft[mode] = Math.max(0, (combatant.modeLeft[mode] ?? 0) - cells);
  }
}

/** The allowance back to full at the start of the holder's own turn. */
export function refreshRulesetMovement(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
  state?: RulesetEncounterState,
): void {
  if (combatant.movement === undefined) return;
  const allowance = rulesetMovementAllowance(definition, combat, combatant, state);
  combatant.movement = allowance;
  combatant.movementLeft = 0;
  if (combatant.modeLeft) combatant.modeLeft = {};
  grantRulesetMovement(definition, combat, combatant, state);
}

// ── Starting the fight ──

export interface RulesetEncounterInput {
  definition: RulesetDefinition;
  seed: number;
  combatants: RulesetCombatantInput[];
  /** The bestiary catalogs an opponent given as `{ creature: ... }` is looked up in. Fetching them
   *  is the caller's job, exactly as it is for a party member's own catalogs. */
  bestiary?: RulesetCatalogEntriesById;
  /** A caller with its own dice. The seeded roller is used when none is given. */
  roller?: RulesetCombatRoller;
  /**
   * The board this fight stands on, and where everybody starts. The grid is the tactical engine's
   * own, generated by the caller: a fight never makes one of its own.
   *
   * A fight is positioned only when the ruleset says what a cell is worth (`combat.distance`) AND
   * every combatant in it has a cell. Anything less and the board is left out entirely, so a fight
   * is never half on a grid.
   */
  board?: { grid: TacticalGrid; placements: Record<string, { x: number; y: number }>; battlefield?: unknown };
}

/**
 * A fight, ready for its first turn. Initiative is rolled once, here, as the kind says: a tie goes
 * to the higher modifier, and then to the order the combatants were handed in, so the same input
 * and the same seed always produce the same order.
 *
 * A ruleset with no `combat` block cannot resolve a fight, so it comes back as an encounter with
 * nobody in it rather than throwing: the caller reads the outcome and falls back to what it did
 * before.
 */
export function createRulesetEncounter(input: RulesetEncounterInput): RulesetEncounterState {
  const { definition, seed } = input;
  const combat = definition.combat;
  const state: RulesetEncounterState = {
    v: 1,
    ruleset: { id: definition.id, version: definition.version },
    seed,
    cursor: 0,
    round: 1,
    turn: 0,
    order: [],
    combatants: [],
    opening: [],
  };
  if (!combat) return state;

  let rolls = 0;
  const roller = input.roller ?? rulesetCombatRoller(seed, 0);
  const roll: RulesetCombatRoller = (sides) => {
    rolls += 1;
    return roller(sides);
  };
  // What every distance in this fight is measured in. Undefined is a ruleset that gives no size to
  // a cell, and then nothing about distance is read at all: the fight is exactly what it was before.
  const perCell = combat.distance?.perCell;

  const refused: RulesetCombatEvent[] = [];
  for (const entry of input.combatants) {
    if (entry.side === "enemy") {
      // A bestiary reference that names nothing is left out of the fight rather than walked in with
      // no numbers, and the opening says so.
      const block =
        "block" in entry
          ? entry.block
          : rulesetCreatureBlock(definition, findRulesetCreatureEntry(input.bestiary ?? {}, entry.creature));
      if (!block) {
        refused.push({ type: "refused", actorId: entry.id, reason: "unknown-creature" });
        continue;
      }
      const initiativeRoll = throwInitiativeDice(combat, roll);
      if (block.sheet) {
        // Described in the ruleset's own terms, so built exactly as a party member is: its health,
        // defense, saves, speed, initiative and the abilities on its lists all come from what the
        // ruleset declares. The sheet exists for this fight only and is written back nowhere. What
        // the block adds on top (its own actions, points, riders and the damage it shrugs off)
        // is kept beside it.
        const combatant = sheetCombatant(definition, combat, {
          id: entry.id,
          name: entry.name,
          side: "enemy",
          initiativeRoll,
          roll,
          build: block.sheet,
          live: {},
          catalogs: input.bestiary ?? {},
          perCell,
        });
        combatant.actions = [
          ...combatant.actions,
          ...blockActions(block, perCell),
          ...innateActions(definition, block, input.bestiary ?? {}, perCell),
        ];
        combatant.uses = startingUses(combatant.actions);
        if (block.signaturePoints !== undefined) {
          combatant.signature = { points: block.signaturePoints, max: block.signaturePoints };
        }
        if (block.riders?.length) {
          combatant.riders = [...(combatant.riders ?? []), ...block.riders.map((rider) => ({ ...rider }))];
        }
        combatant.block = block;
        // A creature that names its size is that size, whatever its sheet reads.
        if (block.size !== undefined && combat.sizes) combatant.size = block.size;
        // And one that names how it moves moves that way, whatever its sheet reads.
        if (block.speeds) combatant.speeds = { ...block.speeds };
        if (block.hover) combatant.hover = true;
        if ("creature" in entry) combatant.creature = { ...entry.creature };
        // A sheet that gives it no health at all is a creature that could never be hurt or ever
        // stand: left out, and the opening says why, rather than walked in as something unkillable.
        const health = rulesetCombatHealth(definition, combat, combatant);
        if (health.max <= 0) {
          refused.push({ type: "refused", actorId: entry.id, reason: "no-health" });
          continue;
        }
        state.combatants.push(combatant);
        continue;
      }
      // A block that is neither: no sheet, and missing a number it cannot fight without. A schema
      // keeps every shipped creature out of here; this keeps a hand-built one out too.
      if (!isRulesetPlainStatBlock(block)) {
        refused.push({ type: "refused", actorId: entry.id, reason: "unknown-creature" });
        continue;
      }
      // A pool's initiative is its own number of dice, thrown before anything else about it.
      const initiative = combat.initiative.pool
        ? rulesetPoolInitiative(definition, combat, roll, block.initiativeModifier)
        : {
            roll: initiativeRoll,
            modifier: block.initiativeModifier,
            total: sumOf(initiativeRoll) + block.initiativeModifier,
          };
      // Dice health is thrown once, here, so the same seed always builds the same opponent.
      const health = block.healthDice
        ? sumOf(rollRulesetDice(roll, block.healthDice.count, block.healthDice.sides)) + block.healthDice.flat
        : block.health;
      const max = Math.max(1, health);
      const actions = [
        ...blockActions(block, perCell),
        ...innateActions(definition, block, input.bestiary ?? {}, perCell),
      ];
      state.combatants.push({
        id: entry.id,
        name: entry.name,
        side: "enemy",
        ...("creature" in entry ? { creature: { ...entry.creature } } : {}),
        initiativeRoll: initiative.roll,
        initiativeModifier: initiative.modifier,
        initiative: initiative.total,
        budgets: fullBudgets(combat),
        actions,
        uses: startingUses(actions),
        spent: [],
        ...(block.signaturePoints !== undefined
          ? { signature: { points: block.signaturePoints, max: block.signaturePoints } }
          : {}),
        ...(block.riders?.length ? { riders: block.riders.map((rider) => ({ ...rider })) } : {}),
        tracked: [],
        concentrating: null,
        flags: {},
        down: false,
        dying: false,
        stable: false,
        defeated: false,
        defense: block.defense,
        saves: { ...(block.saves ?? {}) },
        ...(combat.checks?.length
          ? { checks: Object.fromEntries(combat.checks.map((check) => [check.id, block.checks?.[check.id] ?? 0])) }
          : {}),
        ...(block.soak && rulesetCombatIsPool(combat)
          ? {
              soak: {
                ...(block.soak.all !== undefined ? { all: block.soak.all } : {}),
                ...(block.soak.byKind ? { byKind: { ...block.soak.byKind } } : {}),
              },
            }
          : {}),
        ...(block.hardness && rulesetCombatIsPool(combat) ? { hardness: block.hardness } : {}),
        ...(() => {
          const size = combat.sizes ? (block.size ?? combat.sizes.default) : undefined;
          return size !== undefined ? { size } : {};
        })(),
        speed: block.speed ?? 0,
        ...(block.speeds ? { speeds: { ...block.speeds } } : {}),
        ...(block.hover ? { hover: true as const } : {}),
        ...(() => {
          const tracks = { ...(block.tracks ?? {}), ...("tracks" in entry ? (entry.tracks ?? {}) : {}) };
          return Object.keys(tracks).length ? { tracks } : {};
        })(),
        block,
        health: { value: max, max, temp: 0 },
      });
      continue;
    }
    const initiativeRoll = throwInitiativeDice(combat, roll);
    const combatant = sheetCombatant(definition, combat, {
      id: entry.id,
      name: entry.name,
      side: "party",
      initiativeRoll,
      roll,
      build: entry.build,
      live: readStoredLive(entry.live),
      catalogs: entry.catalogs ?? {},
      perCell,
      ...(entry.items ? { items: entry.items } : {}),
    });
    // A member who walked in at zero is already down, which is the honest reading of their sheet.
    const health = rulesetCombatHealth(definition, combat, combatant);
    if (health.value <= 0 && health.max > 0) {
      combatant.down = true;
      combatant.dying = !!combat.dying;
      if (combat.dying?.condition) {
        writeRulesetSheet(definition, combatant, { op: "condition", condition: combat.dying.condition, active: true });
      }
    }
    state.combatants.push(combatant);
  }

  // Everybody's contests, last, so one that takes the place of a strike can see what strikes the
  // actor's own actions buy. A ruleset with none adds nothing, and its fights are what they were.
  if (combat.contests?.length) {
    for (const combatant of state.combatants) {
      combatant.actions = [...combatant.actions, ...contestActions(combat, combatant.actions, perCell)];
    }
  }

  // Grown or shrunk by what they held as the fight began (1.190), before anybody is set down.
  rulesetSyncSizes(definition, state);
  placeRulesetCombatants(definition, combat, state, input.board);
  // A turn's budgets as conditions held from before the fight change them (combat C6d): the first
  // actor's turn begins now and never passes through the turn's own refill.
  for (const combatant of state.combatants) {
    const economy = rulesetConditionEconomy(definition, combat, combatant, state);
    if (economy.budgets.size) refreshRulesetBudgets(combat, combatant.budgets, "turn", economy.budgets);
  }

  const leveled = openLevels(definition, combat, state);
  state.order = rulesetInitiativeOrder(state.combatants);
  state.cursor = rolls;
  // Whoever a level took out never takes the first turn.
  state.turn = Math.max(
    0,
    state.order.findIndex((id) => !rulesetCombatant(state, id)?.defeated),
  );
  const crashed = openCrashes(definition, combat, state);
  state.opening = [
    ...refused,
    {
      type: "initiative",
      entries: state.order.flatMap((id) => {
        const combatant = rulesetCombatant(state, id);
        return combatant
          ? [
              {
                actorId: id,
                roll: combatant.initiativeRoll,
                modifier: combatant.initiativeModifier,
                total: combatant.initiative,
              },
            ]
          : [];
      }),
    },
    ...leveled,
    ...crashed,
    { type: "round", round: 1 },
    ...(state.order[state.turn]
      ? ([{ type: "turn", actorId: state.order[state.turn], round: 1 }] as RulesetCombatEvent[])
      : []),
  ];
  const first = currentRulesetActor(state);
  if (first) {
    const waiting = state.order.filter((id) => {
      const holder = rulesetCombatant(state, id);
      return holder && rulesetReactionsAt(definition, combat, state, holder, "turn-start", first.id).length > 0;
    });
    if (waiting.length) {
      state.windows = 1;
      state.window = {
        id: "w1",
        kind: "reaction",
        waiting,
        trigger: { kind: "turn-start", sourceId: first.id, label: first.name },
      };
      state.opening.push({
        type: "window",
        window: "w1",
        kind: "reaction",
        waiting: [...waiting],
        moment: "turn-start",
        sourceId: first.id,
        label: first.name,
      });
    }
  }
  return state;
}

/** Whether a creature shrugs this condition off, read the same way wherever one is put on. */
export function rulesetImmuneToCondition(
  combatant: RulesetCombatant,
  condition: string,
  /** Given, what the fighter's items keep off counts too. */
  definition?: RulesetDefinition,
  state?: RulesetEncounterState,
  /** Given, who would put it on, which a condition's `conditionImmunitiesFrom` reads (1.186). */
  source?: RulesetCombatant,
): boolean {
  const wanted = condition.trim().toLowerCase();
  // Read reached levels without asking immunity again: a track's own immunity must not recurse.
  const immunities = definition
    ? rulesetCombatHide(definition, combatant, state, true).conditionImmunities
    : (combatant.block?.conditionImmunities ?? []);
  if (immunities.some((entry) => entry.trim().toLowerCase() === wanted)) return true;
  if (!source || !definition?.combat) return false;
  return rulesetActiveConditions(definition, definition.combat, combatant, state, true).some((entry) =>
    entry.conditionImmunitiesFrom?.some(
      (one) =>
        one.conditions.some((id) => id.trim().toLowerCase() === wanted) &&
        rulesetTargetIs(definition, source, one.from),
    ),
  );
}

/**
 * What the levels each combatant has reached do as the fight begins (1.110): a halved maximum holds
 * the health they bring to it, so a blow is taken off what they really have, and a level that
 * defeats takes them out before anybody moves.
 */
function openLevels(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  state: RulesetEncounterState,
): RulesetCombatEvent[] {
  if (!combat.levels?.some((level) => level.defeats || level.modifiers?.some((one) => one.to === "health-max"))) {
    return [];
  }
  const events: RulesetCombatEvent[] = [];
  for (const combatant of state.combatants) {
    const health = rulesetCombatHealth(definition, combat, combatant);
    // Only the points they bring are held: the stored maximum stays whole, and is halved as it is read.
    if (combatant.health) combatant.health.value = Math.min(combatant.health.value, health.max);
    else if (combatant.sheet && !("track" in combat.health)) {
      const live = readRulesetLive(definition, combatant.sheet.build, combatant.sheet.live);
      const pool = live.pools.find((entry) => !entry.listId && entry.key === (combat.health as { pool: string }).pool);
      if (pool && pool.value > health.max) {
        writeRulesetSheet(definition, combatant, { op: "spend", pool: pool.key, amount: pool.value - health.max });
      }
    }
    if (rulesetActiveConditions(definition, combat, combatant, state).some((entry) => entry.defeats)) {
      combatant.down = true;
      combatant.dying = false;
      combatant.defeated = true;
      events.push({ type: "defeated", actorId: combatant.id });
    }
  }
  return events;
}

/** Where initiative is a number attacks move, whoever opens at the crash line or below starts the
 *  fight crashed, exactly as if a blow had put them there, only from nobody. */
function openCrashes(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  state: RulesetEncounterState,
): RulesetCombatEvent[] {
  const crash = combat.initiative.resource?.crash;
  if (!crash) return [];
  const events: RulesetCombatEvent[] = [];
  for (const combatant of state.combatants) {
    if (combatant.initiative > crash.at) continue;
    combatant.crashedTurns = 0;
    const condition = crash.condition;
    if (!condition) continue;
    if (rulesetImmuneToCondition(combatant, condition, definition)) {
      events.push({ type: "condition", targetId: combatant.id, condition, active: false, reason: "immune" });
      continue;
    }
    combatant.tracked.push({ condition, rounds: null });
    if (combatant.sheet) writeRulesetSheet(definition, combatant, { op: "condition", condition, active: true });
    events.push({ type: "condition", targetId: combatant.id, condition, active: true, reason: "applied" });
  }
  return events;
}

/** Who acts first: the highest initiative, then the higher modifier, then whoever joined the fight
 *  first. The order a fight opens with, and the one a round that throws initiative again re-sorts to. */
export function rulesetInitiativeOrder(combatants: readonly RulesetCombatant[]): string[] {
  const position = new Map(combatants.map((combatant, index) => [combatant.id, index]));
  return [...combatants]
    .sort(
      (a, b) =>
        b.initiative - a.initiative ||
        b.initiativeModifier - a.initiativeModifier ||
        (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0),
    )
    .map((combatant) => combatant.id);
}

/** A combatant's initiative modifier as it stands now, or the dice of their initiative pool when the
 *  ruleset throws one: off their sheet against its live state, so a wound that slows them counts
 *  when initiative is thrown again, and a block's own number otherwise. */
export function rulesetInitiativeModifierNow(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  combatant: RulesetCombatant,
): number {
  if (!combatant.sheet) return combatant.initiativeModifier;
  const ref = combat.initiative.pool ?? combat.initiative.modifier;
  if (!ref) return 0;
  const evaluated = evaluateRulesetSheetLive(
    definition,
    combatant.sheet.build,
    combatant.sheet.live,
    combatant.sheet.items,
  );
  return (
    resolveRulesetValueRef(definition, combatant.sheet.build, ref, evaluated) +
    fightAdjust(definition, combatant.sheet.build, evaluated, ref)
  );
}

/** The initiative dice of a ruleset that adds them up, thrown; none for one that throws a pool. */
export function throwInitiativeDice(combat: RulesetCombat, roll: RulesetCombatRoller): number[] {
  const dice = combat.initiative.dice;
  return dice ? rollRulesetDice(roll, dice.count, dice.sides) : [];
}

/** Initiative thrown as a pool of `dice` dice: its successes, plus the ruleset's own number. The
 *  pool's size stands in as the modifier, which is what an order tie is broken on. */
export function rulesetPoolInitiative(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  roll: RulesetCombatRoller,
  dice: number,
): { roll: number[]; modifier: number; total: number } {
  const thrown = throwRulesetCombatPool(definition, roll, dice);
  return { roll: thrown.rolls, modifier: dice, total: thrown.successes + (combat.initiative.plus ?? 0) };
}

/** How many cells a side this combatant's size fills (1.189), one when nothing says more. */
export function rulesetSizeSpan(combat: RulesetCombat, combatant: RulesetCombatant): number {
  if (combatant.size === undefined) return 1;
  return combat.sizes?.order.find((size) => size.id === combatant.size)?.cells ?? 1;
}

/** The nearest top-left cell to `at` where `span` cells a side fit (1.189): inside the board, on
 *  nothing solid and on nobody in `taken`. Null when nowhere on the board will do. */
export function rulesetFitCell(
  grid: TacticalGrid,
  at: { x: number; y: number },
  span: number,
  taken: ReadonlySet<string>,
): { x: number; y: number } | null {
  const fits = (x: number, y: number) => fitsAt(grid, { x, y }, span, taken);
  for (let ring = 0; ring <= Math.max(grid.width, grid.height); ring++) {
    for (let y = at.y - ring; y <= at.y + ring; y++) {
      for (let x = at.x - ring; x <= at.x + ring; x++) {
        if (Math.max(Math.abs(x - at.x), Math.abs(y - at.y)) !== ring) continue;
        if (fits(x, y)) return { x, y };
      }
    }
  }
  return null;
}

function fitsAt(grid: TacticalGrid, at: { x: number; y: number }, span: number, taken: ReadonlySet<string>): boolean {
  return (
    at.x >= 0 &&
    at.y >= 0 &&
    at.x + span <= grid.width &&
    at.y + span <= grid.height &&
    rulesetFootprintAt(at, span).every(
      (cell) => !taken.has(`${cell.x},${cell.y}`) && !rulesetCellBlocked(grid, cell.x, cell.y),
    )
  );
}

/**
 * Everybody's size as the conditions they hold now say (1.190): each condition's `size.steps` moves
 * them along `combat.sizes`, never past its ends, and with none they are their own size again.
 *
 * On a board somebody who grows fills their new size over every cell they stood on, where it fits
 * on open ground clear of everybody else, or the biggest size short of it that fits, as 5e's Enlarge
 * grows only as big as there is room for; nobody else is moved to make room. Somebody who shrinks
 * keeps their top-left cell. Returns who changed, each once.
 */
export function rulesetSyncSizes(
  definition: RulesetDefinition,
  state: RulesetEncounterState,
): Array<{ targetId: string; size: string; label: string }> {
  const combat = definition.combat;
  const order = combat?.sizes?.order;
  if (!combat || !order) return [];
  const changed: Array<{ targetId: string; size: string; label: string }> = [];
  const grid = state.board?.grid;
  for (const combatant of state.combatants) {
    const own = combatant.baseSize ?? combatant.size ?? combat.sizes!.default;
    const steps = rulesetActiveConditions(definition, combat, combatant, state).reduce(
      (sum, entry) => sum + (entry.size?.steps ?? 0),
      0,
    );
    if (steps === 0 && combatant.baseSize === undefined) continue;
    const from = order.findIndex((size) => size.id === own);
    const now = order.findIndex((size) => size.id === (combatant.size ?? combat.sizes!.default));
    if (from < 0 || now < 0) continue;
    const want = Math.max(0, Math.min(order.length - 1, from + steps));
    let to = want;
    let at = rulesetPositionOf(combatant);
    if (grid && at && want > now) {
      // Growing: over every cell they fill now, the biggest that fits.
      const span = rulesetSpanOf(combatant);
      const taken = new Set(
        state.combatants
          .filter((other) => other !== combatant && !other.defeated)
          .flatMap((other) => rulesetFootprint(other).map((cell) => `${cell.x},${cell.y}`)),
      );
      const start: { x: number; y: number } = at;
      let fit: { x: number; y: number } | null = null;
      for (to = want; to > now && !fit; to--) {
        const grown = order[to]!.cells ?? 1;
        if (grown <= span) {
          fit = start;
          break;
        }
        const room = grown - span;
        for (let shift = 0; shift <= 2 * room && !fit; shift++) {
          for (let dy = 0; dy <= Math.min(shift, room) && !fit; dy++) {
            const dx = shift - dy;
            if (dx > room) continue;
            const anchor = { x: start.x - dx, y: start.y - dy };
            if (fitsAt(grid, anchor, grown, taken)) fit = anchor;
          }
        }
        if (fit) break;
      }
      at = fit ?? start;
    }
    const size = order[to]!;
    if (size.id === (combatant.size ?? combat.sizes!.default)) continue;
    combatant.size = size.id;
    if (to === from) delete combatant.baseSize;
    else combatant.baseSize = own;
    if ((size.cells ?? 1) > 1) combatant.span = size.cells;
    else delete combatant.span;
    if (at && grid) {
      combatant.x = at.x;
      combatant.y = at.y;
    }
    changed.push({ targetId: combatant.id, size: size.id, label: size.label });
  }
  return changed;
}

/**
 * Everybody onto the board, or nobody at all.
 *
 * A fight is positioned only when the ruleset says what a cell is worth and every single combatant
 * has a cell inside the grid. One missing placement leaves the whole fight where it was, because a
 * fight where one combatant has no position is one where nothing about distance can be answered.
 */
function placeRulesetCombatants(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  state: RulesetEncounterState,
  board: RulesetEncounterInput["board"],
): void {
  if (!board || !combat.distance) return;
  const { grid } = board;
  if (!grid || !Number.isInteger(grid.width) || !Number.isInteger(grid.height)) return;
  const placed: Array<{ combatant: RulesetCombatant; at: { x: number; y: number } }> = [];
  for (const combatant of state.combatants) {
    const at = board.placements[combatant.id];
    if (
      !at ||
      !Number.isInteger(at.x) ||
      !Number.isInteger(at.y) ||
      at.x < 0 ||
      at.y < 0 ||
      at.x >= grid.width ||
      at.y >= grid.height
    ) {
      return;
    }
    placed.push({ combatant, at });
  }
  // Somebody bigger than one cell fills as many a side as their size says (1.189), set down where
  // all of them fit: on the board, on open ground and clear of whoever was set down first, the
  // nearest such place to where they were asked to stand.
  // The big are set down first, and anybody of one cell asked to stand inside one of them steps
  // aside to the nearest open cell; nobody else moves from where they were asked to stand.
  const taken = new Set<string>();
  const big = new Set<string>();
  const spans = new Map(placed.map((entry) => [entry, rulesetSizeSpan(combat, entry.combatant)]));
  for (const entry of [...placed].sort((a, b) => spans.get(b)! - spans.get(a)!)) {
    const span = spans.get(entry)!;
    if (span > 1) {
      entry.combatant.span = span;
      entry.at = rulesetFitCell(grid, entry.at, span, taken) ?? entry.at;
      for (const cell of rulesetFootprintAt(entry.at, span)) big.add(`${cell.x},${cell.y}`);
    } else if (big.has(`${entry.at.x},${entry.at.y}`)) {
      entry.at = rulesetFitCell(grid, entry.at, 1, taken) ?? entry.at;
    }
    for (const cell of rulesetFootprintAt(entry.at, span)) taken.add(`${cell.x},${cell.y}`);
  }
  for (const { combatant, at } of placed) {
    combatant.x = at.x;
    combatant.y = at.y;
    combatant.movement = rulesetMovementAllowance(definition, combat, combatant);
    combatant.movementLeft = 0;
    grantRulesetMovement(definition, combat, combatant);
  }
  state.board = {
    grid,
    ...(board.battlefield ? { battlefield: board.battlefield as RulesetCombatBoard["battlefield"] } : {}),
    // What a shot gains from higher ground, as the ruleset said at the start (combat C6b).
    ...(combat.elevation?.rangeBonus ? { rangeBonus: combat.elevation.rangeBonus } : {}),
    // What one level is worth in cells, which is what a flier pays to rise one (1.109).
    ...(combat.elevation && combat.distance
      ? { levelCells: rulesetInCells(combat.elevation.levelHeight, combat.distance.perCell) }
      : {}),
  };
}

/** The stored live blob as the encounter keeps it. `applyRulesetSheetOp` already reads a stored
 *  blob tolerantly, so an empty object is a member with nothing spent. */
function readStoredLive(stored: unknown): RulesetLiveState {
  return stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as RulesetLiveState) : {};
}
