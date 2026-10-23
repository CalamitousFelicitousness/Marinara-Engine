// Drives the actual shared player: independent ownership, autoplay retry teardown,
// late completion and permanent disposal must not stop the reusable Game singleton.
import assert from "node:assert/strict";

const listeners = new Map<string, Set<() => void>>();
const elements: AudioStub[] = [];
class AudioStub {
  preload = "";
  muted = false;
  volume = 1;
  loop = false;
  src: string;
  currentTime = 0;
  paused = true;
  onerror: (() => void) | null = null;
  onended: (() => void) | null = null;
  constructor(src = "") {
    this.src = src;
    elements.push(this);
  }
  play() {
    if (this.src.includes("blocked")) return Promise.reject(new DOMException("Gesture required", "NotAllowedError"));
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {}
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  addEventListener() {}
  removeEventListener() {}
}
const windowStub: { AudioContext?: unknown } = {};
Object.assign(globalThis, {
  Audio: AudioStub,
  window: windowStub,
  document: {
    addEventListener(event: string, handler: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    removeEventListener(event: string, handler: () => void) {
      listeners.get(event)?.delete(handler);
    },
  },
});
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const listenerCount = () => [...listeners.values()].reduce((count, set) => count + set.size, 0);
const gesture = () => {
  for (const handler of [...(listeners.get("click") ?? [])]) handler();
};
const active = (suffix: string) => elements.filter((element) => element.src.endsWith(suffix) && !element.paused);
const assets = { first: { path: "music/first.mp3" }, second: { path: "music/second.mp3" } };
const { createAudioPlayer, audioManager } = await import("../../packages/client/src/lib/game-audio.js");
const { selectDefaultMusic } = await import("../../packages/client/src/lib/audio-service.js");

const baseline = listenerCount();
const first = createAudioPlayer();
const second = createAudioPlayer();
assert.equal(listenerCount(), baseline + 8);
first.playMusic("first", assets);
first.dispose();
first.dispose();
assert.equal(listenerCount(), baseline + 4, "unmount before the first gesture removes only the owner's listeners");
second.playMusic("second", assets);
gesture();
await tick();
assert.equal(active("first.mp3").length, 0, "disposed pending music cannot revive on a later gesture");
assert.equal(active("second.mp3").length, 1);
audioManager.playMusic("first", assets);
await tick();
assert.equal(active("first.mp3").length, 1);
second.setVolumes({ music: 0.2, sfx: 0.3 });
second.setMuted(true);
assert.equal(active("second.mp3")[0]!.muted, true);
assert.equal(active("first.mp3")[0]!.muted, false, "package mute does not mutate Game playback");
assert.equal(audioManager.getState().musicVolume, 0.5);
second.dispose();
assert.equal(active("second.mp3").length, 0);
assert.equal(active("first.mp3").length, 1, "package disposal does not stop Game");

const afterGesture = createAudioPlayer();
assert.equal(listenerCount(), 0, "a new package inherits an already-observed page gesture");
afterGesture.playMusic("second", assets);
await tick();
assert.equal(active("second.mp3").length, 1);
afterGesture.dispose();
afterGesture.unlock();
afterGesture.playMusic("second", assets);
afterGesture.playSfx("second", assets);
afterGesture.setVolumes({ music: 1, sfx: 1 });
afterGesture.setMuted(false);
await tick();
assert.equal(active("second.mp3").length, 0, "every disposed facade remains inert");

const blocked = createAudioPlayer();
blocked.playMusic("blocked", { blocked: { path: "music/blocked.mp3" } });
await tick();
assert.equal(listenerCount(), 4, "autoplay refusal registers an owned retry");
blocked.dispose();
assert.equal(listenerCount(), 0, "permanent teardown removes autoplay retry listeners too");
gesture();
assert.equal(listenerCount(), 0);

const late = createAudioPlayer();
late.playMusic("second", assets);
late.dispose();
await tick();
assert.equal(active("second.mp3").length, 0, "late readiness cannot restart a disposed player");

let closed = 0;
let sourcesStarted = 0;
const originalFetch = globalThis.fetch;
let finishFetch!: (response: Response) => void;
globalThis.fetch = () =>
  new Promise<Response>((resolve) => {
    finishFetch = resolve;
  });
windowStub.AudioContext = class {
  state = "running";
  sampleRate = 48_000;
  destination = {};
  createBuffer() {
    return {};
  }
  createBufferSource() {
    return {
      buffer: null,
      connect() {},
      start() {
        sourcesStarted++;
      },
    };
  }
  decodeAudioData() {
    return Promise.resolve({});
  }
  close() {
    closed++;
    return Promise.resolve();
  }
};
const ownsContext = createAudioPlayer();
ownsContext.unlock();
assert.equal(sourcesStarted, 1, "the unlock pulse uses this player's own context");
ownsContext.playMusic("second", assets);
ownsContext.dispose();
ownsContext.dispose();
assert.equal(closed, 1, "each package releases its own AudioContext exactly once");
finishFetch(new Response(new Uint8Array([0])));
await tick();
assert.equal(sourcesStarted, 1, "a late decoded track cannot start after permanent context teardown");
globalThis.fetch = originalFetch;
delete windowStub.AudioContext;

audioManager.dispose();
audioManager.playMusic("first", assets);
await tick();
assert.equal(active("first.mp3").length, 1, "Game's existing dispose remains reusable after chat switches");
audioManager.dispose();

const stockTags = [
  "music:dialogue:slice_of_life:calm:town",
  "music:travel_rest:fantasy:calm:inn",
  "music:exploration:fantasy:calm:field",
  "music:combat:fantasy:intense:battle",
  "music:exploration:horror:tense:forest",
];
const manifest = {
  scannedAt: "fixture",
  count: 7,
  byCategory: {},
  assets: Object.fromEntries(
    [...stockTags, "music:area:other-chat:secret", "music:tier:boss:other-chat"].map((tag) => [
      tag,
      { tag, category: "music", subcategory: "", name: tag, path: `${tag}.mp3`, ext: ".mp3" },
    ]),
  ),
};
for (const cue of ["home", "combat", "boss", "happy", "tense", "sad", "bond"] as const) {
  const tag = selectDefaultMusic(cue, manifest);
  assert(tag && stockTags.includes(tag), `${cue} selects an existing stock-state tag`);
  assert.equal(selectDefaultMusic(cue, manifest, { currentTag: tag }), tag, "unchanged cues keep fitting music");
}
assert.equal(selectDefaultMusic("home", { ...manifest, assets: {} }), null);
assert.equal(
  selectDefaultMusic("home", {
    ...manifest,
    assets: { foreign: manifest.assets["music:area:other-chat:secret"]! },
  }),
  null,
  "another Game's generated context is never a default",
);
console.log("Package audio ownership, gesture lifecycle, permanent disposal and stock selection passed.");
