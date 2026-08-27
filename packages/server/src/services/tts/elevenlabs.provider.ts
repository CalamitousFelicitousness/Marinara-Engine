// ──────────────────────────────────────────────
// ElevenLabs TTS Provider
// ──────────────────────────────────────────────
// The voice is part of the path rather than the body, output format is pinned
// in the query string, and responses come back gzipped.

import { BaseTTSProvider } from "./base-tts-provider.js";
import {
  buildElevenLabsTextInput,
  clampElevenLabsSpeed,
  elevenLabsApiRoot,
  elevenLabsHeaders,
  elevenLabsModelSupportsSpeed,
  normalizeElevenLabsTtsModelId,
} from "./tts-endpoints.js";
import type { TTSSpeechInput, TTSSpeechRequest } from "./tts-types.js";

export class ElevenLabsTTSProvider extends BaseTTSProvider {
  override resolveModel(): string {
    return normalizeElevenLabsTtsModelId(this.configuredModel());
  }

  buildSpeechRequest(input: TTSSpeechInput): TTSSpeechRequest {
    const model = this.resolveModel();
    const languageCode = this.cfg.elevenLabsLanguageCode?.trim();
    // eleven_v3 rejects a speed setting; the others accept a narrow range.
    const includeSpeed = elevenLabsModelSupportsSpeed(model);

    return {
      url: `${elevenLabsApiRoot(this.baseUrl)}/v1/text-to-speech/${encodeURIComponent(input.voice)}?output_format=mp3_44100_128`,
      headers: elevenLabsHeaders(this.cfg.apiKey),
      body: JSON.stringify({
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
