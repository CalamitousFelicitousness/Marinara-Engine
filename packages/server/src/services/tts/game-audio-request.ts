// One place that maps an audio source to its game-audio builder.
//
// TTS_SOURCE_DEFINITIONS decides which sources MAY generate a lane; this decides
// which one actually builds the request. The two must agree, so a source that
// turns its table flag on without a builder here fails loudly rather than
// producing a request nobody can serve.

import { ttsSourceSupportsGameAudio, type GameAudioPurpose, type TTSConfig } from "@marinara-engine/shared";
import { buildElevenLabsGameAudioRequest } from "./elevenlabs.provider.js";
import { buildNanoGptGameAudioRequest } from "./nanogpt-game-audio.js";
import { TTSConfigurationError, type TTSProviderRequest } from "./tts-types.js";

export interface GameAudioRequestInput {
  kind: GameAudioPurpose;
  /** Already normalized by the caller. Never replaceable by a parameter. */
  prompt: string;
  /** Music only. Present for a context track, which owns its own length. */
  lengthMs?: number;
}

/** Whether a config can actually be asked for a lane, capability and key included. */
export function canBuildGameAudioRequest(cfg: TTSConfig, kind: GameAudioPurpose): boolean {
  return ttsSourceSupportsGameAudio(cfg.source, kind) && Boolean(cfg.apiKey);
}

export function buildGameAudioRequest(cfg: TTSConfig, input: GameAudioRequestInput): TTSProviderRequest {
  if (!ttsSourceSupportsGameAudio(cfg.source, input.kind)) {
    throw new TTSConfigurationError(`No game ${input.kind} generator exists for source "${cfg.source}"`);
  }
  switch (cfg.source) {
    case "elevenlabs":
      return buildElevenLabsGameAudioRequest(cfg, input);
    case "nanogpt":
      return buildNanoGptGameAudioRequest(cfg, input);
    default:
      // Reachable only by flipping a table flag without adding a case above.
      throw new TTSConfigurationError(`No game ${input.kind} generator exists for source "${cfg.source}"`);
  }
}
