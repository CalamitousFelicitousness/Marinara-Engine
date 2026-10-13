/**
 * Who sees whom (Capability API 1.177; senses conditions and items give, and conditions that give
 * away the unseen, 1.179).
 *
 * Off a board everybody sees everybody, as before. On one, a viewer does not see somebody it has no
 * line to (walls and solid ground), somebody standing in, behind or beyond an obscuring zone from
 * where it stands, or somebody a condition hides (5e's invisible), unless one of the viewer's senses
 * pierces that, within that sense's range. A viewer whose conditions take away its eyes (the
 * `combat.sight.eyes` sense) sees only by a `blind` sense. Nothing here changes the fight: attacks
 * read it for their roll's mode, and "a creature you can see" reads it for who may be picked.
 */
import type { RulesetDefinition } from "../../schemas/ruleset.schema.js";
import { rulesetActiveConditions, rulesetCombatConditions } from "./encounter.js";
import {
  rulesetCellDistance,
  rulesetInCells,
  rulesetLineOfSight,
  rulesetPositionOf,
  rulesetZoneCells,
} from "./grid.js";
import type { RulesetCombatant, RulesetCombatCell, RulesetEncounterState } from "./types.js";

/** How far each of the fight's senses reaches for this combatant, in cells: a creature's off its
 *  block, anybody else's as it was read off their sheet when the fight began. What their conditions
 *  and items give now (1.179) reaches further where it is longer: 5e's Darkvision spell, goggles of
 *  night, True Seeing. */
export function rulesetSenseRanges(
  definition: RulesetDefinition,
  combatant: RulesetCombatant,
  state?: RulesetEncounterState,
): Record<string, number> {
  const block = combatant.block?.senses;
  const perCell = definition.combat?.distance?.perCell;
  const ranges: Record<string, number> =
    block && perCell !== undefined
      ? Object.fromEntries(Object.entries(block).map(([id, range]) => [id, rulesetInCells(range, perCell)]))
      : { ...(combatant.senses ?? {}) };
  const combat = definition.combat;
  if (!combat || perCell === undefined) return ranges;
  for (const source of rulesetActiveConditions(definition, combat, combatant, state)) {
    for (const [id, range] of Object.entries(source.senses ?? {})) {
      ranges[id] = Math.max(ranges[id] ?? 0, rulesetInCells(range, perCell));
    }
  }
  return ranges;
}

/** Every cell a straight line from one cell's middle to another's passes through, both ends included. */
function cellsBetween(a: RulesetCombatCell, b: RulesetCombatCell): RulesetCombatCell[] {
  const steps = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) * 2;
  const cells: RulesetCombatCell[] = [];
  const seen = new Set<string>();
  for (let step = 0; step <= steps; step++) {
    const t = steps === 0 ? 0 : step / steps;
    const x = Math.round(a.x + (b.x - a.x) * t);
    const y = Math.round(a.y + (b.y - a.y) * t);
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push({ x, y });
  }
  return cells;
}

/** The cells obscuring zones cover now, each with the senses that see through it. */
function obscured(state: RulesetEncounterState): Array<{ cells: Set<string>; pierced: string[] }> {
  return state.combatants.flatMap((caster) =>
    (caster.zones ?? []).flatMap((zone) => {
      const rule = caster.actions.find((entry) => entry.id === zone.actionId)?.zone?.obscures;
      if (!rule) return [];
      const cells = new Set(rulesetZoneCells(state, caster, zone).map((cell) => `${cell.x},${cell.y}`));
      return cells.size > 0 ? [{ cells, pierced: rule.pierced }] : [];
    }),
  );
}

/**
 * Whether `viewer` sees `seen` now. Yourself you always see. Off a board, or without anybody's
 * position, everybody sees everybody: nothing measures anything there.
 */
export function rulesetCanSee(
  definition: RulesetDefinition,
  state: RulesetEncounterState,
  viewer: RulesetCombatant,
  seen: RulesetCombatant,
): boolean {
  if (viewer.id === seen.id) return true;
  const combat = definition.combat;
  if (!combat) return true;
  const ranges = rulesetSenseRanges(definition, viewer, state);
  const blindSenses = new Set((combat.senses ?? []).filter((sense) => sense.blind).map((sense) => sense.id));
  // Conditions read raw, without their gates: a gate may itself ask who sees whom.
  const own = new Set(rulesetCombatConditions(definition, viewer));
  const entries = combat.conditions ?? [];
  const eyes = combat.sight?.eyes;
  const sightless =
    eyes !== undefined && entries.some((entry) => own.has(entry.condition) && entry.lacks?.includes(eyes));
  const grid = state.board?.grid;
  const from = rulesetPositionOf(viewer);
  const to = rulesetPositionOf(seen);
  const positioned = !!grid && !!from && !!to;
  const away = positioned ? rulesetCellDistance(from, to) : 0;
  // A sense that sees past `pierced` reaches this far; a sightless viewer has only its blind ones.
  const pierces = (pierced: readonly string[] | undefined) =>
    (pierced ?? []).some(
      (sense) =>
        (!sightless || blindSenses.has(sense)) && (ranges[sense] ?? 0) >= away && (positioned || ranges[sense]),
    );
  if (sightless) {
    // Without eyes there is only what a blind sense reaches, and off a board nobody measures that.
    if (!positioned) return blindSenses.size > 0 && [...blindSenses].some((sense) => (ranges[sense] ?? 0) > 0);
    if (![...blindSenses].some((sense) => (ranges[sense] ?? 0) >= away)) return false;
  }
  // Hidden by a condition (5e's invisible) unless a sense sees it, or another of theirs gives them
  // away (1.179: Faerie Fire outlines the invisible).
  const theirs = new Set(rulesetCombatConditions(definition, seen));
  const outlined = entries.some((entry) => entry.cancelsUnseen && theirs.has(entry.condition));
  for (const entry of entries) {
    if (!outlined && entry.unseen && theirs.has(entry.condition) && !pierces(entry.unseen.pierced)) return false;
  }
  if (!positioned) return true;
  if (!rulesetLineOfSight(grid, from, to)) return false;
  const fogs = obscured(state);
  if (fogs.length === 0) return true;
  const line = cellsBetween(from, to).map((cell) => `${cell.x},${cell.y}`);
  return fogs.every((fog) => !line.some((key) => fog.cells.has(key)) || pierces(fog.pierced));
}
