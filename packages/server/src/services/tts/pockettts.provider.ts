// ──────────────────────────────────────────────
// PocketTTS Provider
// ──────────────────────────────────────────────
// Two wire formats behind one source. The official server takes multipart form
// data at /tts; the community OpenAI-compatible wrapper takes JSON at
// /v1/audio/speech. Which one is in front of us is probed once and cached in
// tts.routes.ts, then handed in, so this stays free of I/O.

import { audioParametersFor } from "@marinara-engine/shared";
import { BaseTTSProvider } from "./base-tts-provider.js";
import { appendAudioParameters } from "./audio-parameter-merge.js";
import {
  buildOfficialPocketTtsForm,
  openAiHeaders,
  optionalBearerHeaders,
  pocketTtsV1BaseUrl,
} from "./tts-endpoints.js";
import type { TTSSpeechInput, TTSProviderRequest } from "./tts-types.js";
import type { TTSConfig } from "@marinara-engine/shared";

export type PocketTtsApiMode = "official" | "openai";

export class PocketTtsProvider extends BaseTTSProvider {
  private readonly mode: PocketTtsApiMode;

  constructor(cfg: TTSConfig, baseUrl: string, mode: PocketTtsApiMode) {
    super(cfg, baseUrl);
    this.mode = mode;
  }

  buildSpeechRequest(input: TTSSpeechInput): TTSProviderRequest {
    if (this.mode === "official") {
      // The official server controls speed itself and takes no model id.
      return {
        url: `${this.baseUrl}/tts`,
        headers: optionalBearerHeaders(this.cfg.apiKey),
        body: appendAudioParameters(
          buildOfficialPocketTtsForm(input.text, input.voice),
          audioParametersFor(this.cfg, "speech"),
          { protectedKey: "text", label: "speech" },
        ),
        decodeCompressedResponse: false,
      };
    }

    return {
      url: `${pocketTtsV1BaseUrl(this.baseUrl)}/audio/speech`,
      headers: openAiHeaders(this.cfg.apiKey),
      body: this.jsonBody({
        model: this.resolveModel(),
        input: input.text,
        voice: input.voice || "alba",
        speed: this.cfg.speed,
        response_format: this.resolveAudioFormat(),
      }),
      decodeCompressedResponse: false,
    };
  }
}
