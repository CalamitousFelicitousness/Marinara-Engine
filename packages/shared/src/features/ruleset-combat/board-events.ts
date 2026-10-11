/**
 * The board doing things on its own (Capability API 1.313): growth spreading, ice cracking, a wheel
 * turning, the ground freezing in rings. Each event happens at the start or end of the rounds it
 * names, on the cells its `where` reaches that time, and changes what its `change` says. Growth on a
 * cell is hard going and lightly obscures it; it is cut back, burnt away or cleared.
 */
import {
  TERRAIN_DATA,
  type TacticalGrid,
  type TacticalGroundCell,
  type TacticalTerrain,
} from "../tactical-combat/types.js";
import { TACTICAL_TERRAINS } from "../tactical-combat/environments.js";
import { rulesetFitCell } from "./encounter.js";
import { rulesetFootprint, rulesetPositionOf } from "./grid.js";
import type {
  RulesetBoardEvent,
  RulesetBoardEventChange,
  RulesetBoardEventWhere,
  RulesetCombatCell,
  RulesetCombatEvent,
  RulesetEncounterState,
} from "./types.js";

/** The most events one board has. */
export const RULESET_BOARD_EVENTS_MAX = 32;

const key = (cell: RulesetCombatCell) => `${cell.x},${cell.y}`;
const LIGHTS = new Set(["bright", "dim", "dark", "sunlight", "clear"]);
const TERRAINS = new Set<string>(TACTICAL_TERRAINS);

/** A board event as a fight is handed it (1.313), before it is checked. */
export interface RulesetBoardEventInput {
  id?: string;
  label?: string;
  at: "round-start" | "round-end";
  from?: number;
  every?: number;
  until?: number;
  where: RulesetBoardEventWhere;
  onlyOn?: TacticalTerrain[];
  change: RulesetBoardEventChange;
}

/** The events a board is handed (1.313), as a fight keeps them: each with somewhere to happen and
 *  something to do. One that is neither is left out, as is a rotation of anything but a square. */
