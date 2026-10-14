/**
 * Shapes (Capability API 1.342): somebody changed into another creature's form while a condition
 * with `shape` holds. 5e's Wild Shape, Polymorph, True Polymorph and Shapechange, a monster's Change
 * Shape. The form is built as the fight builds a creature of it, and its actions, defense, saves,
 * checks, speeds, senses, size and traits take the place of the holder's own; what the shape keeps
 * of theirs stays. With a health of its own, the form takes blows first, and when it runs out the
 * shape ends and the rest of the blow carries on. Everything it took the place of is given back as
 * it ends.
 */
import { createRulesetEncounter } from "./encounter.js";
import type { RulesetCombat, RulesetDefinition } from "../../schemas/ruleset.schema.js";
import { evaluateRulesetSheetLive } from "../rulesets/live-state.js";
import { resolveRulesetValueRef } from "../rulesets/sheet-math.js";
import {
  RULESET_SHAPE_KEYS,
  type RulesetCombatAction,
  type RulesetCombatApplies,
  type RulesetCombatRoller,
  type RulesetCombatant,
  type RulesetEncounterState,
  type RulesetShapeForm,
  type RulesetShaped,
} from "./types.js";

type ShapeRule = NonNullable<NonNullable<RulesetCombat["conditions"]>[number]["shape"]>;

/** The id of the action that gives a shape up (1.342). */
export const RULESET_SHAPE_REVERT_ID = "shape:revert";

/** Whether the form `applies` carries may be taken by `target` (1.342): at or below what its sheet's
 *  `targetLevel` reads, or a creature's own rank. Anything without a cap may. */
export function rulesetFormAllowed(
  definition: RulesetDefinition,
  target: RulesetCombatant,
  applies: RulesetCombatApplies,
): boolean {
  const cap = applies.cap;
  const rank = applies.form?.rank;
  if (!cap || rank === undefined) return true;
  let most: number | undefined;
  if (target.sheet && cap.targetLevel) {
    const evaluated = evaluateRulesetSheetLive(definition, target.sheet.build, target.sheet.live, target.sheet.items);
    most = resolveRulesetValueRef(definition, target.sheet.build, cap.targetLevel, evaluated);
  } else {
    most = target.ranks?.[cap.filter];
  }
  return most === undefined || !Number.isFinite(most) || rank <= most;
}

/**
 * `target` takes `form`'s shape, held by `condition`. Whatever shape they were in is given up first.
 * Null when the form could not be built.
 */
export function rulesetTakeShape(
  definition: RulesetDefinition,
  state: RulesetEncounterState,
  target: RulesetCombatant,
  condition: string,
  rule: ShapeRule,
  form: RulesetShapeForm,
  roll: RulesetCombatRoller,
): RulesetShaped | null {
  const built = createRulesetEncounter({
    definition,
    seed: state.seed,
    roller: roll,
    combatants: [{ id: target.id, name: form.name, side: "enemy", block: structuredClone(form.block) }],
  }).combatants[0];
  if (!built) return null;
  if (target.shape) rulesetLeaveShape(target);
  const was: RulesetShaped["was"] = {};
  const lacked: RulesetShaped["lacked"] = [];
  for (const key of RULESET_SHAPE_KEYS) {
    if (target[key] === undefined) lacked.push(key);
    else (was as Record<string, unknown>)[key] = structuredClone(target[key]);
  }
  // What it keeps of its own: actions by id or entry ("catalog/entry", or the entry's own id), saves
  // and checks by id.
  const keeps = new Set(rule.keeps ?? []);
  const kept = target.actions.filter(
    (one) =>
      keeps.has(one.id) ||
      (one.entry !== undefined && (keeps.has(one.entry) || keeps.has(one.entry.slice(one.entry.indexOf("/") + 1)))),
  );
  const keptIds = new Set(kept.map((one) => one.id));
  const formActions = built.actions.filter((one) => !keptIds.has(one.id));
  const revert: RulesetCombatAction[] = rule.revert
    ? [
        {
          id: RULESET_SHAPE_REVERT_ID,
          kind: "ability",
          label: `Revert (${form.name})`,
          budget: rule.revert,
          targets: { side: "self", count: 0 },
          endsCondition: condition,
        },
      ]
    : [];
  target.actions = [...formActions, ...kept, ...revert];
  target.uses = {
    ...built.uses,
    ...Object.fromEntries(Object.entries(target.uses).filter(([id]) => keptIds.has(id))),
  };
  target.spent = target.spent.filter((id) => keptIds.has(id));
  target.defense = built.defense;
  target.speed = built.speed;
  const pick = (from: Record<string, number> | undefined, ids: readonly string[] | undefined) =>
    Object.fromEntries(Object.entries(from ?? {}).filter(([id]) => ids?.includes(id)));
  target.saves = { ...built.saves, ...pick(was.saves, rule.keepsSaves) };
  const checks = { ...(built.checks ?? {}), ...pick(was.checks, rule.keepsChecks) };
  if (Object.keys(checks).length) target.checks = checks;
  else delete target.checks;
  for (const key of ["speeds", "hover", "senses", "size", "span", "riders", "block", "soak", "hardness"] as const) {
    if (built[key] === undefined) delete target[key];
    else (target as unknown as Record<string, unknown>)[key] = structuredClone(built[key]);
  }
  if (built.criticalFrom === undefined) delete target.criticalFrom;
  else target.criticalFrom = built.criticalFrom;
  delete target.baseSize;
  delete target.baseSpeeds;
  delete target.levitating;
  target.creature = { ...form.creature };
  // A form taken partway through a turn moves no further than its own speed allows.
  if (target.movementLeft !== undefined && target.movement !== undefined) {
    const walked = Math.max(0, target.movement - target.movementLeft);
    delete target.modeLeft;
    target.movementLeft = Math.max(0, (built.movement ?? target.movement) - walked);
  }
  const health =
    rule.health === "own" || !built.health ? undefined : { value: built.health.value, max: built.health.max, temp: 0 };
  target.shape = {
    condition,
    form: { ...form.creature },
    name: form.name,
    ...(health ? { health } : {}),
    was,
    lacked,
  };
  return target.shape;
}

/** `target` gives its shape up (1.342): everything it took the place of comes back. */
export function rulesetLeaveShape(target: RulesetCombatant): RulesetShaped | null {
  const shape = target.shape;
  if (!shape) return null;
  delete target.shape;
  // The form's own actions, and the shape's way back, go with it; what was kept was always theirs.
  const own = new Set((shape.was.actions ?? []).map((one) => one.id));
  const keptUses = Object.fromEntries(Object.entries(target.uses).filter(([id]) => own.has(id)));
  for (const key of RULESET_SHAPE_KEYS) {
    if (shape.lacked.includes(key)) delete target[key];
    else if (key in shape.was) (target as unknown as Record<string, unknown>)[key] = shape.was[key];
  }
  // What the kept actions spent while in the shape stays spent.
  target.uses = { ...target.uses, ...keptUses };
  return shape;
}
