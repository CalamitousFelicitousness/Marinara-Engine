// The board, for a fight the ruleset resolves itself.
//
// Pure geometry over the tactical engine's OWN grid: this slice adds no second generator and no
// second terrain table. What it does add is the way a tabletop grid is actually played, which is
// not how the Engine's own tactical fights move: eight neighbours at one step each, distance as the
// larger of the two axis differences, and real burst, cone and line shapes instead of one radius.
//
// Every number in here is in CELLS. Turning a ruleset's own distance into cells happens once, when
// the fight is built, through `rulesetInCells`.

import { TERRAIN_DATA, type TacticalGrid } from "../tactical-combat/types.js";
import { blocksSight, climbCost, elevationAt, hasLineOfSight } from "../tactical-combat/math.js";
import type { RulesetCombat, RulesetDefinition } from "../../schemas/ruleset.schema.js";
import { rulesetShotsAvailable } from "./ammo.js";
import { rulesetActiveConditions, rulesetCombatant, rulesetCombatEffects, rulesetCombatStanding } from "./encounter.js";
import type {
  RulesetBlowKind,
  RulesetMoveMode,
  RulesetCombatAction,
  RulesetCombatant,
  RulesetCombatArea,
  RulesetCombatCell,
  RulesetCombatZone,
  RulesetEncounterState,
  RulesetReachableCell,
} from "./types.js";

/** The eight neighbours, in a fixed order so the same board always produces the same paths. */
const STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

/** How far a search may ever look, whatever a ruleset asks for. A board is at most 64 by 64 and a
 *  cell costs at least one, so nothing legitimate reaches this.
 *  ponytail: a flat ceiling rather than a budget worked out from the board. The upgrade path is to
 *  bound it by the grid's own area if a ruleset ever declares a speed this large. */
const MOVEMENT_CEILING = 512;

/**
 * A distance in the ruleset's own unit, in cells. A cell is the smallest step there is, so anything
 * an author bothered to give a number to reaches at least one: a touch is one cell when it is aimed
 * at somebody else, exactly as the older bridge's `inCells` already reads one.
 */
export function rulesetInCells(distance: number, perCell: number): number {
  if (!(perCell > 0) || !Number.isFinite(distance)) return 1;
  return Math.max(1, Math.round(distance / perCell));
}

/** How far apart two cells are: the larger of the two axis differences, because a step sideways and
 *  a step corner-wise cost the same on the grids this is for. */
export function rulesetCellDistance(a: RulesetCombatCell, b: RulesetCombatCell): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Whether both of them are standing somewhere, which is what makes a fight positioned for them. */
export function rulesetPositionOf(combatant: RulesetCombatant | undefined): RulesetCombatCell | null {
  if (!combatant || typeof combatant.x !== "number" || typeof combatant.y !== "number") return null;
  return { x: combatant.x, y: combatant.y };
}

function inBounds(grid: TacticalGrid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height;
}

/** Out of bounds reads as solid, so a search can never walk off the board. */
export function rulesetCellBlocked(grid: TacticalGrid, x: number, y: number): boolean {
  if (!inBounds(grid, x, y)) return true;
  const terrain = grid.tiles[y]?.[x];
  return terrain === undefined || !!TERRAIN_DATA[terrain]?.impassable;
}

/** What it costs to step INTO this cell, by the same terrain table the Engine's own fights use. */
export function rulesetCellEnterCost(grid: TacticalGrid, x: number, y: number): number {
  const terrain = grid.tiles[y]?.[x];
  // A saved board can arrive through an import, and a terrain word this Engine does not know must
  // cost an ordinary step rather than throw in the middle of a turn.
  const cost = (terrain === undefined ? undefined : TERRAIN_DATA[terrain]?.moveCost) ?? 1;
  return Math.max(1, Math.round(cost));
}

/** What the ground under this cell is worth as cover, by the same terrain table. */
export function rulesetCellCover(grid: TacticalGrid, cell: RulesetCombatCell): number {
  const terrain = grid.tiles[cell.y]?.[cell.x];
  return (terrain === undefined ? undefined : TERRAIN_DATA[terrain]?.defenseBonus) ?? 0;
}

/** What one step on foot from a cell into its neighbour costs (combat C6b): entering it, and one more to
 *  climb a level; null for a step of two levels or more either way, which nobody walks. */
