// #7036: shared floating windows keep a valid, on-screen layout and a stable theming contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FLOATING_WINDOW_LAYOUT_VERSION,
  clampWindowGeometry,
  moveWindowGeometry,
  parseWindowLayoutSnapshot,
  resizeWindowGeometry,
  toWindowLayoutSnapshot,
} from "../../packages/client/src/lib/floating-window-layout.js";
import {
  CHAT_SETTINGS_WINDOW_ID,
  takeFloatingWindowFocusRequest,
  useFloatingWindowStore,
} from "../../packages/client/src/stores/floating-window.store.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(join(repositoryRoot, path), "utf8");

// ── Geometry stays inside the bounds ──
const bounds = { left: 8, top: 56, right: 1432, bottom: 892 };
const limits = { minWidth: 320, minHeight: 240 };
assert.deepEqual(clampWindowGeometry({ x: 100, y: 100, width: 500, height: 400 }, bounds, limits), {
  x: 100,
  y: 100,
  width: 500,
  height: 400,
});
assert.deepEqual(clampWindowGeometry({ x: 5000, y: -50, width: 500, height: 400 }, bounds, limits), {
  x: 932,
  y: 56,
  width: 500,
  height: 400,
});
assert.deepEqual(
  clampWindowGeometry({ x: Number.NaN, y: Number.POSITIVE_INFINITY, width: 99999, height: 10 }, bounds, limits),
  { x: 8, y: 56, width: 1424, height: 240 },
  "non-finite positions fall back into view and sizes respect the limits",
);
assert.deepEqual(
  clampWindowGeometry(
    { x: 300, y: 300, width: 500, height: 400 },
    { left: 8, top: 56, right: 200, bottom: 150 },
    limits,
  ),
  { x: 8, y: 56, width: 320, height: 240 },
  "a viewport smaller than the minimum keeps the title bar at the top-left corner",
);
assert.deepEqual(moveWindowGeometry({ x: 100, y: 100, width: 500, height: 400 }, -500, 2000, bounds, limits), {
  x: 8,
  y: 492,
  width: 500,
  height: 400,
});

// Resizing moves only the dragged edges.
const start = { x: 400, y: 200, width: 500, height: 400 };
assert.deepEqual(resizeWindowGeometry(start, "se", 40, -60, bounds, limits), { ...start, width: 540, height: 340 });
assert.deepEqual(resizeWindowGeometry(start, "w", -50, 0, bounds, limits), { ...start, x: 350, width: 550 });
assert.deepEqual(resizeWindowGeometry(start, "n", 0, 1000, bounds, limits), { ...start, y: 360, height: 240 });
assert.deepEqual(resizeWindowGeometry(start, "nw", -1000, -1000, bounds, limits), {
  x: 8,
  y: 56,
  width: 892,
  height: 544,
});
assert.deepEqual(resizeWindowGeometry(start, "e", 5000, 0, bounds, limits), { ...start, width: 1032 });

// ── Stored layouts survive old, missing and corrupt values ──
const valid = { x: 10, y: 20, width: 400, height: 300, pinned: true, locked: false };
assert.deepEqual(parseWindowLayoutSnapshot(undefined).windows, {});
assert.deepEqual(parseWindowLayoutSnapshot("not json").windows, {});
assert.deepEqual(parseWindowLayoutSnapshot([valid]).windows, {});
assert.deepEqual(parseWindowLayoutSnapshot({ version: 0, windows: { a: valid } }).windows, {}, "older versions reset");
assert.deepEqual(parseWindowLayoutSnapshot({ version: FLOATING_WINDOW_LAYOUT_VERSION, windows: [] }).windows, {});
assert.deepEqual(
  parseWindowLayoutSnapshot({
    version: FLOATING_WINDOW_LAYOUT_VERSION,
    windows: {
      good: valid,
      nan: { ...valid, x: Number.NaN },
      text: { ...valid, y: "20" },
      empty: { ...valid, width: 0 },
      huge: { ...valid, height: 1e9 },
      flag: { ...valid, pinned: "yes" },
      missing: { x: 1, y: 2, width: 300, height: 300 },
      [""]: valid,
      ["x".repeat(500)]: valid,
    },
  }).windows,
  { good: valid },
);
assert.deepEqual(parseWindowLayoutSnapshot(JSON.parse(JSON.stringify(toWindowLayoutSnapshot({ good: valid })))), {
  version: FLOATING_WINDOW_LAYOUT_VERSION,
  windows: { good: valid },
});

// ── Store: open state, hosts, pinning and Reset View ──
const store = useFloatingWindowStore;
const id = CHAT_SETTINGS_WINDOW_ID;
const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));
store.getState().openWindow(id);
store.getState().openWindow("other");
assert.deepEqual(store.getState().stack, [id, "other"]);
assert.equal(takeFloatingWindowFocusRequest(id), true, "opening a window asks it to take focus");
assert.equal(takeFloatingWindowFocusRequest(id), false, "only once, so a remount leaves focus alone");
store.getState().openWindow(id);
assert.equal(takeFloatingWindowFocusRequest(id), false, "reopening an open window does not move focus");
store.getState().bringToFront(id);
assert.deepEqual(store.getState().stack, ["other", id], "the last pressed window is in front");
store.getState().toggleWindow("other");
assert.equal(store.getState().open.other, undefined);

