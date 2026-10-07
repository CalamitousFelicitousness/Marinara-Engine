/**
 * Lasting areas (Capability API 1.167): what a zone covers now, and whom it may catch.
 *
 * A zone held at a point keeps the cells it was cast on. One held by its caster is a burst worked
 * out around them wherever they stand, so it goes where they go. Nothing here changes the fight;
 * the resolver decides when a zone catches somebody and does it.
 */
import { rulesetCombatant } from "./encounter.js";
import { rulesetAreaCells, rulesetPositionOf } from "./grid.js";
import type {
  RulesetCombatAction,
  RulesetCombatant,
  RulesetCombatCell,
  RulesetCombatZone,
  RulesetEncounterState,
} from "./types.js";

/** The cells a zone covers as the fight stands. None off a board, or for a caster with no cell. */
export function rulesetZoneCells(
  state: RulesetEncounterState,
  caster: RulesetCombatant,
  zone: RulesetCombatZone,
): RulesetCombatCell[] {
  const grid = state.board?.grid;
  if (!grid) return [];
  if (zone.anchor === "point") return zone.cells ?? [];
  const action = caster.actions.find((entry) => entry.id === zone.actionId);
  const at = rulesetPositionOf(caster);
  if (!action?.area || !at) return [];
  return rulesetAreaCells("burst", action.area.size, at, at, grid);
}

/** Whether a zone's area may catch this combatant at all, as the cast's own area would have: its
 *  own side left out where the entry said so, a mend only for whom it was pointed at, and the caster
 *  never caught by a zone they carry. */
export function rulesetZoneCatches(
  caster: RulesetCombatant,
  zone: RulesetCombatZone,
  action: RulesetCombatAction,
  combatant: RulesetCombatant,
): boolean {
  if (combatant.defeated) return false;
  if (zone.anchor === "caster" && combatant.id === caster.id) return false;
  const sameSide = combatant.side === caster.side;
  if (action.area?.friendlyFire === false && sameSide) return false;
  // A mend, or a blessing pointed at allies, stays on the caster's own side.
  if ((action.heal || action.targets.side === "ally") && !sameSide) return false;
  return true;
}

/** Every zone standing, with whose it is. */
export function rulesetStandingZones(
  state: RulesetEncounterState,
): Array<{ caster: RulesetCombatant; zone: RulesetCombatZone; action: RulesetCombatAction }> {
  return state.combatants.flatMap((caster) =>
    (caster.zones ?? []).flatMap((zone) => {
      const action = caster.actions.find((entry) => entry.id === zone.actionId);
      return action ? [{ caster, zone, action }] : [];
    }),
  );
}

/** Whether a cell is one of a zone's. */
export function rulesetZoneHolds(cells: readonly RulesetCombatCell[], cell: RulesetCombatCell | null): boolean {
  return !!cell && cells.some((one) => one.x === cell.x && one.y === cell.y);
}

/** Who a zone has inside it now, among those it may catch. */
export function rulesetZoneOccupants(
  state: RulesetEncounterState,
  caster: RulesetCombatant,
  zone: RulesetCombatZone,
  action: RulesetCombatAction,
): string[] {
  const cells = rulesetZoneCells(state, caster, zone);
  return state.combatants
    .filter((one) => rulesetZoneCatches(caster, zone, action, one) && rulesetZoneHolds(cells, rulesetPositionOf(one)))
    .map((one) => one.id);
}

/** The zones a fight shows: each one's caster, label, rounds left and cells. */
export function rulesetZonesShown(
  state: RulesetEncounterState,
): Array<{ casterId: string; label: string; rounds: number; cells: RulesetCombatCell[] }> {
  return rulesetStandingZones(state).map(({ caster, zone }) => ({
    casterId: caster.id,
    label: zone.label,
    rounds: zone.rounds,
    cells: rulesetZoneCells(state, rulesetCombatant(state, caster.id) ?? caster, zone).map((cell) => ({ ...cell })),
  }));
}
