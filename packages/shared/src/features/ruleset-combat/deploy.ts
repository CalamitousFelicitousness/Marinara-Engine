import type { CombatRole } from "../combat-minds.js";
import { isImpassable } from "../tactical-combat/math.js";
import type { TacticalGrid } from "../tactical-combat/types.js";

/**
 * Where the Game Master starts somebody (2026-10-24, Alyssa): every opponent, and a party member only
 * where the story put them (the wizard who walked into the cavern first stands at the front when the
 * goblins spring). Said from the combatant's own side:
 *
 *   - `front`: the front of its side, nearest the other; `rear`: the back of it.
 *   - `ahead`: out ahead of its side, alone.
 *   - `flank`: off to one side of the other side; `behind`: past the other side, at its back.
 *   - `among`: in the middle of the other side.
 *   - `hidden`: in cover near its side.
 */
export const COMBAT_START_PLACES = Object.freeze([
  "front",
  "rear",
  "ahead",
  "flank",
  "behind",
  "among",
  "hidden",
] as const);
export type CombatStartPlace = (typeof COMBAT_START_PLACES)[number];

type Cell = { x: number; y: number };
type Stand = { id: string; side: "party" | "enemy" };

const STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

const key = (cell: Cell) => `${cell.x},${cell.y}`;

/** Every open cell any of these reaches, walking round what nobody walks through. */
function reachableFrom(grid: TacticalGrid, from: readonly Cell[]): Set<string> {
  const seen = new Set<string>();
  const queue: Cell[] = [];
  for (const cell of from)
    if (!seen.has(key(cell))) {
      seen.add(key(cell));
      queue.push(cell);
    }
  while (queue.length) {
    const cell = queue.shift()!;
    for (const [dx, dy] of STEPS) {
      const next = { x: cell.x + dx, y: cell.y + dy };
      if (next.x < 0 || next.y < 0 || next.x >= grid.width || next.y >= grid.height) continue;
      if (seen.has(key(next)) || isImpassable(grid, next.x, next.y)) continue;
      seen.add(key(next));
      queue.push(next);
    }
  }
  return seen;
}

const centre = (cells: readonly Cell[]): Cell =>
  cells.length === 0
    ? { x: 0, y: 0 }
    : {
        x: cells.reduce((sum, one) => sum + one.x, 0) / cells.length,
        y: cells.reduce((sum, one) => sum + one.y, 0) / cells.length,
      };

/** The nearest open cell to `target` that the fight reaches and nobody holds. */
function nearestOpen(target: Cell, open: Set<string>, held: Set<string>): Cell | null {
  let best: Cell | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const cellKey of open) {
    if (held.has(cellKey)) continue;
    const [x, y] = cellKey.split(",").map(Number) as [number, number];
    const gap = (x - target.x) ** 2 + (y - target.y) ** 2;
    if (gap < bestGap) {
      best = { x, y };
      bestGap = gap;
    }
  }
  return best;
}

/**
 * The placements with each one the Game Master started somewhere moved there, and each companion
 * the AI plays set by its role (a marksman or a caster a little back from the front, one who fights
 * hand to hand a little forward of it). Nobody is moved where the fight does not reach, and nobody
 * onto anybody else.
 */
export function rulesetStartPlacements(
  grid: TacticalGrid,
  placements: Record<string, Cell>,
  stands: readonly Stand[],
  places: Readonly<Record<string, CombatStartPlace>>,
  roles: Readonly<Record<string, CombatRole>> = {},
): Record<string, Cell> {
  const out: Record<string, Cell> = { ...placements };
  const at = (side: "party" | "enemy") =>
    stands.filter((one) => one.side === side && out[one.id]).map((one) => out[one.id]!);
  const open = reachableFrom(grid, Object.values(placements));
  const sides = { party: centre(at("party")), enemy: centre(at("enemy")) };
  const toward = (from: Cell, to: Cell) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    return { x: dx / length, y: dy / length };
  };
  let flank = 1;
  const move = (one: Stand, target: Cell) => {
    const held = new Set(
      stands.filter((other) => other.id !== one.id && out[other.id]).map((other) => key(out[other.id]!)),
    );
    const cell = nearestOpen(target, open, held);
    if (cell) out[one.id] = cell;
  };
  for (const one of stands) {
    const place = places[one.id];
    const own = sides[one.side];
    const other = sides[one.side === "party" ? "enemy" : "party"];
    const d = toward(own, other);
    const side = { x: -d.y, y: d.x };
    if (place) {
      const target =
        place === "front"
          ? { x: own.x + d.x * 2, y: own.y + d.y * 2 }
          : place === "rear"
            ? { x: own.x - d.x * 3, y: own.y - d.y * 3 }
            : place === "ahead"
              ? { x: own.x + d.x * 5, y: own.y + d.y * 5 }
              : place === "flank"
                ? { x: other.x + side.x * 4 * (flank = -flank), y: other.y + side.y * 4 * flank }
                : place === "behind"
                  ? { x: other.x + d.x * 3, y: other.y + d.y * 3 }
                  : place === "among"
                    ? other
                    : null;
      if (target) move(one, target);
      else {
        // In cover: the nearest wood or ruin within six cells of its side, else where it stands.
        const cover = [...open].flatMap((cellKey) => {
          const [x, y] = cellKey.split(",").map(Number) as [number, number];
          const terrain = grid.tiles[y]?.[x];
          return (terrain === "forest" || terrain === "ruin") && Math.hypot(x - own.x, y - own.y) <= 6
            ? [{ x, y }]
            : [];
        });
        if (cover.length)
          move(
            one,
            cover.sort((a, b) => Math.hypot(a.x - own.x, a.y - own.y) - Math.hypot(b.x - own.x, b.y - own.y))[0]!,
          );
      }
      continue;
    }
    const role = roles[one.id];
    const from = out[one.id];
    if (!role || !from) continue;
    const by =
      role === "marksman" || role === "spellcaster" || role === "supporter" || role === "controller"
        ? -2
        : role === "bruiser" || role === "bulwark"
          ? 1
          : 0;
    if (by !== 0) move(one, { x: from.x + d.x * by, y: from.y + d.y * by });
  }
  return out;
}

/**
 * Where the player may set their own down before the fight begins (2026-10-24): an open cell the
 * fight reaches within two of where their side lines up, and not within two of an opponent.
 */
export function rulesetDeployCells(
  grid: TacticalGrid,
  placements: Record<string, Cell>,
  stands: readonly Stand[],
  deployers: readonly string[],
): Cell[] {
  const open = reachableFrom(grid, Object.values(placements));
  const home = deployers.flatMap((id) => (placements[id] ? [placements[id]!] : []));
  const foes = stands.filter((one) => one.side === "enemy" && placements[one.id]).map((one) => placements[one.id]!);
  const apart = (a: Cell, b: Cell) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  const cells: Cell[] = [];
  for (const cellKey of open) {
    const [x, y] = cellKey.split(",").map(Number) as [number, number];
    const cell = { x, y };
    if (home.some((one) => apart(one, cell) <= 2) && foes.every((one) => apart(one, cell) > 2)) cells.push(cell);
  }
  return cells.sort((a, b) => a.y - b.y || a.x - b.x);
}