export function rulesetBoardEvents(
  grid: TacticalGrid,
  events: readonly RulesetBoardEventInput[] | undefined,
): RulesetBoardEvent[] {
  const used = new Set<string>();
  const whole = (value: unknown, least: number) =>
    typeof value === "number" && Number.isInteger(value) && value >= least ? value : undefined;
  const cellOk = (cell: unknown): cell is RulesetCombatCell =>
    !!cell &&
    typeof cell === "object" &&
    Number.isInteger((cell as RulesetCombatCell).x) &&
    Number.isInteger((cell as RulesetCombatCell).y) &&
    (cell as RulesetCombatCell).x >= 0 &&
    (cell as RulesetCombatCell).y >= 0 &&
    (cell as RulesetCombatCell).x < grid.width &&
    (cell as RulesetCombatCell).y < grid.height;
  return (events ?? []).slice(0, RULESET_BOARD_EVENTS_MAX).flatMap((event, index) => {
    if (!event || (event.at !== "round-start" && event.at !== "round-end") || !event.where || !event.change) return [];
    const where = whereOf(event.where);
    if (!where) return [];
    const change = changeOf(event.change, where);
    if (!change) return [];
    let id = typeof event.id === "string" && event.id.trim() ? event.id.trim() : `event-${index + 1}`;
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    const onlyOn = (event.onlyOn ?? []).filter((terrain) => TERRAINS.has(terrain));
    const until = whole(event.until, 1);
    return [
      {
        id,
        ...(typeof event.label === "string" && event.label.trim() ? { label: event.label.trim() } : {}),
        at: event.at,
        from: whole(event.from, 1) ?? (event.at === "round-start" ? 2 : 1),
        every: whole(event.every, 1) ?? 1,
        ...(until !== undefined ? { until } : {}),
        where,
        ...(onlyOn.length ? { onlyOn } : {}),
        change,
      },
    ];
  });

  function whereOf(where: RulesetBoardEventWhere): RulesetBoardEventWhere | null {
    if ("cells" in where) {
      const cells = (Array.isArray(where.cells) ? where.cells : [])
        .filter(cellOk)
        .map((cell) => ({ x: cell.x, y: cell.y }));
      return cells.length ? { cells } : null;
    }
    if ("block" in where) {
      const { x, y, w, h } = where.block ?? ({} as never);
      if (!cellOk({ x, y }) || !whole(w, 1) || !whole(h, 1)) return null;
      return { block: { x, y, w: Math.min(w, grid.width - x), h: Math.min(h, grid.height - y) } };
    }
    if ("ring" in where) {
      const { x, y, start, step, filled } = where.ring ?? ({} as never);
      if (!cellOk({ x, y }) || whole(start, 0) === undefined || whole(step, 0) === undefined) return null;
      return { ring: { x, y, start, step, ...(filled ? { filled: true as const } : {}) } };
    }
    if ("sweep" in where) {
      const { from, start, step, filled } = where.sweep ?? ({} as never);
      if (!["north", "south", "east", "west"].includes(from)) return null;
      if (whole(start, 0) === undefined || whole(step, 0) === undefined) return null;
      return { sweep: { from, start, step, ...(filled ? { filled: true as const } : {}) } };
    }
    if ("spread" in where && where.spread === "growth") return { spread: "growth" };
    return null;
  }

  function changeOf(change: RulesetBoardEventChange, where: RulesetBoardEventWhere): RulesetBoardEventChange | null {
    const out: RulesetBoardEventChange = {};
    if (change.terrain !== undefined && TERRAINS.has(change.terrain)) out.terrain = change.terrain;
    if (Number.isInteger(change.height) && change.height! >= 0 && change.height! <= 3) out.height = change.height;
    if (change.light !== undefined && LIGHTS.has(change.light)) out.light = change.light;
    if (change.obscured === "light" || change.obscured === "heavy" || change.obscured === "clear")
      out.obscured = change.obscured;
    if (typeof change.growth === "boolean") out.growth = change.growth;
    if (change.season === null) out.season = null;
    else if (typeof change.season === "string" && change.season.trim()) out.season = change.season.trim();
    // Only a square block turns.
    if ((change.rotate === 1 || change.rotate === 2 || change.rotate === 3) && "block" in where) {
      if (where.block.w === where.block.h) out.rotate = change.rotate;
    }
    if (typeof change.tell === "string" && change.tell.trim()) out.tell = change.tell.trim();
    return Object.keys(out).length ? out : null;
  }
}

/** The cells an event reaches the `time`th time it happens (from 0), on the board as it stands. */
export function rulesetBoardEventCells(
  grid: TacticalGrid,
  event: Pick<RulesetBoardEvent, "where" | "onlyOn">,
  time: number,
): RulesetCombatCell[] {
  const where = event.where;
  const all: RulesetCombatCell[] = [];
  const inside = (cell: RulesetCombatCell) => cell.x >= 0 && cell.y >= 0 && cell.x < grid.width && cell.y < grid.height;
  const band = (distance: number, start: number, step: number, filled?: true) => {
    const reach = start + time * step;
    return distance <= reach && (filled || time === 0 || distance > reach - step);
  };
  if ("cells" in where) all.push(...where.cells.filter(inside));
  else if ("block" in where) {
    const { x, y, w, h } = where.block;
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) all.push({ x: x + dx, y: y + dy });
  } else {
    for (let y = 0; y < grid.height; y++) {
      for (let x = 0; x < grid.width; x++) {
        if ("ring" in where) {
          const { ring } = where;
          if (band(Math.max(Math.abs(x - ring.x), Math.abs(y - ring.y)), ring.start, ring.step, ring.filled))
            all.push({ x, y });
        } else if ("sweep" in where) {
          const { sweep } = where;
          const index =
            sweep.from === "north"
              ? y
              : sweep.from === "south"
                ? grid.height - 1 - y
                : sweep.from === "west"
                  ? x
                  : grid.width - 1 - x;
          if (band(index, sweep.start, sweep.step, sweep.filled)) all.push({ x, y });
        } else if (!grid.ground?.[`${x},${y}`]?.growth) {
          // Beside growth, on ground anybody could stand on.
          const terrain = grid.tiles[y]?.[x];
          if (terrain === undefined || TERRAIN_DATA[terrain]?.impassable) continue;
          const beside = [
            [x - 1, y],
            [x + 1, y],
            [x, y - 1],
            [x, y + 1],
          ].some(([bx, by]) => grid.ground?.[`${bx},${by}`]?.growth);
          if (beside) all.push({ x, y });
        }
      }
    }
  }
  return event.onlyOn ? all.filter((cell) => event.onlyOn!.includes(grid.tiles[cell.y]?.[cell.x]!)) : all;
}