export function rulesetStepCost(grid: TacticalGrid, from: RulesetCombatCell, to: RulesetCombatCell): number | null {
  const climb = climbCost(grid, from, to);
  return climb === null ? null : rulesetCellEnterCost(grid, to.x, to.y) + climb;
}

/** How high somebody is, in the board's levels: a flier's altitude while it is up, or the ground under
 *  them (1.109). */
export function rulesetLevelOf(grid: TacticalGrid, combatant: RulesetCombatant): number {
  const ground = typeof combatant.x === "number" ? elevationAt(grid, combatant.x, combatant.y!) : 0;
  return combatant.altitude !== undefined && combatant.altitude > ground ? combatant.altitude : ground;
}

/** Whether a flier is up in the air above the ground under it (1.109). */
export function rulesetAirborne(grid: TacticalGrid | undefined, combatant: RulesetCombatant): boolean {
  if (!grid || combatant.altitude === undefined || typeof combatant.x !== "number") return false;
  return combatant.altitude > elevationAt(grid, combatant.x, combatant.y!);
}

/**
 * How far apart two combatants are, in cells (1.109): the board's own distance, or the height
 * between them when one is up in the air and that is further. Two on the ground are as far apart
 * as their cells, whatever the ground under them, exactly as before anybody flew.
 */
export function rulesetCombatantDistance(
  state: RulesetEncounterState,
  a: RulesetCombatant,
  b: RulesetCombatant,
): number {
  const from = rulesetPositionOf(a);
  const to = rulesetPositionOf(b);
  if (!from || !to) return 0;
  const flat = rulesetCellDistance(from, to);
  const grid = state.board?.grid;
  const levelCells = state.board?.levelCells;
  if (!grid || !levelCells || !(rulesetAirborne(grid, a) || rulesetAirborne(grid, b))) return flat;
  return Math.max(flat, Math.abs(rulesetLevelOf(grid, a) - rulesetLevelOf(grid, b)) * levelCells);
}

/** Whether one combatant sees another (1.113). Nobody sees somebody who has hidden (the Hide
 *  standard action, until it wears off); otherwise it is a line of sight between them on the board,
 *  and a fight with no board, or anybody without a place on it, sees everybody, as a condition gated
 *  on sight reads it. */
export function rulesetSees(
  state: RulesetEncounterState,
  holder: RulesetCombatant,
  other: RulesetCombatant | undefined,
): boolean {
  if (other?.flags.hidden) return false;
  const grid = state.board?.grid;
  const from = rulesetPositionOf(holder);
  const to = rulesetPositionOf(other);
  if (!grid || !from || !to) return true;
  return rulesetLineOfSight(grid, from, to);
}

/** Whether a blow is struck in reach or from afar (1.113). Something with a reach and no range is
 *  melee and something with a range and no reach is ranged; something with both (a thrown dagger) is
 *  melee while its target stands in its reach, and with no board it is taken as swung in hand. */
export function rulesetBlowKind(
  state: RulesetEncounterState,
  actor: RulesetCombatant,
  target: RulesetCombatant,
  action: { reach?: number; range?: unknown },
): RulesetBlowKind {
  if (!action.range) return "melee";
  if (action.reach === undefined) return "ranged";
  if (!state.board || !rulesetPositionOf(actor) || !rulesetPositionOf(target)) return "melee";
  return rulesetCombatantDistance(state, actor, target) <= Math.max(1, action.reach) ? "melee" : "ranged";
}

/** Whether a cell is water, which nobody walks into and a swimmer or a flier crosses (1.108). */
function isWater(grid: TacticalGrid, x: number, y: number): boolean {
  return inBounds(grid, x, y) && grid.tiles[y]?.[x] === "water";
}

/** What is left this turn of one way of moving, in cells (1.108). Somebody who only walks walks on
 *  what is left of their allowance. */
function modeLeftOf(mover: RulesetCombatant, mode: RulesetMoveMode): number {
  if (!mover.modeLeft) return mode === "walk" ? (mover.movementLeft ?? 0) : 0;
  return mover.modeLeft[mode] ?? 0;
}

/** Whether a cell is solid to this mover, for stepping into it and for squeezing past its corner: water
 *  is not, to a swimmer or a flier (1.108). */
