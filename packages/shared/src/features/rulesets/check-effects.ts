// ──────────────────────────────────────────────
// Game Mode rulesets: what changes a check outside a fight
//
// A character's active conditions, the levels their tracks have reached, and what their items do while
// worn or while only carried, read for one check or save. Each says it in the condition vocabulary:
// advantage or disadvantage, numbers added or taken, saves failed without a roll, narrowed to some
// skills or saves. The check resolver rolls what comes out of here; a fight reads its own conditions.
// ──────────────────────────────────────────────
import type {
  RulesetCombatCondition,
  RulesetCreatureHideEntry,
  RulesetDefinition,
  RulesetItemUse,
  RulesetSheetBuild,
} from "../../schemas/ruleset.schema.js";
import { parseRulesetCombatDice } from "../ruleset-combat/dice.js";
import { evaluateRulesetSheetLive, readRulesetLive } from "./live-state.js";
import {
  resolveRulesetValueRef,
  rulesetHeldItemDoes,
  rulesetCheckAdjust,
  rulesetCheckModifier,
  type EvaluatedRulesetSheet,
  type RulesetCheckTarget,
  type RulesetSheetItem,
} from "./sheet-math.js";

type RulesetEffectModifier = NonNullable<RulesetCombatCondition["modifiers"]>[number];

/** What a save is rolled against (1.129). Missing context matches no narrowed modifier. */
export interface RulesetSaveAgainst {
  conditions?: readonly string[];
  damage?: readonly string[];
  magic?: boolean;
  /** What the creature the save is against is (1.180): its type and tags. */
  from?: { type?: string; tags: readonly string[] };
  /** What the action the save is against is known by (1.186): its id, its name and its shared
   *  recharge group. */
  action?: readonly string[];
  /** The catalog the entry it is against came from, or the one an item's use casts from (1.260). */
  catalog?: string;
}

/** Any one match is enough; the save's own name is checked separately. */
export function rulesetSaveAgainstMatches(
  against: RulesetEffectModifier["against"],
  source?: RulesetSaveAgainst,
): boolean {
  if (!against) return true;
  if (!source) return false;
  // Named actions narrow everything else it says (1.186): one of them, and then the rest as usual.
  if (against.actions) {
    const known = (source.action ?? []).map((name) => name.trim().toLowerCase());
    if (!against.actions.some((name) => known.includes(name.trim().toLowerCase()))) return false;
  }
  // As do the catalogs it is cast from (1.260): a spell, and then whoever cast it.
  if (against.casts && !(source.catalog !== undefined && against.casts.includes(source.catalog))) return false;
  if ((against.actions || against.casts) && !against.conditions && !against.damage && !against.magic && !against.from) {
    return true;
  }
  return !!(
    against.conditions?.some((condition) => source.conditions?.includes(condition)) ||
    against.damage?.some((type) =>
      source.damage?.some((one) => one.trim().toLowerCase() === type.trim().toLowerCase()),
    ) ||
    (against.magic && source.magic) ||
    (against.from &&
      source.from &&
      ((source.from.type !== undefined && !!against.from.types?.includes(source.from.type)) ||
        source.from.tags.some((tag) => !!against.from?.tags?.includes(tag))))
  );
}

/** One thing that changes this character's checks: an active condition, a level their track has
 *  reached, or one item's worn or carried effect. `name` is what a record calls it. */
export interface RulesetCheckSource {
  name: string;
  effects?: readonly string[];
  modifiers?: readonly RulesetEffectModifier[];
  failsSaves?: readonly string[];
  saves?: readonly string[];
  skills?: readonly string[];
  /** What this source keeps off its holder in a fight (Capability API 1.127). A check reads none. */
  resist?: readonly RulesetCreatureHideEntry[];
  vulnerable?: readonly string[];
  immune?: readonly RulesetCreatureHideEntry[];
  conditionImmunities?: readonly string[];
  /** How far it lets its holder sense with each of the fight's senses (Capability API 1.175). */
  senses?: Readonly<Record<string, number | { add: number }>>;
}