/** Whether an event happens at this moment of this round, and which time it is (from 0). */
export function rulesetBoardEventTime(
  event: Pick<RulesetBoardEvent, "at" | "from" | "every" | "until">,
  at: "round-start" | "round-end",
  round: number,
): number | null {
  if (event.at !== at || round < event.from || (event.until !== undefined && round > event.until)) return null;
  const since = round - event.from;
  return since % event.every === 0 ? since / event.every : null;
}

/**
 * Every board event due at this moment of this round (1.313), in the order the board lists them,
 * done to the fight: the log lines they make. Whoever is left standing on a cell nobody may stand on
 * is moved to the nearest open one.
 */
export function rulesetRunBoardEvents(
  state: RulesetEncounterState,
  at: "round-start" | "round-end",
  round: number,
): RulesetCombatEvent[] {
  const board = state.board;
  if (!board?.events?.length) return [];
  const said: RulesetCombatEvent[] = [];
  for (const event of board.events) {
    const time = rulesetBoardEventTime(event, at, round);
    if (time === null) continue;
    const cells = rulesetBoardEventCells(board.grid, event, time);
    board.happened = { ...board.happened, [event.id]: (board.happened?.[event.id] ?? 0) + 1 };
    // A prop turned closes the cells it stands on now as the step ends, as every wall does.
    if (event.change.rotate && "block" in event.where) rotateBlock(state, event.where.block, event.change.rotate);
    for (const cell of cells) changeCell(board.grid, cell, event.change);
    const moved = settle(state);
    said.push({
      type: "boardEvent",
      id: event.id,
      ...(event.label ? { label: event.label } : {}),
      ...(event.change.tell ? { tell: event.change.tell } : {}),
      cells: cells.length,
      ...(moved.length ? { moved } : {}),
    });
  }
  return said;
}

/** The ground an action changes (1.319), as a board event changes it: whoever is left standing on a
 *  cell nobody may stand on is moved to the nearest open one. */
export function rulesetChangeGround(
  state: RulesetEncounterState,
  cells: readonly RulesetCombatCell[],
  change: RulesetBoardEventChange,
): Array<{ id: string; to: RulesetCombatCell }> {
  const grid = state.board?.grid;
  if (!grid) return [];
  for (const cell of cells) changeCell(grid, cell, change);
  return settle(state);
}

function changeCell(grid: TacticalGrid, cell: RulesetCombatCell, change: RulesetBoardEventChange): void {
  if (change.terrain && grid.tiles[cell.y]) grid.tiles[cell.y]![cell.x] = change.terrain;
  if (change.height !== undefined) {
    grid.elevation ??= Array.from({ length: grid.height }, () => Array(grid.width).fill(0));
    if (grid.elevation[cell.y]) grid.elevation[cell.y]![cell.x] = change.height;
  }
  const here: TacticalGroundCell = { ...grid.ground?.[key(cell)] };
  if (change.light === "clear") delete here.light;
  else if (change.light) here.light = change.light;
  if (change.obscured === "clear") delete here.obscured;
  else if (change.obscured) here.obscured = change.obscured;
  if (change.growth === true) here.growth = true;
  else if (change.growth === false) delete here.growth;
  if (change.season === null) delete here.season;
  else if (change.season) here.season = change.season;
  setGround(grid, cell, here);
}

function setGround(grid: TacticalGrid, cell: RulesetCombatCell, here: TacticalGroundCell): void {
  const ground = { ...grid.ground };
  if (Object.keys(here).length) ground[key(cell)] = here;
  else delete ground[key(cell)];
  if (Object.keys(ground).length) grid.ground = ground;
  else delete grid.ground;
}

/** A square block turned a quarter turn clockwise `turns` times: its tiles, heights and ground, the
 *  props wholly in it, and whoever stands wholly in it. */
