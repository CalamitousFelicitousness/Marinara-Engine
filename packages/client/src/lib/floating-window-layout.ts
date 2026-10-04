// ──────────────────────────────────────────────
// Floating windows: geometry math and the stored layout format
//
// Pure helpers shared by the floating-window store and component. Geometry is
// kept in viewport pixels exactly as the user left it; callers clamp it to the
// current viewport when they render, so a window returns to its place when the
// viewport grows again.
// ──────────────────────────────────────────────

export const FLOATING_WINDOW_LAYOUT_VERSION = 1 as const;
/** Gap kept between a window and the viewport edges. */
export const WINDOW_MARGIN_PX = 8;
export const WINDOW_KEYBOARD_STEP_PX = 10;
export const WINDOW_KEYBOARD_LARGE_STEP_PX = 50;

/** "chat-settings", "trackers", or a popped-out drawer: "drawer:<host window id>:<drawer id>". */
export type FloatingWindowId = string;

const DRAWER_WINDOW_PREFIX = "drawer:";

/** The window a drawer pops out into. Hosts keep their own ids, so two hosts may reuse a drawer id. */
export function getDrawerWindowId(hostId: FloatingWindowId, drawerId: string): FloatingWindowId {
  return `${DRAWER_WINDOW_PREFIX}${hostId}:${drawerId}`;
}

/** True for the popped-out drawers of one host window. */
export function isHostDrawerWindowId(id: FloatingWindowId, hostId: FloatingWindowId): boolean {
  return id.startsWith(`${DRAWER_WINDOW_PREFIX}${hostId}:`);
}

export interface WindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowLayout extends WindowGeometry {
  pinned: boolean;
  locked: boolean;
  /** Minimizable windows: shown as a small button (its bubble) instead of the window. Older layouts have none. */
  minimized?: boolean;
  /** Where a minimizable window's bubble sits (its top-left corner, viewport pixels). */
  bubble?: WindowPoint;
}

export interface WindowPoint {
  x: number;
  y: number;
}

/** A window bubble is a square this size (px), like the chat's toolbar buttons. */
export const WINDOW_BUBBLE_SIZE_PX = 32;
/** Phones draw bubbles a little larger, like their toolbar buttons (the tap area is 44px either way). */
export const PHONE_BUBBLE_SIZE_PX = 36;
/** Room between phone bubbles in their default row, the gap snapping leaves (their 44px tap areas meet). */
export const PHONE_BUBBLE_GAP_PX = 8;

/** Keeps a bubble inside `bounds`, so it can never be lost off-screen. */
export function clampWindowBubble(
  point: WindowPoint,
  bounds: WindowBounds,
  size: number = WINDOW_BUBBLE_SIZE_PX,
): WindowPoint {
  return {
    x: clamp(finiteOr(point.x, bounds.left), bounds.left, bounds.right - size),
    y: clamp(finiteOr(point.y, bounds.top), bounds.top, bounds.bottom - size),
  };
}

/**
 * A phone bubble's default place: a row along the top of the chat, where its toolbar and menu buttons
 * were, `slot` 0 at the right edge (like the computer's row).
 */
export function getPhoneBubbleSlot(bounds: WindowBounds, slot: number): WindowPoint {
  return {
    x: bounds.right - PHONE_BUBBLE_SIZE_PX - slot * (PHONE_BUBBLE_SIZE_PX + PHONE_BUBBLE_GAP_PX),
    y: bounds.top,
  };
}

/** Saved with each chat (`chat.metadata.windowLayout`) and in chat settings profiles. */
export interface WindowLayoutSnapshot {
  version: typeof FLOATING_WINDOW_LAYOUT_VERSION;
  windows: Record<FloatingWindowId, WindowLayout>;
  /** Drawers popped out into their own windows (their window ids). Older snapshots have none. */
  detached?: FloatingWindowId[];
  /** Where each bubble sits on a phone, apart from the computer's places. Older snapshots have none. */
  phoneBubbles?: Record<FloatingWindowId, WindowPoint>;
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
  const layout: WindowLayout = {
    x: x!,
    y: y!,
    width: width!,
    height: height!,
    pinned: source.pinned,
    locked: source.locked,
  };
  // Optional (added after version 1 shipped): a bad value is dropped, the rest of the layout kept.
  if (typeof source.minimized === "boolean") layout.minimized = source.minimized;
  const bubble = readStoredPoint(source.bubble);
  if (bubble) layout.bubble = bubble;
  return layout;
}

function readStoredPoint(value: unknown): WindowPoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { x, y } = value as Record<string, unknown>;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.abs(x) > MAX_STORED_COORDINATE || Math.abs(y) > MAX_STORED_COORDINATE) return null;
  return { x, y };
}

/**
 * Reads a stored layout snapshot. It never throws: a missing, corrupt or
 * older-version value gives an empty snapshot, and invalid entries are dropped.
 */
