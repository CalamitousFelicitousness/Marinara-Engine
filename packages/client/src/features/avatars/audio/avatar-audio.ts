// ──────────────────────────────────────────────
// Avatar audio: voice loudness from text-to-speech playback (lane: TTS)
// ──────────────────────────────────────────────
// When TTS plays a line for a character or persona, publish an AvatarAudioLevelSource for that owner
// (an AnalyserNode on the existing playback path; no second audio element), and null when it stops.
// The director subscribes; nothing else does.
//
// Contract stub: never reports audio until the TTS lane fills it in.
import type { AvatarAudioListener } from "../contract";

export function subscribeAvatarAudio(_listener: AvatarAudioListener): () => void {
  return () => {};
}
