// ──────────────────────────────────────────────
// Mesh avatars: what one frame asks of the mesh-avatar runtime (lane: 2D)
// ──────────────────────────────────────────────
// Pure functions (no DOM and no mesh-avatar import), so the setup panel can use the names without loading
// the runtime, and scripts/regressions/avatar-2d-renderers.regression.ts can pin the mapping.
import type { AvatarEmotion, AvatarExpressionMap, AvatarFrameInput, AvatarViseme } from "@marinara-engine/shared";

/** mesh-avatar 0.1.1 emotion tags (setEmotion): the same six names as the avatar emotions. */
export const MESH_AVATAR_EMOTION_TAGS: readonly AvatarEmotion[] = [
  "neutral",
  "happy",
  "angry",
  "sad",
  "relaxed",
  "surprised",
];
/** mesh-avatar 0.1.1 live expressions (setExpression) offered besides the emotion tags; its `angry`, `sad`,
 *  `surprise` and `neutral` overlays repeat the tags above. */
export const MESH_AVATAR_EXTRA_EXPRESSIONS = ["smile", "shy", "halfLidded", "wink"] as const;
const LIVE_EXPRESSIONS = new Set<string>(["neutral", "smile", "shy", "surprise", "halfLidded", "angry", "sad", "wink"]);
const EMOTION_TAGS = new Set<string>(MESH_AVATAR_EMOTION_TAGS);
const VOWELS: Readonly<Record<AvatarViseme, string>> = { aa: "a", ih: "i", ou: "u", ee: "e", oh: "o" };
const VALID_VOWELS = new Set(["a", "i", "u", "e", "o"]);
/** Below this weight a feeling is too faint to change the face. */
const MIN_EMOTION_WEIGHT = 0.25;
/** Below this opening a mouth shape closes. */
const MIN_MOUTH_OPEN = 0.08;

export interface MeshAvatarFace {
  /** setEmotion tag. */
  emotion: AvatarEmotion;
  /** setExpression overlay; `neutral` clears it. */
  expression: string;
}

/** The runtime face for a frame: the binding's target when it is a tag or a live expression, otherwise
 *  the frame's own emotion. */
export function meshAvatarFace(
  expressionMap: AvatarExpressionMap,
  frame: Pick<AvatarFrameInput, "emotion" | "emotionWeight">,
): MeshAvatarFace {
  const emotion = frame.emotionWeight >= MIN_EMOTION_WEIGHT ? frame.emotion : "neutral";
  const target = expressionMap[emotion]?.target ?? emotion;
  if (EMOTION_TAGS.has(target)) return { emotion: target as AvatarEmotion, expression: "neutral" };
  if (LIVE_EXPRESSIONS.has(target)) return { emotion: "neutral", expression: target };
  return { emotion, expression: "neutral" };
}

export type MeshAvatarMouth =
  | { mode: "off" }
  /** A known mouth shape (the speech clock): hold that vowel, or `n` to close. */
  | { mode: "hold"; vowel: string }
  /** Only a loudness (text-to-speech audio): the runtime picks vowels per syllable. */
  | { mode: "voice"; level: number };

export function meshAvatarMouth(
  expressionMap: AvatarExpressionMap,
  frame: Pick<AvatarFrameInput, "viseme" | "mouthOpen">,
  lipSync: boolean,
): MeshAvatarMouth {
  if (!lipSync) return { mode: "off" };
  if (frame.viseme) {
    const bound = expressionMap[frame.viseme]?.target;
    const vowel = bound && VALID_VOWELS.has(bound) ? bound : VOWELS[frame.viseme];
    return { mode: "hold", vowel: frame.mouthOpen > MIN_MOUTH_OPEN ? vowel : "n" };
  }
  return { mode: "voice", level: Math.max(0, Math.min(1, frame.mouthOpen)) };
}

/** Parameter overrides (setParameters) for one frame: the head held still for reduced motion or with idle
 *  motion off, eyelids when the director drives the blink or blinking is off, and the gaze. */
export function meshAvatarOverrides(
  frame: Pick<AvatarFrameInput, "blink" | "lookAt">,
  options: { still: boolean; blink: boolean },
): Record<string, number> {
  const overrides: Record<string, number> = {};
  if (options.still) {
    Object.assign(overrides, { angleX: 0, angleY: 0, angleZ: 0, bodyAngleX: 0, bodyAngleZ: 0, breath: 0 });
  }
  const eyesOpen = !options.blink ? 1 : frame.blink !== undefined ? 1 - Math.max(0, Math.min(1, frame.blink)) : null;
  if (eyesOpen !== null) Object.assign(overrides, { eyeLOpen: eyesOpen, eyeROpen: eyesOpen });
  if (frame.lookAt) {
    overrides.gazeX = Math.max(-1, Math.min(1, frame.lookAt.x));
    overrides.gazeY = Math.max(-1, Math.min(1, frame.lookAt.y));
  }
  return overrides;
}