function rotateBlock(
  state: RulesetEncounterState,
  block: { x: number; y: number; w: number; h: number },
  turns: 1 | 2 | 3,
): void {
  const grid = state.board!.grid;
  const size = block.w;
  const turn = (cell: RulesetCombatCell): RulesetCombatCell => {
    let dx = cell.x - block.x;
    let dy = cell.y - block.y;
    for (let n = 0; n < turns; n++) [dx, dy] = [size - 1 - dy, dx];
    return { x: block.x + dx, y: block.y + dy };
  };
  const within = (cell: RulesetCombatCell) =>
    cell.x >= block.x && cell.y >= block.y && cell.x < block.x + size && cell.y < block.y + size;
  const tiles = grid.tiles.map((row) => [...row]);
  const elevation = grid.elevation?.map((row) => [...row]);
  const ground = { ...grid.ground };
  const turnedGround: Record<string, TacticalGroundCell> = {};
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const from = { x: block.x + dx, y: block.y + dy };
      const to = turn(from);
      tiles[to.y]![to.x] = grid.tiles[from.y]![from.x]!;
      if (elevation && grid.elevation) elevation[to.y]![to.x] = grid.elevation[from.y]![from.x]!;
      const here = grid.ground?.[key(from)];
      delete ground[key(from)];
      if (here) turnedGround[key(to)] = here;
    }
  }
  grid.tiles = tiles;
  if (elevation) grid.elevation = elevation;
  const merged = { ...ground, ...turnedGround };
  if (Object.keys(merged).length) grid.ground = merged;
  else delete grid.ground;
  for (const prop of state.board!.props ?? []) {
    if (prop.cells.every(within)) prop.cells = prop.cells.map(turn);
  }
  for (const combatant of state.combatants) {
    const footprint = rulesetFootprint(combatant);
    if (!rulesetPositionOf(combatant) || !footprint.length || !footprint.every(within)) continue;
    const turned = footprint.map(turn);
    combatant.x = Math.min(...turned.map((cell) => cell.x));
    combatant.y = Math.min(...turned.map((cell) => cell.y));
  }
}

/** Whoever stands where nobody may stand now, set down at the nearest open cell. */
function settle(state: RulesetEncounterState): Array<{ id: string; to: RulesetCombatCell }> {
  const grid = state.board!.grid;
  const moved: Array<{ id: string; to: RulesetCombatCell }> = [];
  const taken = new Set<string>();
  for (const combatant of state.combatants) {
    if (combatant.defeated || !rulesetPositionOf(combatant)) continue;
    for (const cell of rulesetFootprint(combatant)) taken.add(key(cell));
  }
  for (const combatant of state.combatants) {
    if (combatant.defeated || !rulesetPositionOf(combatant)) continue;
    const footprint = rulesetFootprint(combatant);
    const blocked = footprint.some((cell) => {
      const terrain = grid.tiles[cell.y]?.[cell.x];
      return terrain !== undefined && !!TERRAIN_DATA[terrain]?.impassable;
    });
    if (!blocked) continue;
    for (const cell of footprint) taken.delete(key(cell));
    const span = combatant.span ?? 1;
    const to = rulesetFitCell(grid, { x: combatant.x!, y: combatant.y! }, span, taken);
    if (!to) {
      for (const cell of footprint) taken.add(key(cell));
      continue;
    }
    combatant.x = to.x;
    combatant.y = to.y;
    for (const cell of rulesetFootprint(combatant)) taken.add(key(cell));
    moved.push({ id: combatant.id, to });
  }
  return moved;
}

/** Growth taken off these cells (1.313): how many had any. */
export function rulesetClearGrowth(grid: TacticalGrid, cells: readonly RulesetCombatCell[]): number {
  let cleared = 0;
  for (const cell of cells) {
    const here = grid.ground?.[key(cell)];
    if (!here?.growth) continue;
    const { growth: _growth, ...rest } = here;
    setGround(grid, cell, rest);
    cleared += 1;
  }
  return cleared;
}

/** The growth rule a board keeps (1.313): what burns it and what cuts it, lowercased. */
export function rulesetGrowthRule(state: RulesetEncounterState): { burnedBy: string[]; cutBy: string[] } {
  return state.board?.growth ?? { burnedBy: ["fire"], cutBy: ["slashing"] };
}
