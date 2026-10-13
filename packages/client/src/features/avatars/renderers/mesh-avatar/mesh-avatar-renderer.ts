// ──────────────────────────────────────────────
// Avatar renderer: mesh-avatar `.mavatar` (lane: 2D)
// ──────────────────────────────────────────────
// Thin adapter over npm "mesh-avatar" 0.1.1 (MIT, pure JS WebGL2, pinned exactly): created with
// `manual: true` and driven with advance() from update(), so the stage's loop sets the frame rate.
// Emotions map to setEmotion() (or a live expression), visemes to holdMouth(), loudness to setVoiceLevel().
//
// Every mesh avatar draws through one shared, detached WebGL2 canvas (AVATAR_RENDER_BUDGET allows one
// context per kind) and is copied onto its own canvas right after drawing, in the same task, so the
// context needs no preserveDrawingBuffer. Without WebGL2, when the file cannot be played, or when the
// context is lost, the avatar falls back to the PNGTuber renderer with the owner's sprites.
import { loadMeshAvatar, type MeshAvatar } from "mesh-avatar";
import { avatarModelFilePath, type AvatarEmotion, type AvatarFrameInput } from "@marinara-engine/shared";
import { api } from "../../../../lib/api-client";
import type { AvatarRenderer, AvatarRendererMountOptions } from "../../contract";
import { meshAvatarFace, meshAvatarMouth, meshAvatarOverrides } from "./mesh-avatar-face";

/** The first getContext call fixes these; mesh-avatar's own later call gets the same context back. */
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: true,
  preserveDrawingBuffer: false,
};

interface SharedContext {
  canvas: HTMLCanvasElement;
  context: WebGL2RenderingContext;
  /** Device pixels the next draw renders at (the avatar drawing now). */
  size: { width: number; height: number };
  /** Called when the context is lost; one per mounted avatar. */
  users: Set<() => void>;
}

let sharedContext: SharedContext | null = null;

function acquireSharedContext(onLost: () => void): SharedContext | null {
  if (!sharedContext) {
    const canvas = document.createElement("canvas");
    const size = { width: 1, height: 1 };
    // ponytail: mesh-avatar 0.1.1 sizes its canvas on every draw from clientWidth/clientHeight times
    // min(devicePixelRatio, 2). A detached canvas has no layout, so these getters give it the pixel size of
    // the avatar being drawn, which already holds the budget's DPR cap. Upgrade path: an explicit size
    // option in mesh-avatar (the version is pinned exactly, so this cannot drift unnoticed).
    const libraryRatio = () => Math.min(window.devicePixelRatio || 1, 2);
    Object.defineProperty(canvas, "clientWidth", { get: () => size.width / libraryRatio() });
    Object.defineProperty(canvas, "clientHeight", { get: () => size.height / libraryRatio() });
    const context = canvas.getContext("webgl2", CONTEXT_ATTRIBUTES);
    if (!context) return null;
    const shared: SharedContext = { canvas, context, size, users: new Set() };
    canvas.addEventListener("webglcontextlost", () => {
      if (sharedContext === shared) sharedContext = null;
      const users = [...shared.users];
      shared.users.clear();
      for (const notify of users) notify();
    });
    sharedContext = shared;
  }
  sharedContext.users.add(onLost);
  return sharedContext;
}

function releaseSharedContext(shared: SharedContext, onLost: () => void) {
  shared.users.delete(onLost);
  if (shared.users.size > 0 || sharedContext !== shared) return;
  sharedContext = null;
  // Free the GPU memory now rather than when the garbage collector finds the canvas.
  shared.context.getExtension("WEBGL_lose_context")?.loseContext();
}