export function rulesetCellSolidFor(grid: TacticalGrid, x: number, y: number, mover?: RulesetCombatant): boolean {
  if (!rulesetCellBlocked(grid, x, y)) return false;
  return !(isWater(grid, x, y) && (!!mover?.speeds?.fly || !!mover?.speeds?.swim));
}

/**
 * The cheapest way this mover takes one step, and what it costs (1.108), with `spent` already moved
 * this turn: a way of moving whose own allowance the step would pass is not one it may use. On foot
 * (and burrowing, which a board moves as a walk) a step costs what `rulesetStepCost` says; a climber
 * takes a step of any height for the ground it steps onto; a flier steps anywhere not solid for one
 * cell, water and heights included; a swimmer crosses water for one cell, and walks on land. Null
 * when no way it moves takes the step. Somebody who only walks gets exactly `rulesetStepCost`.
 */
export function rulesetMoveStep(
  grid: TacticalGrid,
  from: RulesetCombatCell,
  to: RulesetCombatCell,
  mover: RulesetCombatant,
  spent = 0,
): { mode: RulesetMoveMode; cost: number } | null {
  const speeds = mover.speeds ?? {};
  const options: Array<{ mode: RulesetMoveMode; cost: number | null }> = [];
  // Up in the air (1.109) it only flies, a cell a step over anything not solid. Ground as high as
  // it is, or higher, it lands on, exactly as a flier on the ground flies onto a cliff.
  const altitude = mover.altitude;
  if (altitude !== undefined && altitude > elevationAt(grid, from.x, from.y)) {
    if (speeds.fly && !rulesetCellSolidFor(grid, to.x, to.y, mover)) {
      options.push({ mode: "fly", cost: 1 });
    }
  } else if (isWater(grid, to.x, to.y)) {
    if (speeds.swim) options.push({ mode: "swim", cost: 1 });
    if (speeds.fly) options.push({ mode: "fly", cost: 1 });
  } else if (!rulesetCellBlocked(grid, to.x, to.y)) {
    options.push({ mode: "walk", cost: rulesetStepCost(grid, from, to) });
    if (speeds.climb) options.push({ mode: "climb", cost: rulesetCellEnterCost(grid, to.x, to.y) });
    if (speeds.fly) options.push({ mode: "fly", cost: 1 });
    if (speeds.burrow) options.push({ mode: "burrow", cost: rulesetStepCost(grid, from, to) });
  }
  let best: { mode: RulesetMoveMode; cost: number } | null = null;
  for (const option of options) {
    if (option.cost === null || spent + option.cost > modeLeftOf(mover, option.mode)) continue;
    if (!best || option.cost < best.cost) best = { mode: option.mode, cost: option.cost };
  }
  return best;
}

/** Whether one cell can see another: the Engine's one sight test (combat C6), which a wall or a mountain
 *  blocks and water does not. Symmetric, so the two always see each other or never do. */
export function rulesetLineOfSight(grid: TacticalGrid, a: RulesetCombatCell, b: RulesetCombatCell): boolean {
  return hasLineOfSight(grid, a, b);
}

/**
 * The cells a shape covers, in cells, with nothing solid in the way.
 *
 * A burst is every cell within `size` of the cell it was aimed at. A cone runs from the actor toward
 * that cell, as wide at each step as it is far, and a line runs the same way one cell wide by default.
 * All three stop at anything solid: a cell the origin cannot see is not in the area.
 */
export function rulesetAreaCells(
  shape: RulesetCombatArea["shape"],
  size: number,
  origin: RulesetCombatCell,
  toward: RulesetCombatCell,
  grid: TacticalGrid,
  width = 1,
): RulesetCombatCell[] {
  const reach = Math.max(1, Math.round(size));
  if (shape === "burst") return burstCells(reach, toward, grid);
  const dx = Math.sign(toward.x - origin.x);
  const dy = Math.sign(toward.y - origin.y);
  // Aimed at the cell it is standing in: there is no direction, so the shape covers nothing.
  if (dx === 0 && dy === 0) return [];
  return shape === "line"
    ? lineCells(reach, origin, dx, dy, grid, Math.max(1, Math.round(width)))
    : coneCells(reach, origin, dx, dy, grid);
}

/** The part of the board within `reach` of a cell. Every shape is scanned over THIS, never over its
 *  own size: a ruleset may declare an area ten thousand units across, and a loop that long would be
 *  a way to stall a server with one catalog entry. */
