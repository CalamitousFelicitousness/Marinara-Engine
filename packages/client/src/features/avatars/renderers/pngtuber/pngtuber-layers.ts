// ──────────────────────────────────────────────
// PNGTuber avatars: layer sets from sprites, and the frame rules the renderer follows (lane: 2D)
// ──────────────────────────────────────────────
// Pure functions (no DOM), shared by the renderer and the setup panel and pinned by
// scripts/regressions/avatar-2d-renderers.regression.ts.
import {
  SPRITE_EXPRESSION_LABELS,
  avatarModelFileUrl,
  detectSpriteEmotionBindings,
  normalizeSpriteExpressionKey,
  type AvatarFrameInput,
  type AvatarImageRef,
  type AvatarOwnerRef,
  type PngtuberAvatarData,
  type PngtuberLayerSet,
} from "@marinara-engine/shared";

/** Motion for a new setup: a small hop while talking and a blink every 3 to 6 seconds. */
export const PNGTUBER_DEFAULT_MOTION = Object.freeze({
  bounceOnTalk: true,
  bounceHeight: 0.06,
  blinkIntervalSeconds: 4.5,
});
/** Crossfade between faces. */
export const PNGTUBER_FADE_MS = 120;
/** How long the eyes stay shut in one blink. */
export const PNGTUBER_BLINK_MS = 140;
/** One hop while talking. */
export const PNGTUBER_HOP_MS = 220;
/** Same bound as the PNGTuber schema in packages/shared/src/schemas/avatars.schema.ts. */
const MAX_LAYER_SETS = 64;
const LAYER_KEY = /^[\p{L}\p{N}_]{1,64}$/u;
const FULL_BODY = /^full[_\s-]+/iu;
const MOUTH_OPEN_SUFFIXES = ["mouth_open", "open_mouth", "talking", "talk", "speaking", "speak"];
const EYES_CLOSED_SUFFIXES = ["eyes_closed", "closed_eyes", "eyes_shut", "blinking", "blink"];

export interface SpriteLike {
  expression: string;
  url?: string;
}

/** Splits a sprite key like `happy_talk_blink` into its face (`happy`) and the variant its suffixes name. */
export function splitSpriteVariant(key: string): { base: string; mouthOpen: boolean; eyesClosed: boolean } {
  let base = key;
  let mouthOpen = false;
  let eyesClosed = false;
  for (let changed = true; changed;) {
    changed = false;
    for (const [suffixes, isMouth] of [
      [MOUTH_OPEN_SUFFIXES, true],
      [EYES_CLOSED_SUFFIXES, false],
    ] as const) {
      const suffix = suffixes.find((candidate) => base.length > candidate.length + 1 && base.endsWith(`_${candidate}`));
      if (!suffix) continue;
      base = base.slice(0, -(suffix.length + 1));
      if (isMouth) mouthOpen = true;
      else eyesClosed = true;
      changed = true;
    }
  }
  return { base, mouthOpen, eyesClosed };
}

/** The sprites a PNGTuber setup uses: portrait sprites when there are any, otherwise full-body ones, so the
 *  faces never mix the two framings. */
export function pngtuberSpriteFamily<T extends SpriteLike>(sprites: readonly T[]): T[] {
  const portraits = sprites.filter((sprite) => !FULL_BODY.test(sprite.expression.trim()));
  return portraits.length > 0 ? portraits : [...sprites];
}

/** A PNGTuber setup built from an owner's expression sprites: one layer set per face, with `_talk` and
 *  `_blink` sprites (and their spelling variants) as its mouth-open and eyes-closed pictures. Null when the
 *  owner has no usable sprite. */
export function buildPngtuberLayersFromSprites(sprites: readonly SpriteLike[]): PngtuberAvatarData | null {
  const layers = new Map<string, PngtuberLayerSet>();
  const variants: { base: string; key: string; mouthOpen: boolean; eyesClosed: boolean }[] = [];
  for (const sprite of pngtuberSpriteFamily(sprites)) {
    const key = normalizeSpriteExpressionKey(sprite.expression);
    if (!LAYER_KEY.test(key)) continue;
    const split = splitSpriteVariant(key);
    if (split.mouthOpen || split.eyesClosed) variants.push({ ...split, key });
    else if (!layers.has(key)) layers.set(key, { base: { source: "sprite", label: key } });
  }
  for (const variant of variants) {
    const set = layers.get(variant.base);
    if (!set) continue;
    const slot =
      variant.mouthOpen && variant.eyesClosed ? "eyesClosedMouthOpen" : variant.mouthOpen ? "mouthOpen" : "eyesClosed";
    set[slot] ??= { source: "sprite", label: variant.key };
  }
  const known: readonly string[] = SPRITE_EXPRESSION_LABELS;
  const rank = (key: string) => (known.includes(key) ? known.indexOf(key) : known.length);
  const keys = [...layers.keys()]
    .sort((left, right) => rank(left) - rank(right) || left.localeCompare(right))
    .slice(0, MAX_LAYER_SETS);
  if (keys.length === 0) return null;
  return {
    layers: Object.fromEntries(keys.map((key) => [key, layers.get(key)!])),
    expressionMap: detectSpriteEmotionBindings(keys),
    motion: { ...PNGTUBER_DEFAULT_MOTION },
    source: "sprites",
  };
}

