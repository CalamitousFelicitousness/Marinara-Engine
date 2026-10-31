// ──────────────────────────────────────────────
// TTS Provider Types
// ──────────────────────────────────────────────

import type { TTSAudioFormat } from "@marinara-engine/shared";

/** Everything that varies per spoken line. Provider settings come from the config. */
export interface TTSSpeechInput {
  text: string;
  /** Already resolved against the request override and the configured default. */
  voice: string;
  speaker?: string;
  tone?: string;
}

/**
 * A ready-to-send provider request. Speech providers produce this and nothing
 * else, so the outbound call happens in exactly one
 * place and the deadline, the abort chain, the URL policy, and the size cap
 * cannot drift apart per backend. Being pure also means request shapes can be
 * asserted without a live server, and shown to the user before one is made.
 */
export interface TTSProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string | FormData;
  /** ElevenLabs answers gzipped, and undici will not unwrap it for us. */
  decodeCompressedResponse: boolean;
  /** The `response_format` the body asks for; raw PCM can arrive labelled only as octet-stream. */
  responseFormat?: TTSAudioFormat;
}

/** Saved settings that cannot produce speech. Surfaces as a 4xx, not a gateway error. */
export class TTSConfigurationError extends Error {
  readonly detail?: string;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "TTSConfigurationError";
    this.detail = detail;
  }
}