function boardBox(grid: TacticalGrid, around: RulesetCombatCell, reach: number) {
  return {
    top: Math.max(0, around.y - reach),
    bottom: Math.min(grid.height - 1, around.y + reach),
    left: Math.max(0, around.x - reach),
    right: Math.min(grid.width - 1, around.x + reach),
  };
}

function burstCells(reach: number, centre: RulesetCombatCell, grid: TacticalGrid): RulesetCombatCell[] {
  const cells: RulesetCombatCell[] = [];
  const box = boardBox(grid, centre, reach);
  for (let y = box.top; y <= box.bottom; y++) {
    for (let x = box.left; x <= box.right; x++) {
      if (rulesetCellBlocked(grid, x, y)) continue;
      if (!rulesetLineOfSight(grid, centre, { x, y })) continue;
      cells.push({ x, y });
    }
  }
  return cells;
}

function lineCells(
  reach: number,
  origin: RulesetCombatCell,
  dx: number,
  dy: number,
  grid: TacticalGrid,
  width: number,
): RulesetCombatCell[] {
  // Keep the one-cell path unchanged, including how a diagonal stops at a wall.
  if (width > 1) {
    const cells: RulesetCombatCell[] = [];
    const left = Math.floor(width / 2);
    const right = Math.floor((width - 1) / 2);
    const box = boardBox(grid, origin, reach + left);
    const axes = dx !== 0 && dy !== 0 ? 2 : 1;
    for (let y = box.top; y <= box.bottom; y++) {
      for (let x = box.left; x <= box.right; x++) {
        const offX = x - origin.x;
        const offY = y - origin.y;
        const along = offX * dx + offY * dy;
        // Screen y grows downwards: positive across is the caster's left. An even width puts
        // its extra column there. Diagonals measure across by the difference of their axes,
        // and along by their average, so the band stays contiguous on a square grid.
        const across = offX * dy - offY * dx;
        if (along <= 0 || along > reach * axes || across < -right || across > left) continue;
        if (rulesetCellBlocked(grid, x, y) || !rulesetLineOfSight(grid, origin, { x, y })) continue;
        cells.push({ x, y });
      }
    }
    return cells;
  }
  const cells: RulesetCombatCell[] = [];
  // `blocksSight` reads off the board as solid, so the line ends at the edge whatever its size.
  for (let step = 1; step <= reach; step++) {
    const cell = { x: origin.x + dx * step, y: origin.y + dy * step };
    // What blocks sight ends the line where it stands, rather than letting it carry on behind; it
    // carries on across water, where nobody stands.
    if (blocksSight(grid, cell.x, cell.y)) break;
    if (rulesetCellBlocked(grid, cell.x, cell.y)) continue;
    cells.push(cell);
  }
  return cells;
}

/**
 * A cone, as wide at each step as it is far: at `k` cells out it spreads `floor(k / 2)` to either
 * side of the line it was aimed along, which is the odd number of cells that centres on it. The same
 * rule holds whether it was aimed along an axis or corner-wise, so no direction is quietly wider.
 */
function coneCells(
  reach: number,
  origin: RulesetCombatCell,
  dx: number,
  dy: number,
  grid: TacticalGrid,
): RulesetCombatCell[] {
  const diagonal = dx !== 0 && dy !== 0;
  const cells: RulesetCombatCell[] = [];
  const box = boardBox(grid, origin, reach);
  for (let y = box.top; y <= box.bottom; y++) {
    for (let x = box.left; x <= box.right; x++) {
      const offX = x - origin.x;
      const offY = y - origin.y;
      const out = Math.max(Math.abs(offX), Math.abs(offY));
      if (out < 1 || out > reach) continue;
      const spread = Math.floor(out / 2);
      if (diagonal) {
        if (offX * dx < 1 || offY * dy < 1) continue;
        if (Math.abs(Math.abs(offX) - Math.abs(offY)) > spread) continue;
      } else if (dx !== 0) {
        if (offX * dx !== out || Math.abs(offY) > spread) continue;
      } else {
        if (offY * dy !== out || Math.abs(offX) > spread) continue;
      }
      if (rulesetCellBlocked(grid, x, y)) continue;
      if (!rulesetLineOfSight(grid, origin, { x, y })) continue;
      cells.push({ x, y });
    }
  }
  return cells;
}

// ── Moving ──

