// ──────────────────────────────────────────────
// Avatar stage: avatars in Roleplay and Game chats (lane: base)
// ──────────────────────────────────────────────
// Mounted lazily by the chat surfaces. Picks each participant's kind (AvatarConfig.activeKind, falling
// back by AVATAR_KIND_AGENT to a kind whose agent is on), loads renderers with loadAvatarRenderer(),
// creates one director, and runs the single frame loop within AVATAR_RENDER_BUDGET (visible count, DPR
// cap, fps, pause when hidden, offscreen or effects-paused, reduced motion). It never hides the
// full-body sprite: the user turns that off by hand.
//
// Contract stub: renders nothing until the base lane fills it in.
import type { AvatarStageProps } from "../contract";

export function AvatarStage(_props: AvatarStageProps) {
  return null;
}