export function parseWindowLayoutSnapshot(raw: unknown): WindowLayoutSnapshot {
  const empty: WindowLayoutSnapshot = { version: FLOATING_WINDOW_LAYOUT_VERSION, windows: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const source = raw as { version?: unknown; windows?: unknown; detached?: unknown; phoneBubbles?: unknown };
  if (source.version !== FLOATING_WINDOW_LAYOUT_VERSION) return empty;
  if (!source.windows || typeof source.windows !== "object" || Array.isArray(source.windows)) return empty;
  const windows: Record<FloatingWindowId, WindowLayout> = {};
  for (const [id, value] of Object.entries(source.windows as Record<string, unknown>)) {
    if (!isStoredWindowId(id)) continue;
    const layout = readStoredLayout(value);
    if (layout) windows[id] = layout;
  }
  // A popped-out drawer needs its place; one without a valid layout goes back to its host.
  const detached = Array.isArray(source.detached)
    ? (source.detached as unknown[]).filter(
        (id, index, list): id is FloatingWindowId =>
          isStoredWindowId(id) && id.startsWith(DRAWER_WINDOW_PREFIX) && !!windows[id] && list.indexOf(id) === index,
      )
    : [];
  const phoneBubbles: Record<FloatingWindowId, WindowPoint> = {};
  if (source.phoneBubbles && typeof source.phoneBubbles === "object" && !Array.isArray(source.phoneBubbles)) {
    for (const [id, value] of Object.entries(source.phoneBubbles as Record<string, unknown>)) {
      const point = isStoredWindowId(id) ? readStoredPoint(value) : null;
      if (point) phoneBubbles[id] = point;
    }
  }
  return toWindowLayoutSnapshot(windows, detached, phoneBubbles);
}

function isStoredWindowId(id: unknown): id is FloatingWindowId {
  return typeof id === "string" && id.length > 0 && id.length <= MAX_WINDOW_ID_LENGTH;
}

export function toWindowLayoutSnapshot(
  windows: Record<FloatingWindowId, WindowLayout>,
  detached: FloatingWindowId[] = [],
  phoneBubbles: Record<FloatingWindowId, WindowPoint> = {},
): WindowLayoutSnapshot {
  const snapshot: WindowLayoutSnapshot = { version: FLOATING_WINDOW_LAYOUT_VERSION, windows };
  if (detached.length > 0) snapshot.detached = detached;
  if (Object.keys(phoneBubbles).length > 0) snapshot.phoneBubbles = phoneBubbles;
  return snapshot;
}

/** True when a snapshot holds nothing, so the chat can store no layout at all. */
export function isEmptyWindowLayoutSnapshot(snapshot: WindowLayoutSnapshot): boolean {
  return (
    Object.keys(snapshot.windows).length === 0 &&
    !snapshot.detached?.length &&
    Object.keys(snapshot.phoneBubbles ?? {}).length === 0
  );
}

/** One string per layout, so two snapshots compare equal whatever order their fields were written in. */
export function serializeWindowLayoutSnapshot(raw: unknown): string {
  return JSON.stringify(parseWindowLayoutSnapshot(raw));
}

const DETACHED_GAP_PX = 12;

/**
 * Where a drawer popped out with its button opens: beside its host window (left first, then right),
 * level with where the drawer was. With no room on either side it overlaps the host, a little offset.
 */
export function placeDetachedDrawer(
  source: WindowGeometry,
  host: WindowGeometry | null,
  size: { width: number; height: number },
  bounds: WindowBounds,
  limits: WindowSizeLimits,
): WindowGeometry {
  const { width, height } = size;
  let x = source.x + 24;
  if (host && host.x - DETACHED_GAP_PX - width >= bounds.left) x = host.x - DETACHED_GAP_PX - width;
  else if (host && host.x + host.width + DETACHED_GAP_PX + width <= bounds.right) {
    x = host.x + host.width + DETACHED_GAP_PX;
  }
  return clampWindowGeometry({ x, y: source.y, width, height }, bounds, limits);
}

const BUBBLE_WINDOW_GAP_PX = 8;

/**
 * Where a minimizable window opens from its bubble: below it and lined up with its right edge (left
 * edge near the left side), or above it when there is no room below.
 */
export function placeWindowBesideBubble(
  size: { width: number; height: number },
  bubble: WindowPoint,
  bounds: WindowBounds,
  limits: WindowSizeLimits,
): WindowGeometry {
  const { width, height } = size;
  const alignRight = bubble.x + WINDOW_BUBBLE_SIZE_PX - width;
  const x = alignRight >= bounds.left ? alignRight : bubble.x;
  const below = bubble.y + WINDOW_BUBBLE_SIZE_PX + BUBBLE_WINDOW_GAP_PX;
  const y = below + height <= bounds.bottom ? below : bubble.y - BUBBLE_WINDOW_GAP_PX - height;
  return clampWindowGeometry({ x, y, width, height }, bounds, limits);
}