/** The best melee attack this combatant has: the one with the most damage behind it that reaches
 *  rather than carries. Something thrown counts, because a thrown weapon is still swung in hand.
 *  Null when it has nothing to strike a passer-by with. */
export function rulesetOpportunityAttack(combatant: RulesetCombatant): RulesetCombatAction | null {
  let best: RulesetCombatAction | null = null;
  let most = -1;
  for (const action of combatant.actions) {
    if (action.reach === undefined && action.range) continue;
    if (action.area || action.signature || action.sequence || !action.damage) continue;
    // The same bookkeeping the menu keeps: a strike that has run out of uses, or is waiting for its
    // dice, is not one to be made in passing either. (Written out rather than imported, because the
    // menu's own module reads this one.)
    if (action.uses && (combatant.uses[action.id] ?? 0) < 1) continue;
    if (combatant.spent.includes(action.id)) continue;
    // Nor is a weapon with nothing loaded or nothing to shoot, nor a second blow in the off hand,
    // which follows the holder's own attack on their own turn.
    if (!rulesetShotsAvailable(combatant, action) || action.offHandOf !== undefined) continue;
    // Nor is using an item: that is its holder's own choice on their own turn.
    if (action.itemUse) continue;
    const average = action.damage.count * ((action.damage.sides + 1) / 2) + action.damage.flat;
    if (average > most) {
      most = average;
      best = action;
    }
  }
  return best;
}

/** How far this action reaches to strike somebody, in cells. Anything with no distance of its own
 *  reaches the next cell. */
export function rulesetActionReach(action: { reach?: number; range?: { normal: number; long?: number } }): number {
  if (action.range) return Math.max(action.range.long ?? action.range.normal, action.range.normal);
  return Math.max(1, action.reach ?? 1);
}

/** Everybody who would strike at somebody leaving the cell next to them: standing, able to act and
 *  to react, holding the budget the ruleset says such a strike costs, and carrying something to
 *  strike with. A ruleset that declares no `opportunity` has none of this. */
export function rulesetThreateningEnemies(
  definition: RulesetDefinition,
  combat: RulesetCombat,
  state: RulesetEncounterState,
  mover: RulesetCombatant,
): Array<{ combatant: RulesetCombatant; at: RulesetCombatCell; reach: number }> {
  const opportunity = combat.opportunity;
  if (!opportunity || mover.flags.disengaged) return [];
  const threats: Array<{ combatant: RulesetCombatant; at: RulesetCombatCell; reach: number }> = [];
  for (const combatant of state.combatants) {
    if (combatant.side === mover.side || !rulesetCombatStanding(combatant)) continue;
    if ((combatant.budgets[opportunity.budget] ?? 0) < 1) continue;
    const effects = rulesetCombatEffects(definition, combat, combatant, state);
    if (effects.has("cannot-act") || effects.has("cannot-react")) continue;
    const at = rulesetPositionOf(combatant);
    const strike = rulesetOpportunityAttack(combatant);
    if (!at || !strike) continue;
    const reach = Math.max(1, strike.reach ?? 1);
    // Somebody up in the air too high above (or below) to be reached is no threat to them (1.109).
    const grid = state.board?.grid;
    const levelCells = state.board?.levelCells;
    if (grid && levelCells && (rulesetAirborne(grid, mover) || rulesetAirborne(grid, combatant))) {
      if (Math.abs(rulesetLevelOf(grid, mover) - rulesetLevelOf(grid, combatant)) * levelCells > reach) continue;
    }
    threats.push({ combatant, at, reach });
  }
  return threats;
}

/**
 * Every cell this combatant could walk to on what is left of their allowance, with what each one
 * costs, the cells the walk goes through and the enemies whose reach it leaves on the way.
 *
 * Eight neighbours at the cost of the ground they step onto, nothing solid, no corner cut between
 * two solid cells, a friend may be walked past and nobody at all may be stopped on. An enemy is a
 * wall: a fight where opponents walk through each other is not one anybody plays at.
 */
