// ──────────────────────────────────────────────
// VRM avatars: expression easing, blinking, idle pose and camera framing (lane: 3D)
// ──────────────────────────────────────────────
// Plain maths with no three.js import, so it is cheap to test. vrm-renderer.ts applies the results to a
// loaded model every frame the stage asks for.
import type { AvatarExpressionMap, AvatarFrameInput, AvatarViseme } from "@marinara-engine/shared";
import { AVATAR_EMOTIONS, AVATAR_VISEMES } from "@marinara-engine/shared";

/** Seconds for an eased value to cover about 63% of the way to its target. */
const EMOTION_EASE_SECONDS = 0.15;
const MOUTH_EASE_SECONDS = 0.05;
const POSE_EASE_SECONDS = 0.35;
/** Below this the mouth counts as closed. */
const MOUTH_CLOSED = 0.02;

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function ease(current: number, target: number, dtSeconds: number, seconds: number): number {
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dtSeconds) / seconds));
}

// ── Expressions ──

/** Current weight of each bound model expression, keyed by the model's expression name. */
export type ExpressionWeights = Map<string, number>;

export function createExpressionWeights(): ExpressionWeights {
  return new Map();
}

/** Eases every bound emotion and mouth expression toward what the frame asks for: the frame's emotion
 *  at its weight, and the frame's mouth shape opened by `mouthOpen` (aa when the shape is unknown or the
 *  model lacks it). Blink is not eased here: the blink timer already shapes it. */
export function stepExpressionWeights(
  weights: ExpressionWeights,
  map: AvatarExpressionMap,
  frame: AvatarFrameInput,
  features: { lipSync: boolean },
  dtSeconds: number,
): void {
  const targets = new Map<string, { value: number; seconds: number }>();
  const want = (name: string | null | undefined, value: number, seconds: number) => {
    if (!name) return;
    const previous = targets.get(name);
    targets.set(name, {
      value: Math.max(previous?.value ?? 0, value),
      seconds: Math.min(previous?.seconds ?? seconds, seconds),
    });
  };
  for (const emotion of AVATAR_EMOTIONS) {
    want(map[emotion]?.target, emotion === frame.emotion ? clamp01(frame.emotionWeight) : 0, EMOTION_EASE_SECONDS);
  }
  const mouthOpen = features.lipSync ? clamp01(frame.mouthOpen) : 0;
  const viseme: AvatarViseme | null = frame.viseme ?? (mouthOpen > MOUTH_CLOSED ? "aa" : null);
  const mouthTarget = viseme ? (map[viseme]?.target ?? map.aa?.target) : null;
  for (const slot of AVATAR_VISEMES) {
    const name = map[slot]?.target;
    want(name, name && name === mouthTarget ? mouthOpen : 0, MOUTH_EASE_SECONDS);
  }
  for (const [name, target] of targets) {
    weights.set(name, ease(weights.get(name) ?? 0, target.value, dtSeconds, target.seconds));
  }
}

// ── Blinking ──

const BLINK_CLOSE_SECONDS = 0.06;
const BLINK_HOLD_SECONDS = 0.03;
const BLINK_OPEN_SECONDS = 0.09;

export interface BlinkTimer {
  random: () => number;
  /** Seconds until the next blink starts. */
  wait: number;
  /** Seconds into the current blink, or -1 while the eyes are open. */
  phase: number;
}

export function createBlinkTimer(random: () => number = Math.random): BlinkTimer {
  return { random, wait: 2 + random() * 4, phase: -1 };
}

/** Eyelid closure 0..1 for this frame: a quick blink every 2 to 6 seconds while enabled. */
export function stepBlink(timer: BlinkTimer, dtSeconds: number, options: { enabled: boolean }): number {
  if (!options.enabled) {
    timer.phase = -1;
    return 0;
  }
  const dt = Math.max(0, dtSeconds);
  if (timer.phase < 0) {
    timer.wait -= dt;
    if (timer.wait > 0) return 0;
    timer.phase = -timer.wait;
  } else {
    timer.phase += dt;
  }
  const phase = timer.phase;
  if (phase < BLINK_CLOSE_SECONDS) return phase / BLINK_CLOSE_SECONDS;
  if (phase < BLINK_CLOSE_SECONDS + BLINK_HOLD_SECONDS) return 1;
  const opening = phase - BLINK_CLOSE_SECONDS - BLINK_HOLD_SECONDS;
  if (opening < BLINK_OPEN_SECONDS) return 1 - opening / BLINK_OPEN_SECONDS;
  timer.phase = -1;
  timer.wait = 2 + timer.random() * 4;
  return 0;
}

// ── Body pose ──

export const POSE_BONES = [
  "hips",
  "spine",
  "chest",
  "neck",
  "head",
  "leftUpperArm",
  "rightUpperArm",
  "leftLowerArm",
  "rightLowerArm",
] as const;
export type PoseBone = (typeof POSE_BONES)[number];
/** Euler angles (radians, XYZ order) of normalized humanoid bones, in VRM 1.0 space (model faces +Z). */
export type BodyPose = Record<PoseBone, [x: number, y: number, z: number]>;

/** Upper arms rotate this far down from the T-pose, elbows bend this far forward. */
const ARM_DOWN = 1.2;
const ELBOW_BEND = 0.25;