/**
 * Everything that changes this character's checks outside a fight. A condition counts while it is
 * active on the sheet (a gate on who applied it has nobody to measure outside a fight, so it counts),
 * a level while the track or derived value it reads has reached it, an item's `worn` effect while it
 * is worn and its `carried` one while it is only carried, and a worn item's requirement's `otherwise`
 * while the wearer falls short of it. One item applies each of these once, however many stacks of it
 * there are. Derived values and requirements are read off the sheet worked out with the same live
 * state and items.
 */
export function rulesetCheckSources(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  stored?: unknown,
  items?: readonly RulesetSheetItem[],
): RulesetCheckSource[] {
  const sources: RulesetCheckSource[] = [];
  const combat = definition.combat;
  let evaluated: EvaluatedRulesetSheet | undefined;
  const sheet = () => (evaluated ??= evaluateRulesetSheetLive(definition, build, stored, items));
  if (combat?.conditions?.length || combat?.levels?.length) {
    const live = readRulesetLive(definition, build, stored);
    const active = new Map(live.conditions.filter((entry) => entry.active).map((entry) => [entry.id, entry.label]));
    for (const entry of combat.conditions ?? []) {
      const label = active.get(entry.condition);
      if (label !== undefined) sources.push({ ...entry, name: label });
    }
    for (const level of combat.levels ?? []) {
      const value =
        level.derived !== undefined
          ? (sheet().derived[level.derived] ?? 0)
          : (live.tracks.find((track) => track.id === level.track)?.value ?? 0);
      if (value < level.at) continue;
      const label =
        level.derived !== undefined
          ? (definition.sheet.derived.find((entry) => entry.id === level.derived)?.label ?? level.derived)
          : (definition.sheet.live.tracks.find((track) => track.id === level.track)?.label ?? level.track!);
      sources.push({ ...level, name: `${label} ${level.at}` });
    }
  }
  return [
    ...sources,
    ...rulesetItemSources(definition, build, items, sheet),
    ...rulesetSheetHideSources(definition, build),
  ];
}

/** A sheet row's typed hides (Capability API 1.127), read afresh so removing the row removes them.
 *  Unknown damage words and condition ids are ignored; a ruleset with no damage types allows words. */
export function rulesetSheetHideSources(definition: RulesetDefinition, build: RulesetSheetBuild): RulesetCheckSource[] {
  const sources: RulesetCheckSource[] = [];
  const types = definition.combat?.damageTypes?.map((type) => type.trim().toLowerCase());
  const conditions = definition.sheet.live.conditions.map((entry) => entry.id.toLowerCase());
  for (const source of definition.combat?.sheetHides ?? []) {
    const list = definition.sheet.lists.find((entry) => entry.id === source.list);
    const column = list?.columns.find((entry) => entry.id === source.column);
    for (const row of build.lists[source.list] ?? []) {
      const value = row[source.column] ?? column?.default;
      if (typeof value !== "string") continue;
      const hide: RulesetCheckSource = { name: list?.label ?? source.list };
      for (const word of value.split(",")) {
        const [type, ...except] = word
          .trim()
          .toLowerCase()
          .split(/\s+except\s+/);
        if (!type) continue;
        if (source.kind === "conditionImmunities") {
          if (!conditions.includes(type) || except.length) continue;
          hide.conditionImmunities = [...(hide.conditionImmunities ?? []), type];
        } else {
          if (types && !types.includes(type)) continue;
          if (source.kind === "vulnerable") {
            if (!except.length) hide.vulnerable = [...(hide.vulnerable ?? []), type];
          } else {
            const entry = except.length ? { type, except: except.join(" ").split(/\s+/) } : type;
            hide[source.kind] = [...(hide[source.kind] ?? []), entry];
          }
        }
      }
      sources.push(hide);
    }
  }
  return sources;
}

/**
 * What a character's items do, each named for the stack: a worn item's `worn` effect and any other
 * item's `carried` one, and a worn item's requirement's `otherwise` while the wearer falls short of it.
 * One item applies each of these once, however many stacks of it there are. `sheet` is the sheet
 * worked out with the same live state and items, read only for a requirement. A check outside a fight
 * and a fight both read items through this.
 */
