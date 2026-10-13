// ──────────────────────────────────────────────
// Avatar director: chat activity → avatar frames (lane: director)
// ──────────────────────────────────────────────
// Roleplay: the streaming classifier (/api/avatar-classify, tiered, no LLM). Game: the Game Master's
// per-line expressions. Either way an Expression Engine pick is the final face after the reply. Lip sync
// runs a speech clock over the visible streamed text and switches to the audio level while TTS plays
// (subscribeAvatarAudio from ../audio/avatar-audio).
//
// Contract stub: holds every avatar at a neutral idle frame until the director lane fills it in.
import { AVATAR_NEUTRAL_FRAME } from "@marinara-engine/shared";
import type { AvatarDirector, AvatarDirectorOptions } from "../contract";

export function createAvatarDirector(_options: AvatarDirectorOptions): AvatarDirector {
  return {
    setParticipants() {},
    pushStreamText() {},
    pushExpressionPicks() {},
    pushGameLine() {},
    setAudioSource() {},
    setUserTyping() {},
    frame: () => ({ ...AVATAR_NEUTRAL_FRAME }),
    dispose() {},
  };
}