export interface IdleMotionState {
  tilt: number;
  nod: number;
  lean: number;
}

export function createIdleMotionState(): IdleMotionState {
  return { tilt: 0, nod: 0, lean: 0 };
}

/** VRM 0.x models face -Z in their normalized bone space, so x and z rotations flip sign there. */
export function vrm0Mirror(metaVersion: string | undefined): 1 | -1 {
  return metaVersion === "0" ? -1 : 1;
}

/** Arms resting at the sides, plus (when `animate`) breathing, a slow sway and a head pose for the state:
 *  tilted and looking up while thinking, leaning in while listening, nodding a little while talking. */
export function computeBodyPose(
  state: IdleMotionState,
  timeSeconds: number,
  frame: AvatarFrameInput,
  animate: boolean,
  dtSeconds: number,
): BodyPose {
  const pose: BodyPose = {
    hips: [0, 0, 0],
    spine: [0, 0, 0],
    chest: [0, 0, 0],
    neck: [0, 0, 0],
    head: [0, 0, 0],
    leftUpperArm: [0, 0, -ARM_DOWN],
    rightUpperArm: [0, 0, ARM_DOWN],
    leftLowerArm: [0, -ELBOW_BEND, 0],
    rightLowerArm: [0, ELBOW_BEND, 0],
  };
  if (!animate) {
    state.tilt = 0;
    state.nod = 0;
    state.lean = 0;
    return pose;
  }
  const talking = frame.state === "talking" ? clamp01(frame.mouthOpen) : 0;
  const goal =
    frame.state === "thinking"
      ? { tilt: 0.08, nod: -0.06, lean: 0 }
      : frame.state === "listening"
        ? { tilt: -0.05, nod: 0.03, lean: 0.03 }
        : { tilt: 0, nod: talking * 0.04, lean: 0 };
  state.tilt = ease(state.tilt, goal.tilt, dtSeconds, POSE_EASE_SECONDS);
  state.nod = ease(state.nod, goal.nod, dtSeconds, POSE_EASE_SECONDS);
  state.lean = ease(state.lean, goal.lean, dtSeconds, POSE_EASE_SECONDS);

  const t = timeSeconds * Math.PI * 2;
  const breath = Math.sin(t / 4.2);
  pose.spine = [breath * 0.012 + state.lean, 0, Math.sin(t / 5.9) * 0.012];
  pose.chest = [breath * 0.015, 0, 0];
  pose.hips = [0, Math.sin(t / 7.3) * 0.025, 0];
  pose.neck = [state.nod * 0.4, Math.sin(t / 6.7) * 0.02, 0];
  pose.head = [state.nod * 0.6 + Math.sin(t / 3.1) * 0.006, Math.sin(t / 8.3) * 0.03, state.tilt];
  pose.leftUpperArm = [0, 0, -ARM_DOWN + breath * 0.012];
  pose.rightUpperArm = [0, 0, ARM_DOWN - breath * 0.012];
  return pose;
}

// ── Drawing size ──

/** Largest drawing size per side, so a huge canvas cannot ask for an unbounded GPU buffer. */
const MAX_PIXELS_PER_SIDE = 2048;

/** Device pixels for a canvas of this CSS size: the pixel ratio is capped at `maxRatio`, and one scale
 *  applies to both sides so the size cap never changes the shape the camera projects into. */
export function canvasPixels(
  width: number,
  height: number,
  devicePixelRatio: number,
  maxRatio: number,
): { width: number; height: number } {
  const cssWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const cssHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const ratio = Math.min(Math.max(Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1, 0.5), maxRatio);
  const scale = Math.min(ratio, MAX_PIXELS_PER_SIDE / Math.max(1, cssWidth, cssHeight));
  return { width: Math.round(cssWidth * scale), height: Math.round(cssHeight * scale) };
}

// ── Camera framing ──

/** World heights (metres) of the model's head and hips bones and its lowest foot, at rest. */
export interface BodyHeights {
  headY: number;
  hipsY: number;
  footY: number;
}

export interface CameraFraming {
  /** A tall canvas (at least 1.5 times as high as wide) shows the whole body; any other shows a bust. */
  placement: "bust" | "full-body";
  targetY: number;
  distance: number;
}

/** Fits a bust (head and shoulders) or the whole body into a camera with this aspect and vertical field
 *  of view, from bone heights alone: the head's size scales with the hips-to-head distance. */
export function frameCamera(body: BodyHeights, aspect: number, fovDegrees: number): CameraFraming {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const unit = Math.max(0.1, body.headY - body.hipsY);
  const placement = safeAspect <= 1 / 1.5 ? "full-body" : "bust";
  const top = body.headY + (placement === "bust" ? 0.42 : 0.4) * unit;
  const bottom = placement === "bust" ? body.headY - 0.6 * unit : body.footY - 0.03;
  const width = (placement === "bust" ? 1.1 : 0.9) * unit;
  const margin = 1.08;
  const tanHalf = Math.tan((fovDegrees * Math.PI) / 360);
  const distance = Math.max(((top - bottom) * margin) / 2 / tanHalf, (width * margin) / 2 / (tanHalf * safeAspect));
  return { placement, targetY: (top + bottom) / 2, distance };
}
