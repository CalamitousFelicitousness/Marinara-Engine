// ──────────────────────────────────────────────
// Avatar setup: the pure parts of the Agent editor setup (lane: base)
// ──────────────────────────────────────────────
// Kept free of React so scripts/regressions/avatar-stage-logic.regression.ts can run them.
import {
  AVATAR_EMOTIONS,
  AVATAR_EXPRESSION_SLOTS,
  AVATAR_KIND_AGENT,
  AVATAR_KINDS,
  detectSpriteEmotionBindings,
  normalizeSpriteExpressionKey,
  type AvatarAgentId,
  type AvatarExpressionMap,
  type AvatarExpressionSlot,
  type AvatarKind,
  type AvatarKindDataMap,
  type PngtuberAvatarData,
} from "@marinara-engine/shared";

/** Matches the PNGTuber layer key rule in avatars.schema.ts. */
const LAYER_KEY_PATTERN = /^[\p{L}\p{N}_]{1,64}$/u;
/** Same bound as the schema: at most 64 layer sets per PNGTuber setup. */
const MAX_LAYER_SETS = 64;

export const DEFAULT_PNGTUBER_MOTION: PngtuberAvatarData["motion"] = Object.freeze({
  bounceOnTalk: true,
  bounceHeight: 0.06,
  blinkIntervalSeconds: 4,
});

/** The kinds an avatar agent's page sets up. */
export function avatarAgentKinds(agentId: AvatarAgentId): AvatarKind[] {
  return AVATAR_KINDS.filter((kind) => AVATAR_KIND_AGENT[kind] === agentId);
}

/** The slots worth editing for a kind: PNGTuber swaps whole pictures per feeling (its mouth and eyes are
 *  layer variants), while models also bind mouth shapes and the blink. */
export function avatarEditableSlots(kind: AvatarKind): readonly AvatarExpressionSlot[] {
  return kind === "pngtuber" ? AVATAR_EMOTIONS : AVATAR_EXPRESSION_SLOTS;
}

/** A PNGTuber setup from the owner's expression sprites (full-body sprites are left out). An existing setup
 *  keeps its layer sets, motion and the faces the user chose; new sprites are added beside them. */
export function buildPngtuberFromSprites(
  spriteExpressions: readonly string[],
  existing?: PngtuberAvatarData,
): PngtuberAvatarData | null {
  const keys: string[] = [];
  for (const expression of spriteExpressions) {
    if (/^full[_\s-]/iu.test(expression)) continue;
    const key = normalizeSpriteExpressionKey(expression);
    if (LAYER_KEY_PATTERN.test(key) && !keys.includes(key)) keys.push(key);
  }
  const layers: PngtuberAvatarData["layers"] = { ...existing?.layers };
  for (const key of keys) {
    if (Object.keys(layers).length >= MAX_LAYER_SETS) break;
    layers[key] ??= { base: { source: "sprite", label: key } };
  }
  const layerKeys = Object.keys(layers);
  if (layerKeys.length === 0) return null;
  const detected = detectSpriteEmotionBindings(layerKeys);
  const expressionMap: AvatarExpressionMap = { ...existing?.expressionMap };
  for (const emotion of AVATAR_EMOTIONS) {
    const chosen = existing?.expressionMap[emotion];
    const keepChoice = chosen?.source === "user" && (chosen.target === null || layerKeys.includes(chosen.target));
    if (!keepChoice) expressionMap[emotion] = detected[emotion];
  }
  return {
    layers,
    expressionMap,
    motion: existing?.motion ?? { ...DEFAULT_PNGTUBER_MOTION },
    source: existing?.source ?? "sprites",
  };
}

/** What a slot can bind to: PNGTuber layer sets, or for models the names their import found plus the
 *  standard preset names (so a changed slot can always go back to its preset). */
export function avatarBindingTargets<K extends AvatarKind>(kind: K, data: AvatarKindDataMap[K]): string[] {
  const targets = new Set<string>();
  if (kind === "pngtuber") {
    for (const key of Object.keys((data as PngtuberAvatarData).layers)) targets.add(key);
  } else {
    for (const slot of AVATAR_EXPRESSION_SLOTS) targets.add(slot);
    for (const binding of Object.values(data.expressionMap)) {
      if (binding?.target) targets.add(binding.target);
    }
  }
  return [...targets].sort((left, right) => left.localeCompare(right));
}

/** The kind's data with one slot set by the user (null target: the model has nothing for it). */
export function withBindingOverride<K extends AvatarKind>(
  data: AvatarKindDataMap[K],
  slot: AvatarExpressionSlot,
  target: string | null,
): AvatarKindDataMap[K] {
  return {
    ...data,
    expressionMap: { ...data.expressionMap, [slot]: { target, source: "user", confidence: 1 } },
  };
}
