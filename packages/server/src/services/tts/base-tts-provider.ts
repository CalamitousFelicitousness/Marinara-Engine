// ──────────────────────────────────────────────
// TTS Provider Base
// ──────────────────────────────────────────────
// Mirrors the LLM provider pattern (services/llm/base-provider.ts) but stays
// deliberately shallow: constructor arguments, one request builder, no wrapper
// chain. TTS is one-shot synthesis, so there is nothing yet for a decorator to
// wrap. Add one when a second behaviour actually needs it.
//
// Providers do no I/O. The route performs the single outbound call, so the
// deadline, abort chain, URL policy, and response cap cannot drift per backend.

import { TTS_SOURCE_DEFINITIONS, type TTSAudioFormat, type TTSConfig } from "@marinara-engine/shared";
import type { TTSSpeechInput, TTSSpeechRequest } from "./tts-types.js";

export abstract class BaseTTSProvider {
  constructor(
    protected readonly cfg: TTSConfig,
    protected readonly baseUrl: string,
  ) {}

  /** Pure: builds the request without sending it. */
  abstract buildSpeechRequest(input: TTSSpeechInput): TTSSpeechRequest;

  /** Model id after this backend's aliasing, which the route reports on. */
  resolveModel(): string {
    return this.configuredModel();
  }

  /** Configured model, or the source default when the field was left empty. */
  protected configuredModel(): string {
    return (this.cfg.model || TTS_SOURCE_DEFINITIONS[this.cfg.source].defaultModel).trim();
  }

  /**
   * Response format actually produced. Keyed on the configured source rather
   * than the dispatched provider, because a NanoGPT base URL under an
   * ElevenLabs source still returns MP3.
   */
  protected resolveAudioFormat(): TTSAudioFormat {
    if (this.cfg.source === "elevenlabs" || this.cfg.source === "xai") return "mp3";
    return this.cfg.audioFormat ?? "mp3";
  }
}