export function rulesetItemSources(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  items: readonly RulesetSheetItem[] | undefined,
  sheet: () => EvaluatedRulesetSheet,
): RulesetCheckSource[] {
  const sources: RulesetCheckSource[] = [];
  const seen = new Set<unknown>();
  for (const held of items ?? []) {
    const name = held.name ?? held.item.category;
    // A fake does what it truly does (1.74), under the name it is shown by.
    const does = rulesetHeldItemDoes(held);
    const effect = held.worn ? does.worn : does.carried;
    if (effect && !seen.has(effect)) {
      seen.add(effect);
      sources.push({ ...effect, name });
    }
    // What the wearer falls short of, while it is worn.
    if (!held.worn || !does.requires || seen.has(does.requires)) continue;
    seen.add(does.requires);
    for (const requirement of does.requires) {
      if (resolveRulesetValueRef(definition, build, requirement.value, sheet()) >= requirement.atLeast) continue;
      sources.push({ ...requirement.otherwise, name });
    }
  }
  return sources;
}

/** What those sources do to one check or save, by the name of whatever does each part. */
export interface RulesetCheckEffects {
  /** Numbers added or taken, flat or in dice, not yet rolled. */
  modifiers: Array<{ from: string; modifier: RulesetEffectModifier }>;
  /** What leans the roll one way: effects and modifiers' modes. */
  advantage: string[];
  disadvantage: string[];
  /** A save these make fail without a roll. Empty for a check. */
  fails: string[];
}

/**
 * What changes this check or save. A check reads the check effects and the modifiers to checks, a save
 * the save effects, the modifiers to saves and the saves failed. Something narrowed to some skills
 * changes only a check on one of them (a modifier's own `skills` first, else its source's), and
 * something narrowed to some saves only those saves; a check the ruleset cannot name reads only what
 * is narrowed to nothing.
 */
export function rulesetCheckEffects(
  sources: readonly RulesetCheckSource[],
  target: RulesetCheckTarget | null,
): RulesetCheckEffects {
  const found: RulesetCheckEffects = { modifiers: [], advantage: [], disadvantage: [], fails: [] };
  const lean = (side: "advantage" | "disadvantage", from: string) => {
    if (!found[side].includes(from)) found[side].push(from);
  };
  const save = target?.type === "save" ? target.id : undefined;
  const skill = target?.type === "skill" ? target.id : undefined;
  // The ability a check is made with (1.183): a raw ability check's own, or a skill's as it is rolled.
  const ability =
    target?.type === "ability"
      ? target.id
      : target?.type === "skill"
        ? (target.withAbility ?? target.ability)
        : undefined;
  const about = (narrowed: readonly string[] | undefined, id: string | undefined) =>
    !narrowed || (id !== undefined && narrowed.includes(id));
  for (const source of sources) {
    const effects = source.effects ?? [];
    if (save !== undefined) {
      if (source.failsSaves?.includes(save) && !found.fails.includes(source.name)) found.fails.push(source.name);
      if (about(source.saves, save)) {
        if (effects.includes("own-saves-advantage")) lean("advantage", source.name);
        if (effects.includes("own-saves-disadvantage")) lean("disadvantage", source.name);
      }
    } else if (about(source.skills, skill)) {
      if (effects.includes("own-checks-advantage")) lean("advantage", source.name);
      if (effects.includes("own-checks-disadvantage")) lean("disadvantage", source.name);
    }
    for (const modifier of source.modifiers ?? []) {
      const applies =
        save !== undefined
          ? modifier.to === "saves" && about(modifier.saves ?? source.saves, save)
          : modifier.to === "checks" &&
            about(modifier.skills ?? source.skills, skill) &&
            about(modifier.abilities, ability);
      if (!applies || !rulesetSaveAgainstMatches(modifier.against)) continue;
      if (modifier.mode) lean(modifier.mode, source.name);
      if (modifier.flat !== undefined || modifier.dice !== undefined) {
        found.modifiers.push({ from: source.name, modifier });
      }
    }
  }
  return found;
}

/** How a check is thrown once its sources and the Game Master's `mode=` are counted together: any
 *  advantage and any disadvantage cancel out, whatever the number of each. */
export function rulesetCheckRollMode(
  asked: { advantage?: boolean; disadvantage?: boolean },
  effects: Pick<RulesetCheckEffects, "advantage" | "disadvantage">,
): "normal" | "advantage" | "disadvantage" {
  const advantage = !!asked.advantage || effects.advantage.length > 0;
  const disadvantage = !!asked.disadvantage || effects.disadvantage.length > 0;
  if (advantage === disadvantage) return "normal";
  return advantage ? "advantage" : "disadvantage";
}

