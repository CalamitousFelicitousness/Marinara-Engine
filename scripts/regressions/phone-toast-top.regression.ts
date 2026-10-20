import assert from "node:assert/strict";
import {
  phoneToastTop,
  PHONE_TOAST_TOP_VARIABLE,
  watchPhoneToastTop,
} from "../../packages/client/src/lib/phone-toast-top.js";

// Execute the real placement and watcher with layout/observer stubs. Header changes must move a
// lingering toast before the next paint, without a polling delay or idle work after dismissal.
let measurements = 0;
function header(top: number, bottom: number, left = 0, right = 390, visibility = "visible") {
  const rect = { top, bottom, left, right, width: right - left, height: bottom - top };
  return {
    rect,
    visibility,
    getBoundingClientRect() {
      measurements += 1;
      return rect;
    },
  };
}

type Header = ReturnType<typeof header>;
const topBar = header(0, 48);
const windowHeader = header(100, 150);
const bubbleRow = header(56, 96);
let rows: Header[] = [windowHeader, bubbleRow];
const tacticalToolbar = header(48, 144);
let topObstacles: Header[] = [];
let hasTopBar = true;
let showing = false;
const body = {};
const toast = {};
const styles = new Map<string, string>();
const host = {
  querySelector: () => (showing ? toast : null),
  contains: (node: unknown) => node === host || node === toast,
  style: {
    getPropertyValue: (name: string) => styles.get(name) ?? "",
    setProperty: (name: string, value: string) => styles.set(name, value),
    removeProperty: (name: string) => styles.delete(name),
  },
};
const resizeListeners = new Set<() => void>();
const mutations: MutationStub[] = [];
class MutationStub {
  target: unknown;
  options?: MutationObserverInit;
  constructor(private callback: MutationCallback) {
    mutations.push(this);
  }
  observe(target: unknown, options: MutationObserverInit) {
    this.target = target;
    this.options = options;
  }
  disconnect() {
    this.target = undefined;
  }
  notify(target: unknown) {
    assert.ok(this.target, "only an active observer receives layout changes");
    this.callback([{ target } as MutationRecord], this as unknown as MutationObserver);
  }
}
const resizes: ResizeStub[] = [];
class ResizeStub {
  observed = new Set<unknown>();
  constructor(private callback: ResizeObserverCallback) {
    resizes.push(this);
  }
  observe(element: unknown) {
    this.observed.add(element);
  }
  unobserve(element: unknown) {
    this.observed.delete(element);
  }
  disconnect() {
    this.observed.clear();
  }
  notify() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

Object.defineProperties(globalThis, {
  document: {
    configurable: true,
    value: {
      body,
      querySelector: () => (hasTopBar ? topBar : null),
      querySelectorAll: (selector: string) => [
        ...(selector.includes("TopBar") && hasTopBar ? [topBar] : []),
        ...rows,
        ...(selector.includes("[data-chat-window-top-obstacle]") ? topObstacles : []),
      ],
    },
  },
  window: {
    configurable: true,
    value: {
      innerWidth: 390,
      innerHeight: 844,
      addEventListener: (name: string, listener: () => void) => {
        assert.equal(name, "resize");
        resizeListeners.add(listener);
      },
      removeEventListener: (name: string, listener: () => void) => {
        assert.equal(name, "resize");
        resizeListeners.delete(listener);
      },
    },
  },
  getComputedStyle: { configurable: true, value: (element: Header) => ({ visibility: element.visibility }) },
  MutationObserver: { configurable: true, value: MutationStub },
  ResizeObserver: { configurable: true, value: ResizeStub },
});

assert.equal(phoneToastTop(), 158, "headers stack in screen order, independent of DOM order");
rows.push(
  header(140, 400, 0, 390, "hidden"),
  header(140, 400, 0, 390, "collapse"),
  header(140, 400, -100, -10),
  header(140, 400, 400, 500),
  header(-100, -20),
  header(860, 900),
  header(140, 140),
  header(140, 400, 0, 0),
);
assert.equal(phoneToastTop(), 158, "hidden and offscreen headers cannot push a toast offscreen");
rows = [windowHeader, bubbleRow, header(300, 340)];
assert.equal(phoneToastTop(), 158, "a bubble moved away from the top does not extend the header stack");
rows = [];
topObstacles = [tacticalToolbar];
assert.equal(phoneToastTop(), 152, "a measured tactical toolbar extends the top header stack");
tacticalToolbar.rect.bottom = 184;
tacticalToolbar.rect.height = 136;
assert.equal(phoneToastTop(), 192, "wrapped toolbar rows keep top toasts below their controls");
topObstacles = [];
assert.equal(phoneToastTop(), 56, "an empty shell clears the top bar");
hasTopBar = false;
assert.equal(phoneToastTop(), 8, "missing shell elements are safe during a view transition");
hasTopBar = true;
rows = [windowHeader, bubbleRow];

const cleanup = watchPhoneToastTop(host as unknown as HTMLElement);
const hostObserver = mutations.find((observer) => observer.target === host)!;
const layoutObserver = mutations.find((observer) => observer !== hostObserver)!;
const resizeObserver = resizes[0]!;
assert.ok(hostObserver);
assert.equal(layoutObserver.target, undefined, "the app is not observed while no toast exists");
assert.equal(resizeObserver.observed.size, 0);
assert.equal(resizeListeners.size, 0);

showing = true;
hostObserver.notify(host);
assert.equal(styles.get(PHONE_TOAST_TOP_VARIABLE), "158px", "a new toast clears current headers immediately");
assert.equal(layoutObserver.target, body);
assert.ok(layoutObserver.options?.subtree && layoutObserver.options.childList);
assert.ok(layoutObserver.options?.attributeFilter?.includes("data-chat-covered"));
assert.equal(resizeListeners.size, 1);
assert.ok(resizeObserver.observed.has(topBar));

const editor = header(56, 210);
rows.push(editor);
layoutObserver.notify(body);
assert.equal(styles.get(PHONE_TOAST_TOP_VARIABLE), "218px", "opening an editor moves a lingering toast synchronously");
assert.ok(resizeObserver.observed.has(editor), "new headers are observed for later size changes");

editor.rect.bottom = 240;
editor.rect.height = 184;
resizeObserver.notify();
assert.equal(styles.get(PHONE_TOAST_TOP_VARIABLE), "248px", "font and header size changes keep controls clear");
editor.visibility = "hidden";
layoutObserver.notify(editor);
assert.equal(styles.get(PHONE_TOAST_TOP_VARIABLE), "158px", "a covered chat header stops reserving space");

const beforeToastMutation = measurements;
layoutObserver.notify(toast);
assert.equal(measurements, beforeToastMutation, "toast animation does not repeatedly measure the app");
rows = [];
layoutObserver.notify(body);
assert.deepEqual([...resizeObserver.observed], [topBar], "removed headers release their observers");
topBar.rect.bottom = 60;
for (const listener of resizeListeners) listener();
assert.equal(styles.get(PHONE_TOAST_TOP_VARIABLE), "68px", "viewport changes remeasure the shell");

showing = false;
hostObserver.notify(host);
assert.equal(layoutObserver.target, undefined);
assert.equal(resizeObserver.observed.size, 0);
assert.equal(resizeListeners.size, 0);
assert.equal(styles.has(PHONE_TOAST_TOP_VARIABLE), false, "dismissal leaves no offset or active layout work");

showing = true;
hostObserver.notify(host);
assert.equal(styles.get(PHONE_TOAST_TOP_VARIABLE), "68px", "a later toast restarts observation");
cleanup();
assert.equal(hostObserver.target, undefined);
assert.equal(layoutObserver.target, undefined);
assert.equal(resizeObserver.observed.size, 0);
assert.equal(resizeListeners.size, 0);
assert.equal(styles.has(PHONE_TOAST_TOP_VARIABLE), false, "unmount removes the offset and every observer");