/** URL of a PNGTuber picture: a stored file, or the owner's sprite with that key (a portrait before a
 *  full-body sprite of the same face). */
export function resolvePngtuberImage(
  owner: AvatarOwnerRef,
  ref: AvatarImageRef,
  sprites: readonly SpriteLike[],
): string | null {
  if (ref.source === "file") return avatarModelFileUrl(owner, ref.path);
  for (const sprite of pngtuberSpriteFamily(sprites)) {
    if (sprite.url && normalizeSpriteExpressionKey(sprite.expression) === ref.label) return sprite.url;
  }
  return (
    sprites.find((sprite) => sprite.url && normalizeSpriteExpressionKey(sprite.expression) === ref.label)?.url ?? null
  );
}

/** The layer set a frame shows: the exact sprite label when the setup has it (an Expression Engine or
 *  Game Master pick), else the set bound to the frame's emotion, else the resting face. */
export function pickPngtuberLayerKey(
  data: Pick<PngtuberAvatarData, "layers" | "expressionMap">,
  frame: Pick<AvatarFrameInput, "emotion" | "label">,
): string | null {
  const has = (key: string | null | undefined): key is string => !!key && Object.hasOwn(data.layers, key);
  const label = frame.label ? normalizeSpriteExpressionKey(frame.label) : null;
  if (has(label)) return label;
  const bound = data.expressionMap[frame.emotion]?.target;
  if (has(bound)) return bound;
  const neutral = data.expressionMap.neutral?.target;
  if (has(neutral)) return neutral;
  if (has("neutral")) return "neutral";
  return Object.keys(data.layers)[0] ?? null;
}

/** The picture of a layer set for the mouth and eyes right now; a missing variant falls back to one the set
 *  has, so a single sprite still works. While talking and blinking at once, the open mouth wins. */
export function pickPngtuberPicture(set: PngtuberLayerSet, mouthOpen: boolean, eyesClosed: boolean): AvatarImageRef {
  if (mouthOpen && eyesClosed) return set.eyesClosedMouthOpen ?? set.mouthOpen ?? set.eyesClosed ?? set.base;
  if (mouthOpen) return set.mouthOpen ?? set.base;
  if (eyesClosed) return set.eyesClosed ?? set.base;
  return set.base;
}

/** Mouth open or shut for one frame, with hysteresis so a level hovering at the edge does not flicker. Vowels
 *  open it and consonants close it: the director's speech clock holds consonants at 0.2 and vowels at 0.5 or
 *  more, and text-to-speech levels are scaled so the loud parts of a clip reach 1. */
export function nextPngtuberMouthOpen(wasOpen: boolean, mouthOpen: number): boolean {
  return wasOpen ? mouthOpen >= 0.3 : mouthOpen > 0.42;
}

export interface PngtuberBlinkClock {
  /** Time until the next blink starts. */
  waitMs: number;
  /** Time left in the blink now showing; 0 when the eyes are open. */
  closedMs: number;
}

/** Seconds between blinks, randomised to two thirds and four thirds of the average (3 to 6 s for 4.5). */
export function pngtuberBlinkWaitMs(intervalSeconds: number, random: () => number): number {
  return intervalSeconds * 1000 * (2 / 3 + (random() * 2) / 3);
}

/** Advances the blink timer and says whether the eyes are shut now. */
export function advancePngtuberBlink(
  clock: PngtuberBlinkClock,
  dtMs: number,
  intervalSeconds: number,
  random: () => number,
): boolean {
  if (clock.closedMs > 0) {
    clock.closedMs -= dtMs;
    if (clock.closedMs > 0) return true;
    clock.closedMs = 0;
    clock.waitMs = pngtuberBlinkWaitMs(intervalSeconds, random);
    return false;
  }
  clock.waitMs -= dtMs;
  if (clock.waitMs > 0) return false;
  clock.closedMs = PNGTUBER_BLINK_MS;
  return true;
}

/** Height of a hop, 0..1 of the bounce height, `elapsedMs` after it started. */
export function pngtuberHop(elapsedMs: number): number {
  const progress = elapsedMs / PNGTUBER_HOP_MS;
  return progress <= 0 || progress >= 1 ? 0 : Math.sin(Math.PI * progress);
}

/** Breathing: a slow vertical stretch of about one percent. */
export function pngtuberBreath(timeMs: number): number {
  return 1 + 0.01 * Math.sin((2 * Math.PI * timeMs) / 3600);
}

/** Thinking: a slow tilt of about one degree each way. */
export function pngtuberThinkingTilt(timeMs: number): number {
  return 0.018 * Math.sin((2 * Math.PI * timeMs) / 5000);
}

/** Where a picture sits in the canvas: as large as fits, centred and standing on the bottom edge, with room
 *  above for the hop. */
export function fitPngtuberPicture(
  canvasWidth: number,
  canvasHeight: number,
  pictureWidth: number,
  pictureHeight: number,
  headroom: number,
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(canvasWidth / pictureWidth, (canvasHeight * (1 - headroom)) / pictureHeight);
  const width = pictureWidth * scale;
  const height = pictureHeight * scale;
  return { x: (canvasWidth - width) / 2, y: canvasHeight - height, width, height };
}