export function rulesetReachableCells(
  definition: RulesetDefinition,
  state: RulesetEncounterState,
  actorId: string,
): RulesetReachableCell[] {
  const combat = definition.combat;
  const grid = state.board?.grid;
  const actor = rulesetCombatant(state, actorId);
  const from = rulesetPositionOf(actor);
  if (!combat || !grid || !actor || !from) return [];
  const budget = Math.min(MOVEMENT_CEILING, Math.max(0, Math.floor(actor.movementLeft ?? 0)));
  if (budget < 1) return [];

  const blockers = new Set<string>();
  const occupied = new Set<string>();
  for (const combatant of state.combatants) {
    if (combatant.id === actor.id || !rulesetCombatStanding(combatant)) continue;
    const at = rulesetPositionOf(combatant);
    if (!at) continue;
    occupied.add(`${at.x},${at.y}`);
    if (combatant.side !== actor.side) blockers.add(`${at.x},${at.y}`);
  }

  // Whoever this combatant may not get any nearer to, and how near they stand right now. A cell
  // closer than that is not offered at all, so the menu stays the one place legality lives.
  const held: Array<{ at: RulesetCombatCell; away: number }> = [];
  for (const entry of rulesetActiveConditions(definition, combat, actor, state)) {
    if (!entry.effects.includes("cannot-approach-source")) continue;
    const sourceId = actor.tracked.find((tracked) => tracked.condition === entry.condition)?.source;
    const at = sourceId ? rulesetPositionOf(rulesetCombatant(state, sourceId)) : null;
    if (at) held.push({ at, away: rulesetCellDistance(from, at) });
  }

  const threats = rulesetThreateningEnemies(definition, combat, state, actor);
  const slowed = rulesetSlowedCells(state, actor);
  const best = new Map<string, number>([[`${from.x},${from.y}`, 0]]);
  const cameFrom = new Map<string, string>();
  const cells = new Map<string, RulesetReachableCell>();
  // A small board and a small allowance: the cheapest open cell is found by a scan rather than by a
  // heap, which is fewer moving parts for the same answer.
  const open = new Map<string, RulesetCombatCell>([[`${from.x},${from.y}`, from]]);
  while (open.size > 0) {
    let key: string | null = null;
    let at: RulesetCombatCell | null = null;
    let cheapest = Infinity;
    for (const [candidate, cell] of open) {
      const cost = best.get(candidate) ?? Infinity;
      if (cost < cheapest) {
        cheapest = cost;
        key = candidate;
        at = cell;
      }
    }
    if (key === null || at === null) break;
    open.delete(key);
    for (const [dx, dy] of STEPS) {
      const x = at.x + dx;
      const y = at.y + dy;
      const next = `${x},${y}`;
      if (rulesetCellSolidFor(grid, x, y, actor) || blockers.has(next)) continue;
      // Somebody this combatant may not approach is not walked PAST either. A route that dips
      // inside the ring and comes out the far side is still getting nearer, which is the thing the
      // condition forbids, and the board DRAWS that route. So the step is refused rather than only
      // the place it would have ended, and a cell far enough away is still offered whenever there
      // is a way round.
      if (held.some((source) => rulesetCellDistance({ x, y }, source.at) < source.away)) continue;
      // No squeezing between two solid corners: a step corner-wise needs one of its two sides open.
      if (
        dx !== 0 &&
        dy !== 0 &&
        rulesetCellSolidFor(grid, at.x + dx, at.y, actor) &&
        rulesetCellSolidFor(grid, at.x, at.y + dy, actor)
      )
        continue;
      // The cheapest way they move that takes this step on what that way has left (1.108).
      const plain = rulesetMoveStep(grid, at, { x, y }, actor, cheapest)?.cost;
      if (plain === undefined) continue;
      // Ground a lasting area makes hard going (1.168).
      const step = rulesetSlowedStep(grid, { x, y }, plain, slowed);
      const cost = cheapest + step;
      if (cost > budget || cost >= (best.get(next) ?? Infinity)) continue;
      best.set(next, cost);
      cameFrom.set(next, key);
      open.set(next, { x, y });
      // A friend can be walked past and not stood on, so their cell is searched through and never
      // offered as somewhere to stop.
      if (occupied.has(next)) continue;
      const path = pathTo(cameFrom, from, { x, y });
      cells.set(next, { x, y, cost, path, provokes: provokedBy(threats, from, path) });
    }
  }
  return [...cells.values()].sort((a, b) => a.cost - b.cost || a.y - b.y || a.x - b.x);
}

/**
 * The cells somebody pushed straight away from another crosses: up to `cells` steps along the line
 * from the pusher through them, stopping short of anything solid, anybody standing, the board's edge
 * or a corner too tight to squeeze through, exactly as a walk would. Empty when there is nowhere to
 * go. A push is not a walk: it spends nothing and nobody strikes at it on the way.
 */
