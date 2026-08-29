// ──────────────────────────────────────────────
// ElevenLabs TTS Provider
// ──────────────────────────────────────────────
// The voice is part of the path rather than the body, output format is pinned
// in the query string, and responses come back gzipped.
//
// Also the only backend that generates game audio, which is a separate pair of
// endpoints rather than a speech request, so it is a function beside the class
// instead of a method on it. The route owns the fetch, the lock, and the cache.

import { audioParametersFor, type GameAudioPurpose, type TTSConfig } from "@marinara-engine/shared";
import { applyAudioParameters } from "./audio-parameter-merge.js";
import { BaseTTSProvider } from "./base-tts-provider.js";
import {
  configuredBaseUrl,
  buildElevenLabsTextInput,
  clampElevenLabsSpeed,
  elevenLabsApiRoot,
  elevenLabsHeaders,
  elevenLabsModelSupportsSpeed,
  normalizeElevenLabsTtsModelId,
} from "./tts-endpoints.js";
import type { TTSSpeechInput, TTSProviderRequest } from "./tts-types.js";

export class ElevenLabsTTSProvider extends BaseTTSProvider {
  override resolveModel(): string {
    return normalizeElevenLabsTtsModelId(this.configuredModel());
  }

  protected override contentKey(): string {
    return "text";
  }

  buildSpeechRequest(input: TTSSpeechInput): TTSProviderRequest {
    const model = this.resolveModel();
    const languageCode = this.cfg.elevenLabsLanguageCode?.trim();
    // eleven_v3 rejects a speed setting; the others accept a narrow range.
    const includeSpeed = elevenLabsModelSupportsSpeed(model);

    return {
      url: `${elevenLabsApiRoot(this.baseUrl)}/v1/text-to-speech/${encodeURIComponent(input.voice)}?output_format=mp3_44100_128`,
      headers: elevenLabsHeaders(this.cfg.apiKey),
      body: this.jsonBody({
        text: buildElevenLabsTextInput(input.text, input.tone),
        model_id: model,
        ...(languageCode ? { language_code: languageCode } : {}),
        voice_settings: {
          stability: this.cfg.elevenLabsStability,
          ...(includeSpeed ? { speed: clampElevenLabsSpeed(this.cfg.speed) } : {}),
        },
      }),
      decodeCompressedResponse: true,
    };
  }
}

/** Milliseconds a context track runs when the scene names no length of its own. */
export const ELEVENLABS_CONTEXT_MUSIC_LENGTH_MS = 120_000;

export interface ElevenLabsGameAudioInput {
  kind: GameAudioPurpose;
  /** Already normalized by the caller. Never replaceable by a parameter. */
  prompt: string;
  /** Music only. Present for a context track, which owns its own length. */
  lengthMs?: number;
}

/**
 * The sound-effect or music request for a game asset, with this connection's
 * parameters for that lane merged in.
 *
 * The values below are defaults, not decisions: a connection that sets
 * prompt_influence or force_instrumental overrides them, and one that overrides
 * music_length_ms is warned about rather than ignored, since a context track's
 * length comes from the scene.
 */
export function buildElevenLabsGameAudioRequest(cfg: TTSConfig, input: ElevenLabsGameAudioInput): TTSProviderRequest {
  const music = input.kind === "music";
  const body = music
    ? {
        prompt: input.prompt,
        music_length_ms: input.lengthMs ?? ELEVENLABS_CONTEXT_MUSIC_LENGTH_MS,
        force_instrumental: true,
      }
    : { text: input.prompt, prompt_influence: 0.3 };

  return {
    url: `${elevenLabsApiRoot(configuredBaseUrl(cfg))}${music ? "/v1/music" : "/v1/sound-generation"}`,
    headers: elevenLabsHeaders(cfg.apiKey),
    body: JSON.stringify(
      applyAudioParameters(body, audioParametersFor(cfg, input.kind), {
        protectedKey: music ? "prompt" : "text",
        label: music ? "game music" : "game sound effect",
      }),
    ),
    decodeCompressedResponse: true,
  };
}
