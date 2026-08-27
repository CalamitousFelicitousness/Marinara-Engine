// ──────────────────────────────────────────────
// xAI Voice Provider
// ──────────────────────────────────────────────
// Its own body shape: the voice is voice_id, and the output format is a nested
// object rather than a format name.

import { BaseTTSProvider } from "./base-tts-provider.js";
import { clampXaiSpeed, openAiHeaders } from "./tts-endpoints.js";
import type { TTSSpeechInput, TTSSpeechRequest } from "./tts-types.js";

export class XaiTTSProvider extends BaseTTSProvider {
  buildSpeechRequest(input: TTSSpeechInput): TTSSpeechRequest {
    const format = this.resolveAudioFormat();

    return {
      url: `${this.baseUrl}/tts`,
      headers: openAiHeaders(this.cfg.apiKey),
      body: JSON.stringify({
        text: input.text,
        voice_id: input.voice || "eve",
        language: "auto",
        output_format: {
          codec: format,
          sample_rate: format === "mp3" ? 44_100 : 24_000,
          ...(format === "mp3" ? { bit_rate: 128_000 } : {}),
        },
        speed: clampXaiSpeed(this.cfg.speed),
      }),
      decodeCompressedResponse: false,
    };
  }
}
