// ──────────────────────────────────────────────
// Store: floating windows (open state, z-order, remembered layout)
//
// Every window built on <FloatingWindow> shares this store, keyed by window id.
// Open state, hosts and stacking order are runtime only; the layout (geometry,
// pinned, locked) is remembered.
// ──────────────────────────────────────────────
import { create } from "zustand";
import {
  FLOATING_WINDOW_STORAGE_KEY,
  parseWindowLayoutSnapshot,
  toWindowLayoutSnapshot,
  type FloatingWindowId,
  type WindowLayout,
  type WindowLayoutSnapshot,
} from "../lib/floating-window-layout";

export const CHAT_SETTINGS_WINDOW_ID = "chat-settings";
export const TRACKER_WINDOW_ID = "trackers";
/** Above the chat HUD (z-40/50), below menus (9000+), modals (10000) and the Help overlay (10050). */
export const FLOATING_WINDOW_Z_BASE = 70;

interface FloatingWindowState {
  /** Remembered layouts; only windows the user moved, resized, pinned or locked. */
  layouts: Record<FloatingWindowId, WindowLayout>;
  open: Record<FloatingWindowId, true>;
  /** How many mounted surfaces can show each window (the topbar button needs one). */
  hosts: Record<FloatingWindowId, number>;
  /** Stacking order: the last id is in front. */
  stack: FloatingWindowId[];
  /** Bumped by Reset View so open windows recompute their default layout. */
  resetRevision: number;
  /** `focus: false` shows a window without moving focus into it (one the app opens by itself). */
  openWindow: (id: FloatingWindowId, opener?: HTMLElement | null, options?: { focus?: boolean }) => void;
  closeWindow: (id: FloatingWindowId) => void;
  /** Closes a window unless it is pinned (`force` closes it anyway). Returns whether it closed. */
  dismissWindow: (id: FloatingWindowId, options?: { force?: boolean }) => boolean;
  toggleWindow: (id: FloatingWindowId, opener?: HTMLElement | null) => void;
  registerHost: (id: FloatingWindowId) => () => void;
  bringToFront: (id: FloatingWindowId) => void;
  saveLayout: (id: FloatingWindowId, layout: WindowLayout) => void;
  resetView: () => void;
  hydrate: (snapshot: WindowLayoutSnapshot) => void;
}

// ponytail: layouts are device-wide in localStorage until phase 4 moves them into
// chat.metadata.windowLayout through a hook (hydrate + a debounced useUpdateChatMetadata).
// Chat settings profiles then carry them, because profiles copy non-excluded chat metadata.
function readStoredLayouts(): Record<FloatingWindowId, WindowLayout> {
  try {
    const raw = window.localStorage.getItem(FLOATING_WINDOW_STORAGE_KEY);
    return raw ? parseWindowLayoutSnapshot(JSON.parse(raw)).windows : {};
  } catch {
    return {};
  }
}

function writeStoredLayouts(layouts: Record<FloatingWindowId, WindowLayout>) {
  try {
    if (Object.keys(layouts).length === 0) window.localStorage.removeItem(FLOATING_WINDOW_STORAGE_KEY);
    else window.localStorage.setItem(FLOATING_WINDOW_STORAGE_KEY, JSON.stringify(toWindowLayoutSnapshot(layouts)));
  } catch {
    // Private windows and blocked storage keep the layout for this session only.
  }
}

// The element that opened each window, so closing it can return focus there.
const openers = new Map<FloatingWindowId, HTMLElement>();
// Windows the user just opened; a window that only remounts (a chat switch) leaves focus alone.
const focusRequests = new Set<FloatingWindowId>();

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

export const useFloatingWindowStore = create<FloatingWindowState>()((set, get) => ({
  layouts: typeof window === "undefined" ? {} : readStoredLayouts(),
  open: {},
  hosts: {},
  stack: [],
  resetRevision: 0,
  openWindow: (id, opener, options) => {
    if (opener) openers.set(id, opener);
    if (!get().open[id] && options?.focus !== false) focusRequests.add(id);
    set((state) => ({
      open: state.open[id] ? state.open : { ...state.open, [id]: true },
      stack: [...state.stack.filter((entry) => entry !== id), id],
    }));
  },
  closeWindow: (id) =>
    set((state) => ({
      open: withoutKey(state.open, id),
      stack: state.stack.filter((entry) => entry !== id),
    })),
  dismissWindow: (id, options) => {
    if (!get().open[id] || (!options?.force && isFloatingWindowPinned(id))) return false;
    get().closeWindow(id);
    return true;
  },
  toggleWindow: (id, opener) => {
    if (get().open[id]) get().closeWindow(id);
    else get().openWindow(id, opener);
  },
  registerHost: (id) => {
    set((state) => ({ hosts: { ...state.hosts, [id]: (state.hosts[id] ?? 0) + 1 } }));
    return () => {
      set((state) => {
        const count = Math.max(0, (state.hosts[id] ?? 0) - 1);
        return { hosts: count === 0 ? withoutKey(state.hosts, id) : { ...state.hosts, [id]: count } };
      });
      // Nothing can show an unpinned window once its last host is gone. Checked a tick later, so a
      // host that re-registers straight away (a chat switch, React's development double mount) keeps it.
      queueMicrotask(() => {
        const state = get();
        if (!state.hosts[id] && state.open[id] && !isFloatingWindowPinned(id)) state.closeWindow(id);
      });
    };
  },
  bringToFront: (id) =>
    set((state) =>
      state.stack.at(-1) === id || !state.stack.includes(id)
        ? state
        : { stack: [...state.stack.filter((entry) => entry !== id), id] },
    ),
  saveLayout: (id, layout) => set((state) => ({ layouts: { ...state.layouts, [id]: layout } })),
  resetView: () => set((state) => ({ layouts: {}, resetRevision: state.resetRevision + 1 })),
  hydrate: (snapshot) => set({ layouts: parseWindowLayoutSnapshot(snapshot).windows }),
}));

if (typeof window !== "undefined") {
  useFloatingWindowStore.subscribe((state, previous) => {
    if (state.layouts !== previous.layouts) writeStoredLayouts(state.layouts);
  });
}

/** Pinned windows ignore outside presses and other panels. Phones show windows as sheets, which never pin. */
export function isFloatingWindowPinned(id: FloatingWindowId): boolean {
  if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 767px)").matches) return false;
  return useFloatingWindowStore.getState().layouts[id]?.pinned === true;
}

/** True once after a window is opened, so it takes focus then and not on later remounts. */
export function takeFloatingWindowFocusRequest(id: FloatingWindowId): boolean {
  return focusRequests.delete(id);
}

/** Returns (and forgets) the element that opened a window, while it is still on the page. */
export function takeFloatingWindowOpener(id: FloatingWindowId): HTMLElement | null {
  const opener = openers.get(id) ?? null;
  openers.delete(id);
  return opener?.isConnected ? opener : null;
}