let release = store.getState().registerHost(id);
release();
release = store.getState().registerHost(id);
await flushMicrotasks();
assert.equal(store.getState().open[id], true, "a host that re-registers straight away keeps the window open");
release();
await flushMicrotasks();
assert.equal(store.getState().open[id], undefined, "an unpinned window closes with its last host");

store.getState().saveLayout(id, valid);
store.getState().openWindow(id);
release = store.getState().registerHost(id);
release();
await flushMicrotasks();
assert.equal(store.getState().open[id], true, "a pinned window waits for a host to come back");

const revision = store.getState().resetRevision;
store.getState().resetView();
assert.deepEqual(store.getState().layouts, {});
assert.equal(store.getState().resetRevision, revision + 1);
store
  .getState()
  .hydrate({ version: FLOATING_WINDOW_LAYOUT_VERSION, windows: { [id]: valid, bad: { ...valid, x: "?" } } } as never);
assert.deepEqual(store.getState().layouts, { [id]: valid });

// Other panels dismiss an unpinned window only; its own close button forces it shut.
store.getState().openWindow(id);
assert.equal(store.getState().dismissWindow(id), false, "a pinned window stays when another panel opens");
assert.equal(store.getState().open[id], true);
assert.equal(store.getState().dismissWindow(id, { force: true }), true);
assert.equal(store.getState().open[id], undefined);
store.getState().resetView();
store.getState().openWindow(id);
assert.equal(store.getState().dismissWindow(id), true, "an unpinned window closes");
assert.equal(store.getState().dismissWindow(id), false, "a closed window has nothing to close");

// ── Theming contract: stable classes, attributes and variables ──
const floatingWindow = read("packages/client/src/components/ui/FloatingWindow.tsx");
const drawer = read("packages/client/src/components/ui/Drawer.tsx");
const globals = read("packages/client/src/styles/globals.css");
for (const part of [
  "mari-window ",
  "mari-window__header",
  "mari-window__title",
  "mari-window__controls",
  "mari-window__body",
  "mari-window__resize-handle",
]) {
  assert.ok(floatingWindow.includes(part), `FloatingWindow must render ${part.trim()}`);
}
for (const attribute of ["data-window={id}", "data-pinned=", "data-locked=", "data-detached="]) {
  assert.ok(floatingWindow.includes(attribute), `FloatingWindow must expose ${attribute}`);
}
for (const part of ['"mari-drawer"', "mari-drawer__header", "mari-drawer__title", "mari-drawer__body"]) {
  assert.ok(drawer.includes(part), `Drawer must render ${part}`);
}
for (const attribute of ["data-drawer={id}", "data-detached="]) assert.ok(drawer.includes(attribute));
const variables = [...globals.matchAll(/^\s+(--mari-(?:window|drawer)-[a-z-]+)\s/gmu)].map((match) => match[1]!);
assert.ok(variables.length >= 30, "globals.css must document the window and drawer variables");
for (const variable of variables) {
  assert.match(globals, new RegExp(`var\\(${variable},`, "u"), `${variable} must be read with a theme-token fallback`);
}
assert.match(
  globals,
  /\[data-marinara-chat-chrome-accent-mode="gradient"\] \.marinara-chat-popover:not\(\.mari-window\)/u,
  "gradient chrome must not override the window variables",
);
assert.match(
  globals,
  /@layer components \{\s*\.mari-window \{[\s\S]*?\.mari-drawer__body \{[^}]*\}\s*\}/u,
  "window and drawer defaults sit in the components layer, so classes passed to them win",
);

// Chat Settings renders through the shared window and its sections through the shared drawer.
assert.match(read("packages/client/src/components/chat/ChatSettingsDrawer.tsx"), /<FloatingWindow\b/u);
assert.match(read("packages/client/src/components/chat/ChatCommonOverlays.tsx"), /<FloatingWindow\b/u);
assert.match(read("packages/client/src/features/chat-settings/ChatSettingsSection.tsx"), /<Drawer\b/u);
assert.match(
  read("packages/client/src/features/chat-settings/sections/AdvancedParametersSection.tsx"),
  /<Drawer\b[\s\S]*?id="advanced-parameters"/u,
  "Advanced Parameters is a shared drawer too",
);
// Grids inside the window follow its width, not the screen's: a narrow window must not squeeze four columns.
assert.match(
  read("packages/client/src/components/chat/ChatSettingsDrawer.tsx"),
  /<GameWidgetSetupEditor\b(?:(?!\/>)[\s\S])*?\bcontainerQueries\b/u,
);
assert.match(
  read("packages/client/src/components/game/GameWidgetSetupEditor.tsx"),
  /containerQueries\s*\?\s*"@lg:grid-cols-\[3\.25rem_minmax\(0,1fr\)_9rem_auto\]/u,
);

// Hosted multiplayer: Players opens Chat Settings at its Multiplayer section; the next open starts at the top.
assert.match(
  read("packages/client/src/features/multiplayer/MultiplayerChat.tsx"),
  /useEffect\(\(\) => \{\s*if \(!settingsOpen\) setInitialSection\(null\);\s*\}, \[settingsOpen\]\);/u,
);

console.log("floating window regression passed");
