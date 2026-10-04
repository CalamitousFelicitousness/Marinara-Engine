// ──────────────────────────────────────────────
// Edge tiles (Pixelforge edges): water, roads and a town's streets drawn so they blend into the ground
// around them. A dual grid: each piece sits on a corner where four cells meet, and which of the four are
// the terrain (a 4-bit mask) picks one of a block's sixteen pieces, laid out four by four as SpriteCook's
// top-down tilesets are (mask bits: top-left 1, top-right 2, bottom-left 4, bottom-right 8). An image pack
// carries a terrain's blocks as the tile `edge_<terrain>`, each variant a block four cells by four.
// ──────────────────────────────────────────────

/** The blending terrains, in the order they are drawn: water before roads, a town's streets before its
 *  square (the square drawn over the street where they meet). */
export const WORLD_EDGE_TERRAINS = Object.freeze(["water", "road", "street", "square"] as const);
export type WorldEdgeTerrain = (typeof WORLD_EDGE_TERRAINS)[number];

/** A block's piece for each mask (0-15), counted across then down its four by four cells; -1 for none.
 *  Mask 15 (fully inside) is piece 6, the terrain's own middle. */
export const WORLD_EDGE_PIECE_BY_MASK: readonly number[] = Object.freeze([
  -1, 15, 8, 9, 0, 11, 14, 7, 13, 4, 1, 10, 3, 2, 5, 6,
]);

/** A terrain's variant blocks that have all sixteen pieces (a block whose sheet did not load is left out
 *  rather than drawn with holes). */
export function worldWholeEdgeBlocks<T>(blocks: ReadonlyArray<ReadonlyArray<T | undefined> | undefined>): T[][] {
  return blocks.filter(
    (block): block is T[] => !!block && block.length === 16 && Array.from(block).every((piece) => piece !== undefined),
  );
}

/**
 * The mask of the corner at (x, y), where the cells (x-1, y-1), (x, y-1), (x-1, y) and (x, y) meet, from
 * whether each is the terrain. Outside the map a cell counts as the nearest cell on its edge, so the
 * terrain runs on past the map's border instead of stopping at a shore drawn along it.
 */
export function worldEdgeMask(
  filled: (x: number, y: number) => boolean,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  const at = (cx: number, cy: number) =>
    filled(Math.min(width - 1, Math.max(0, cx)), Math.min(height - 1, Math.max(0, cy)));
  return (at(x - 1, y - 1) ? 1 : 0) | (at(x, y - 1) ? 2 : 0) | (at(x - 1, y) ? 4 : 0) | (at(x, y) ? 8 : 0);
}

/**
 * The cells a way between two settlements passes through on the overworld, walked four-connected (each
 * step one cell across or down, never a corner-to-corner step, so a road never pinches to a diagonal),
 * from the middle of one cell to the middle of the other. `skip` leaves cells out (water, a settlement's
 * own cell). Walked the same way whichever end it starts from (ties between the two axes would otherwise
 * lay a way and its way back side by side), and listed from `from`.
 */
export function worldRoadCells(
  start: { x: number; y: number },
  end: { x: number; y: number },
  skip: (x: number, y: number) => boolean,
): Array<{ x: number; y: number }> {
  const flip = start.y > end.y || (start.y === end.y && start.x > end.x);
  const [from, to] = flip ? [end, start] : [start, end];
  const out: Array<{ x: number; y: number }> = [];
  let [x, y] = [from.x, from.y];
  const [dx, dy] = [Math.abs(to.x - from.x), Math.abs(to.y - from.y)];
  const [sx, sy] = [Math.sign(to.x - from.x), Math.sign(to.y - from.y)];
  // A supercover walk: step along whichever axis the line reaches the next cell border on first.
  let [ix, iy] = [0, 0];
  const push = () => {
    if (!skip(x, y)) out.push({ x, y });
  };
  push();
  while (ix < dx || iy < dy) {
    if ((0.5 + ix) * dy < (0.5 + iy) * dx || iy >= dy) {
      x += sx;
      ix++;
    } else {
      y += sy;
      iy++;
    }
    push();
  }
  return flip ? out.reverse() : out;
}