export function rulesetPushPath(
  state: RulesetEncounterState,
  pusherId: string,
  targetId: string,
  cells: number,
): RulesetCombatCell[] {
  const grid = state.board?.grid;
  const from = rulesetPositionOf(rulesetCombatant(state, pusherId));
  const target = rulesetPositionOf(rulesetCombatant(state, targetId));
  if (!grid || !from || !target) return [];
  const dx = Math.sign(target.x - from.x);
  const dy = Math.sign(target.y - from.y);
  if (dx === 0 && dy === 0) return [];
  const occupied = new Set(
    state.combatants.flatMap((combatant) => {
      const at = combatant.id === targetId || !rulesetCombatStanding(combatant) ? null : rulesetPositionOf(combatant);
      return at ? [`${at.x},${at.y}`] : [];
    }),
  );
  const path: RulesetCombatCell[] = [];
  let at = target;
  for (let step = 0; step < Math.min(cells, MOVEMENT_CEILING); step++) {
    const x = at.x + dx;
    const y = at.y + dy;
    if (rulesetCellBlocked(grid, x, y) || occupied.has(`${x},${y}`)) break;
    if (
      dx !== 0 &&
      dy !== 0 &&
      rulesetCellBlocked(grid, at.x + dx, at.y) &&
      rulesetCellBlocked(grid, at.x, at.y + dy)
    ) {
      break;
    }
    // Height (combat C6b): nobody is shoved up a step of two levels or more, and somebody shoved off one
    // falls, and lies where they land.
    const rise = elevationAt(grid, x, y) - elevationAt(grid, at.x, at.y);
    if (rise > 1) break;
    at = { x, y };
    path.push(at);
    if (rise < -1) break;
  }
  return path;
}

/**
 * What it costs to walk from each cell of the board to a cell next to one of `goals`, by the steps,
 * terrain costs and corner rule a walk pays; a cell no route reaches is absent. Reach and range are
 * measured in a straight line, but closing that distance is walked, and the two part ways wherever
 * a wall stands between: two fighters either side of a ridge are two cells apart and a long way
 * round. Who stands where is left out, since they move while the walk is under way.
 */
export function rulesetWalkingDistances(
  grid: TacticalGrid,
  goals: ReadonlyArray<RulesetCombatCell>,
  /** Who is moving, when they move some way besides walking (1.108): their ways count, with no
   *  turn's allowance to run out of. */
  mover?: RulesetCombatant,
): Map<string, number> {
  const unbounded = mover?.speeds
    ? {
        ...mover,
        modeLeft: Object.fromEntries(
          (["walk", ...Object.keys(mover.speeds)] as RulesetMoveMode[]).map((mode) => [mode, Infinity]),
        ),
      }
    : undefined;
  const solid = (x: number, y: number) => rulesetCellSolidFor(grid, x, y, unbounded);
  const into = (from: RulesetCombatCell, to: RulesetCombatCell) =>
    unbounded ? (rulesetMoveStep(grid, from, to, unbounded)?.cost ?? null) : rulesetStepCost(grid, from, to);
  const best = new Map<string, number>();
  // Terrain costs are small whole numbers, so the cheapest open cell is kept in buckets by cost
  // rather than found by a scan over a board that may be 64 by 64.
  const buckets: RulesetCombatCell[][] = [];
  const reach = (x: number, y: number, cost: number) => {
    if (cost >= (best.get(`${x},${y}`) ?? Infinity)) return;
    best.set(`${x},${y}`, cost);
    (buckets[cost] ??= []).push({ x, y });
  };
  // Standing next to a goal is where a walk towards it ends, so those cells cost nothing more.
  for (const goal of goals) {
    for (const [dx, dy] of STEPS) {
      if (!solid(goal.x + dx, goal.y + dy)) reach(goal.x + dx, goal.y + dy, 0);
    }
  }
  for (let cost = 0; cost < buckets.length; cost++) {
    for (const at of buckets[cost] ?? []) {
      if (best.get(`${at.x},${at.y}`) !== cost) continue;
      // Walked the other way: stepping from the neighbour INTO `at` costs what entering `at` does, and
      // what climbing up to it does (combat C6b), which is not the same both ways.
      for (const [dx, dy] of STEPS) {
        const x = at.x + dx;
        const y = at.y + dy;
        if (solid(x, y)) continue;
        if (dx !== 0 && dy !== 0 && solid(at.x + dx, at.y) && solid(at.x, at.y + dy)) {
          continue;
        }
        const step = into({ x, y }, at);
        if (step !== null) reach(x, y, cost + step);
      }
    }
  }
  return best;
}