export function createAvatarRenderer(): AvatarRenderer {
  let options: AvatarRendererMountOptions | null = null;
  let shared: SharedContext | null = null;
  let avatar: MeshAvatar | null = null;
  let copy: CanvasRenderingContext2D | null = null;
  let fallback: AvatarRenderer | null = null;
  let fallingBack = false;
  let disposed = false;
  let paused = false;
  let lastSize: [number, number, number] | null = null;
  const pixels = { width: 1, height: 1 };

  let face = { emotion: "" as AvatarEmotion | "", expression: "" };
  let mouthMode = "";
  let heldVowel = "";
  let speaking = false;
  let overridesKey = "";

  const onLost = () => void showSprites("the WebGL context was lost");

  function teardown() {
    avatar?.destroy();
    avatar = null;
    if (shared) releaseSharedContext(shared, onLost);
    shared = null;
  }

  /** Shows the owner's PNGTuber setup (or sprites) on the same canvas instead. */
  async function showSprites(reason: string, error?: unknown) {
    if (fallingBack || disposed || !options) return;
    fallingBack = true;
    teardown();
    console.warn(`[avatars] Showing sprites instead of the mesh avatar: ${reason}`, error ?? "");
    const mounted = options;
    const { createAvatarRenderer: createSpriteRenderer } = await import("../pngtuber/pngtuber-renderer");
    if (disposed) return;
    const next = createSpriteRenderer();
    await next.mount(mounted);
    if (disposed) {
      next.dispose();
      return;
    }
    if (lastSize) next.resize(...lastSize);
    next.setPaused(paused);
    fallback = next;
  }

  function applyFrame(target: MeshAvatar, frame: AvatarFrameInput, mounted: AvatarRendererMountOptions) {
    const config = mounted.config;
    const expressionMap = config.kinds["mesh-avatar"]?.expressionMap ?? {};
    const still = mounted.reducedMotion || !config.features.idleMotion;

    const nextFace = meshAvatarFace(expressionMap, frame);
    const faceChanged = nextFace.emotion !== face.emotion || nextFace.expression !== face.expression;

    const mouth = meshAvatarMouth(expressionMap, frame, config.features.lipSync);
    const nextSpeaking = mouth.mode !== "off" && (frame.state === "talking" || frame.mouthOpen > 0.05);
    if (mouth.mode !== mouthMode) {
      if (mouthMode === "hold" || mouth.mode === "off") target.stopLipSync();
      mouthMode = mouth.mode;
      heldVowel = "";
    }
    if (mouth.mode === "hold") {
      if (mouth.vowel !== heldVowel) target.holdMouth(mouth.vowel as Parameters<MeshAvatar["holdMouth"]>[0]);
      heldVowel = mouth.vowel;
      // The level still drives the talking nod.
      target.setVoiceLevel(frame.mouthOpen);
    } else {
      target.setVoiceLevel(mouth.mode === "voice" ? mouth.level : 0);
    }
    const stoppedSpeaking = speaking && !nextSpeaking;
    if (nextSpeaking !== speaking) {
      target.setSpeaking(nextSpeaking);
      speaking = nextSpeaking;
    }
    // The runtime drops the emotion a second after speech ends (one emotion per spoken line); the director's
    // face should stay, so it is set again when speaking stops, after setSpeaking(false).
    if (faceChanged || stoppedSpeaking) {
      target.setEmotion(nextFace.emotion, { playMotion: faceChanged && !still });
      target.setExpression(nextFace.expression as Parameters<MeshAvatar["setExpression"]>[0]);
    }
    face = nextFace;

    const overrides = meshAvatarOverrides(frame, { still, blink: config.features.blink });
    const key = JSON.stringify(overrides);
    if (key !== overridesKey) {
      target.setParameters(overrides, 1);
      overridesKey = key;
    }
  }

  return {
    kind: "mesh-avatar",

    async mount(mountOptions) {
      options = mountOptions;
      const data = mountOptions.config.kinds["mesh-avatar"];
      if (!data) return showSprites("this owner has no mesh avatar");
      copy = mountOptions.canvas.getContext("2d");
      shared = acquireSharedContext(onLost);
      if (!shared || !copy) return showSprites("WebGL2 is not available");
      try {
        const response = await api.raw(avatarModelFilePath(mountOptions.owner, data.file), {
          signal: mountOptions.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (disposed || mountOptions.signal.aborted || !shared) return;
        const created = await loadMeshAvatar(shared.canvas, bytes, { manual: true });
        if (disposed || mountOptions.signal.aborted || !shared) {
          created.destroy();
          return;
        }
        const still = mountOptions.reducedMotion || !mountOptions.config.features.idleMotion;
        created.setAutoIdle(!still);
        created.setAutoMotion(!still);
        created.setSwayGain(still ? 0 : 1);
        created.setTalkGain(mountOptions.reducedMotion ? 0 : 1);
        avatar = created;
      } catch (error) {
        if (disposed || mountOptions.signal.aborted) return;
        await showSprites("the mesh avatar could not be loaded", error);
      }
    },

    update(frame, dtMs) {
      if (fallback) return fallback.update(frame, dtMs);
      if (disposed || paused || !avatar || !shared || !copy || !options) return;
      applyFrame(avatar, frame, options);
      shared.size.width = pixels.width;
      shared.size.height = pixels.height;
      const seconds = Math.max(0, Math.min(0.05, dtMs / 1000));
      // One simulation step of `seconds`, drawn once (advance takes round(seconds * fps) steps).
      avatar.advance(seconds, seconds > 0 ? 1 / seconds : 60);
      const canvas = options.canvas;
      copy.clearRect(0, 0, canvas.width, canvas.height);
      copy.drawImage(shared.canvas, 0, 0, canvas.width, canvas.height);
    },

    resize(width, height, devicePixelRatio) {
      lastSize = [width, height, devicePixelRatio];
      if (fallback) return fallback.resize(width, height, devicePixelRatio);
      pixels.width = Math.max(1, Math.round(width * devicePixelRatio));
      pixels.height = Math.max(1, Math.round(height * devicePixelRatio));
      const canvas = options?.canvas;
      if (!canvas) return;
      if (canvas.width !== pixels.width) canvas.width = pixels.width;
      if (canvas.height !== pixels.height) canvas.height = pixels.height;
    },

    setPaused(value) {
      paused = value;
      fallback?.setPaused(value);
    },

    dispose() {
      disposed = true;
      teardown();
      fallback?.dispose();
      fallback = null;
      options = null;
      copy = null;
    },
  };
}
