// ──────────────────────────────────────────────
// Floating windows: geometry math and the stored layout format
//
// Pure helpers shared by the floating-window store and component. Geometry is
// kept in viewport pixels exactly as the user left it; callers clamp it to the
// current viewport when they render, so a window returns to its place when the
// viewport grows again.
// ──────────────────────────────────────────────

export const FLOATING_WINDOW_LAYOUT_VERSION = 1 as const;
export const FLOATING_WINDOW_STORAGE_KEY = "marinara-floating-windows";
/** Gap kept between a window and the viewport edges. */
export const WINDOW_MARGIN_PX = 8;
export const WINDOW_KEYBOARD_STEP_PX = 10;
export const WINDOW_KEYBOARD_LARGE_STEP_PX = 50;

/** "chat-settings" today; later "drawer:<id>", "trackers", … */
export type FloatingWindowId = string;

export interface WindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowLayout extends WindowGeometry {
  pinned: boolean;
  locked: boolean;
}

export interface WindowLayoutSnapshot {
  version: typeof FLOATING_WINDOW_LAYOUT_VERSION;
  windows: Record<FloatingWindowId, WindowLayout>;
}

/** The area a window may occupy, with the margin already applied. */
export interface WindowBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface WindowSizeLimits {
  minWidth: number;
  minHeight: number;
}

export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const RESIZE_EDGES: readonly ResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];

const MAX_STORED_COORDINATE = 100_000;
const MAX_WINDOW_ID_LENGTH = 120;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function finiteOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Keeps a window inside `bounds`. When the bounds are smaller than the minimum
 * size, the minimum wins and the window sits at the top-left corner, so its
 * title bar and controls stay reachable.
 */
export function clampWindowGeometry(
  geometry: WindowGeometry,
  bounds: WindowBounds,
  limits: WindowSizeLimits,
): WindowGeometry {
  const availableWidth = Math.max(0, bounds.right - bounds.left);
  const availableHeight = Math.max(0, bounds.bottom - bounds.top);
  const width = Math.max(limits.minWidth, Math.min(finiteOr(geometry.width, limits.minWidth), availableWidth));
  const height = Math.max(limits.minHeight, Math.min(finiteOr(geometry.height, limits.minHeight), availableHeight));
  return {
    x: clamp(finiteOr(geometry.x, bounds.left), bounds.left, bounds.right - width),
    y: clamp(finiteOr(geometry.y, bounds.top), bounds.top, bounds.bottom - height),
    width,
    height,
  };
}

export function moveWindowGeometry(
  start: WindowGeometry,
  dx: number,
  dy: number,
  bounds: WindowBounds,
  limits: WindowSizeLimits,
): WindowGeometry {
  return clampWindowGeometry({ ...start, x: start.x + dx, y: start.y + dy }, bounds, limits);
}

/** Moves the dragged edge(s) only; the opposite edges stay where they are. */
export function resizeWindowGeometry(
  start: WindowGeometry,
  edge: ResizeEdge,
  dx: number,
  dy: number,
  bounds: WindowBounds,
  limits: WindowSizeLimits,
): WindowGeometry {
  const from = clampWindowGeometry(start, bounds, limits);
  const right = from.x + from.width;
  const bottom = from.y + from.height;
  let { x, y, width, height } = from;
  if (edge.includes("e")) width = clamp(from.width + dx, limits.minWidth, bounds.right - from.x);
  if (edge.includes("w")) {
    x = clamp(from.x + dx, bounds.left, right - limits.minWidth);
    width = right - x;
  }
  if (edge.includes("s")) height = clamp(from.height + dy, limits.minHeight, bounds.bottom - from.y);
  if (edge.includes("n")) {
    y = clamp(from.y + dy, bounds.top, bottom - limits.minHeight);
    height = bottom - y;
  }
  return clampWindowGeometry({ x, y, width, height }, bounds, limits);
}

function readStoredLayout(value: unknown): WindowLayout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const numbers = [source.x, source.y, source.width, source.height];
  if (!numbers.every((entry) => typeof entry === "number" && Number.isFinite(entry))) return null;
  const [x, y, width, height] = numbers as number[];
  if (width! <= 0 || height! <= 0) return null;
  if (numbers.some((entry) => Math.abs(entry as number) > MAX_STORED_COORDINATE)) return null;
  if (typeof source.pinned !== "boolean" || typeof source.locked !== "boolean") return null;
  return { x: x!, y: y!, width: width!, height: height!, pinned: source.pinned, locked: source.locked };
}

/**
 * Reads a stored layout snapshot. It never throws: a missing, corrupt or
 * older-version value gives an empty snapshot, and invalid entries are dropped.
 */
export function parseWindowLayoutSnapshot(raw: unknown): WindowLayoutSnapshot {
  const empty: WindowLayoutSnapshot = { version: FLOATING_WINDOW_LAYOUT_VERSION, windows: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const source = raw as { version?: unknown; windows?: unknown };
  if (source.version !== FLOATING_WINDOW_LAYOUT_VERSION) return empty;
  if (!source.windows || typeof source.windows !== "object" || Array.isArray(source.windows)) return empty;
  const windows: Record<FloatingWindowId, WindowLayout> = {};
  for (const [id, value] of Object.entries(source.windows as Record<string, unknown>)) {
    if (!id || id.length > MAX_WINDOW_ID_LENGTH) continue;
    const layout = readStoredLayout(value);
    if (layout) windows[id] = layout;
  }
  return { version: FLOATING_WINDOW_LAYOUT_VERSION, windows };
}

export function toWindowLayoutSnapshot(windows: Record<FloatingWindowId, WindowLayout>): WindowLayoutSnapshot {
  return { version: FLOATING_WINDOW_LAYOUT_VERSION, windows };
}
