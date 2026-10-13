// ──────────────────────────────────────────────
// Avatar stage: the pure decisions behind AvatarStage and the setup preview (lane: base)
// ──────────────────────────────────────────────
// Kept free of React and the DOM so scripts/regressions/avatar-stage-logic.regression.ts can run them.
import {
  AVATAR_AGENT_IDS,
  AVATAR_KIND_AGENT,
  AVATAR_KINDS,
  normalizeSpriteExpressionKey,
  avatarModelFileUrl,
  type AvatarAgentId,
  type AvatarConfig,
  type AvatarFeatureFlags,
  type AvatarFrameInput,
  type AvatarImageRef,
  type AvatarKind,
  type AvatarOwnerRef,
  type AvatarOwnerSummary,
} from "@marinara-engine/shared";
import { AVATAR_RENDER_BUDGET, type AvatarParticipant } from "../contract";

/** The kind to show in a chat: the active kind when its agent is on, otherwise the first set-up kind
 *  whose agent is on (pngtuber, then mesh-avatar, then vrm), or null when none can show. */
export function pickAvatarKind(
  owner: Pick<AvatarOwnerSummary, "activeKind" | "kinds">,
  enabledAgentIds: readonly AvatarAgentId[],
): AvatarKind | null {
  const shows = (kind: AvatarKind) => owner.kinds.includes(kind) && enabledAgentIds.includes(AVATAR_KIND_AGENT[kind]);
  if (owner.activeKind && shows(owner.activeKind)) return owner.activeKind;
  return AVATAR_KINDS.find(shows) ?? null;
}

export interface StageAvatar {
  participant: AvatarParticipant;
  kind: AvatarKind;
  /** Position among the shown avatars, for default placement. */
  index: number;
}

/** Participants with an enabled avatar their chat can show, in participant order, at most `maxVisible`. */
export function selectStageAvatars(
  participants: readonly AvatarParticipant[],
  summaries: readonly AvatarOwnerSummary[] | undefined,
  enabledAgentIds: readonly AvatarAgentId[],
  maxVisible: number,
): StageAvatar[] {
  if (!summaries?.length || enabledAgentIds.length === 0) return [];
  const byOwner = new Map(summaries.map((summary) => [ownerKey(summary.owner), summary]));
  const seen = new Set<string>();
  const shown: StageAvatar[] = [];
  for (const participant of participants) {
    const key = ownerKey(participant.owner);
    const summary = byOwner.get(key);
    if (!summary?.enabled || seen.has(key)) continue;
    const kind = pickAvatarKind(summary, enabledAgentIds);
    if (!kind) continue;
    seen.add(key);
    shown.push({ participant, kind, index: shown.length });
    if (shown.length >= maxVisible) break;
  }
  return shown;
}

export function ownerKey(owner: AvatarOwnerRef): string {
  return `${owner.ownerType}:${owner.ownerId}`;
}

/** Frames per second the stage draws at. */
export function avatarTargetFps(options: { talking: boolean; phone: boolean; underLoad: boolean }): number {
  const { fps } = AVATAR_RENDER_BUDGET;
  if (options.talking) return fps.talking;
  if (!options.phone) return fps.idleDesktop;
  return options.underLoad ? fps.idlePhoneUnderLoad : fps.idlePhone;
}

/** The canvas device pixel ratio, capped by the budget. */
export function avatarDevicePixelRatio(devicePixelRatio: number, phone: boolean): number {
  const cap = phone ? AVATAR_RENDER_BUDGET.maxDevicePixelRatio.phone : AVATAR_RENDER_BUDGET.maxDevicePixelRatio.desktop;
  return Math.min(Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1, cap);
}

/** The director's frame with the owner's switches applied: no lip sync keeps the mouth shut, no blinking
 *  holds the eyes open, and no idle motion (or reduced motion) drops the thinking and listening poses. */
export function applyAvatarFeatures(
  frame: AvatarFrameInput,
  features: AvatarFeatureFlags,
  reducedMotion: boolean,
): AvatarFrameInput {
  const next: AvatarFrameInput = { ...frame };
  if (!features.lipSync) {
    next.viseme = null;
    next.mouthOpen = 0;
  }
  if (!features.blink) next.blink = 0;
  if ((!features.idleMotion || reducedMotion) && next.state !== "talking") next.state = "idle";
  return next;
}

export interface AvatarSpriteRef {
  expression: string;
  url: string;
}

/** URL of a PNGTuber image: a stored file (with the config's save time, so a replaced file reloads), or
 *  the owner's sprite with that label. Expression sprites win over full-body ones with the same label. */
export function resolveAvatarImage(
  owner: AvatarOwnerRef,
  config: Pick<AvatarConfig, "updatedAt">,
  sprites: readonly AvatarSpriteRef[] | undefined,
  ref: AvatarImageRef,
): string | null {
  if (ref.source === "file") {
    return `${avatarModelFileUrl(owner, ref.path)}?v=${encodeURIComponent(config.updatedAt)}`;
  }
  const label = normalizeSpriteExpressionKey(ref.label);
  if (!label || !sprites?.length) return null;
  const matches = sprites.filter((sprite) => normalizeSpriteExpressionKey(sprite.expression) === label);
  const expressionSprite = matches.find((sprite) => !/^full[_\s-]/iu.test(sprite.expression));
  return (expressionSprite ?? matches[0])?.url ?? null;
}

/** A chat's avatar participants: its characters in chat order, then the user's persona. A persona that is a
 *  character card ("play as a character") is that character. */
export function chatAvatarParticipants(
  characterIds: readonly string[],
  characterMap: ReadonlyMap<string, { name: string }>,
  persona?: { id?: string; source?: "persona" | "character"; name: string } | null,
): AvatarParticipant[] {
  const participants: AvatarParticipant[] = [];
  for (const id of characterIds) {
    const character = characterMap.get(id);
    if (character) participants.push({ owner: { ownerType: "character", ownerId: id }, name: character.name });
  }
  if (persona?.id) {
    participants.push({
      owner: { ownerType: persona.source === "character" ? "character" : "persona", ownerId: persona.id },
      name: persona.name,
    });
  }
  return participants;
}

/** Avatar agents a chat turned on: agents enabled and the agent added to the chat. */
export function chatAvatarAgentIds(chatMeta: { enableAgents?: unknown; activeAgentIds?: unknown }): AvatarAgentId[] {
  if (chatMeta.enableAgents !== true && chatMeta.enableAgents !== "true") return [];
  const active = Array.isArray(chatMeta.activeAgentIds) ? (chatMeta.activeAgentIds as unknown[]) : [];
  return AVATAR_AGENT_IDS.filter((id) => active.includes(id));
}