/** The modifiers rolled: each one's flat part and its dice, with the dice thrown. */
export function rollRulesetCheckModifiers(
  modifiers: RulesetCheckEffects["modifiers"],
  rollDie: (sides: number) => number,
): { total: number; rolls: number[] } {
  let total = 0;
  const rolls: number[] = [];
  for (const { modifier } of modifiers) {
    total += modifier.flat ?? 0;
    const dice = modifier.dice ? parseRulesetCombatDice(modifier.dice) : null;
    if (!dice) continue;
    let rolled = dice.flat;
    for (let i = 0; i < dice.count; i++) {
      const face = rollDie(dice.sides);
      rolls.push(face);
      rolled += face;
    }
    total += modifier.minus ? -rolled : rolled;
  }
  return { total, rolls };
}

/** The check a use's `gate` asks of the one using it, as their sheet makes it. */
export interface RulesetItemGateCheck {
  /** The skill or ability rolled; null for a value off the sheet, which reads only what applies to
   *  every check. */
  target: RulesetCheckTarget | null;
  /** The sheet's number for it with what `resolution.adjust` adds: a modifier, or a pool's dice. */
  modifier: number;
  difficulty: number;
}

/**
 * What a use's `gate` asks of one user: nothing when the value it names under `unless` is high
 * enough, and otherwise its check, read off their sheet worked out with their live state and items.
 * `difficulty` is the gate's own, already read off the item where it names a stat.
 */
export function rulesetItemGateCheck(
  definition: RulesetDefinition,
  build: RulesetSheetBuild,
  evaluated: EvaluatedRulesetSheet,
  gate: NonNullable<RulesetItemUse["gate"]>,
  difficulty: number,
): RulesetItemGateCheck | null {
  const { check, unless } = gate;
  if (unless && resolveRulesetValueRef(definition, build, unless.value, evaluated) >= unless.atLeast) return null;
  const skill = "skill" in check ? definition.sheet.skills.find((entry) => entry.id === check.skill) : undefined;
  const ability =
    "ability" in check ? definition.sheet.abilities.find((entry) => entry.id === check.ability) : undefined;
  const target: RulesetCheckTarget | null = skill
    ? { type: "skill", id: skill.id, label: skill.label, ...(skill.ability ? { ability: skill.ability } : {}) }
    : ability
      ? { type: "ability", id: ability.id, label: ability.label }
      : null;
  const base =
    "value" in check
      ? resolveRulesetValueRef(definition, build, check.value, evaluated)
      : rulesetCheckModifier(evaluated, target);
  return {
    target,
    modifier: Math.trunc(base) + rulesetCheckAdjust(definition, build, evaluated, target),
    difficulty,
  };
}

/** Typed defenses, in the same words on the sheet, battle status and Game Master prompt (1.127). */
export function rulesetHideLines(
  definition: RulesetDefinition,
  sources: readonly Pick<RulesetCheckSource, "resist" | "vulnerable" | "immune" | "conditionImmunities">[],
  text: (key: string, values: Record<string, string>) => string = (key, values) => {
    if (key === "game.ruleset.hides.except") return `${values.type} except ${values.tags}`;
    const labels: Record<string, string> = {
      resist: "Resists",
      vulnerable: "Vulnerable to",
      immune: "Immune to",
      conditionImmunities: "Condition immunities",
    };
    return `${labels[key.split(".").at(-1)!]}: ${values.names}`;
  },
): string[] {
  return (["resist", "vulnerable", "immune", "conditionImmunities"] as const).flatMap((kind) => {
    const names = sources.flatMap((source) =>
      (source[kind] ?? []).map((entry) => {
        if (typeof entry !== "string")
          return text("game.ruleset.hides.except", { type: entry.type, tags: entry.except.join(" ") });
        return kind === "conditionImmunities"
          ? (definition.sheet.live.conditions.find((condition) => condition.id === entry)?.label ?? entry)
          : entry;
      }),
    );
    return names.length ? [text(`game.ruleset.hides.${kind}`, { names: [...new Set(names)].join(", ") })] : [];
  });
}