function pathTo(
  cameFrom: ReadonlyMap<string, string>,
  from: RulesetCombatCell,
  to: RulesetCombatCell,
): RulesetCombatCell[] {
  const path: RulesetCombatCell[] = [];
  let key: string | undefined = `${to.x},${to.y}`;
  const start = `${from.x},${from.y}`;
  while (key && key !== start && path.length <= MOVEMENT_CEILING) {
    const [x, y] = key.split(",").map(Number) as [number, number];
    path.unshift({ x, y });
    key = cameFrom.get(key);
  }
  return path;
}

/** Whether one step takes a walker out of this threat's reach: inside it before, outside it after.
 *  The preview and the resolution both ask exactly this, so they can never name different people. */
export function rulesetStepLeavesReach(
  threat: { at: RulesetCombatCell; reach: number },
  from: RulesetCombatCell,
  to: RulesetCombatCell,
): boolean {
  return rulesetCellDistance(threat.at, from) <= threat.reach && rulesetCellDistance(threat.at, to) > threat.reach;
}

/** Whose reach this walk leaves, in the order it leaves them. One strike each: a budget is a budget,
 *  however many times somebody dances in and out of it. */
function provokedBy(
  threats: ReadonlyArray<{ combatant: RulesetCombatant; at: RulesetCombatCell; reach: number }>,
  from: RulesetCombatCell,
  path: readonly RulesetCombatCell[],
): string[] {
  if (threats.length === 0) return [];
  const provoked: string[] = [];
  let previous = from;
  for (const cell of path) {
    for (const threat of threats) {
      if (provoked.includes(threat.combatant.id)) continue;
      if (rulesetStepLeavesReach(threat, previous, cell)) provoked.push(threat.combatant.id);
    }
    previous = cell;
  }
  return provoked;
}

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

/** How a zone slows a cell for one mover: the plain steps moving into it costs at least (1.168, 1.170),
 *  and whether speed is halved there on top (1.170). */
export interface RulesetSlowedCell {
  times: number;
  halves: boolean;
}

/** The cells a mover finds hard going because a zone that catches them covers them (1.168): the
 *  slowest of each cell's zones, and halved where any of them halves speed (1.170). */
export function rulesetSlowedCells(
  state: RulesetEncounterState,
  mover: RulesetCombatant,
): Map<string, RulesetSlowedCell> {
  const slowed = new Map<string, RulesetSlowedCell>();
  for (const caster of state.combatants) {
    for (const zone of caster.zones ?? []) {
      const action = caster.actions.find((entry) => entry.id === zone.actionId);
      const rule = action?.zone;
      if (!rule || !(rule.difficult || rule.costTimes || rule.halvesSpeed)) continue;
      if (!rulesetZoneCatches(caster, zone, action, mover)) continue;
      const times = rule.costTimes ?? (rule.difficult ? 2 : 1);
      for (const cell of rulesetZoneCells(state, caster, zone)) {
        const key = `${cell.x},${cell.y}`;
        const was = slowed.get(key);
        slowed.set(key, {
          times: Math.max(was?.times ?? 1, times),
          halves: (was?.halves ?? false) || !!rule.halvesSpeed,
        });
      }
    }
  }
  return slowed;
}

/** A step into a cell a zone slows costs its times the ground's plain price, without charging again
 *  for ground that was already hard going: difficult terrain does not stack (1.168). Halved speed is
 *  on top of that, as the step costs double again (1.170). */
export function rulesetSlowedStep(
  grid: TacticalGrid,
  cell: RulesetCombatCell,
  step: number,
  slowed: ReadonlyMap<string, RulesetSlowedCell>,
): number {
  const slow = slowed.get(`${cell.x},${cell.y}`);
  if (!slow) return step;
  const hard = step + Math.max(0, slow.times - rulesetCellEnterCost(grid, cell.x, cell.y));
  return slow.halves ? hard * 2 : hard;
}
