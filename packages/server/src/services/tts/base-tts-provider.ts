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

import {
  audioParametersFor,
  TTS_SOURCE_DEFINITIONS,
  type TTSAudioFormat,
  type TTSConfig,
} from "@marinara-engine/shared";
import { applyAudioParameters } from "./audio-parameter-merge.js";
import type { TTSSpeechInput, TTSProviderRequest } from "./tts-types.js";

export abstract class BaseTTSProvider {
  constructor(
    protected readonly cfg: TTSConfig,
    protected readonly baseUrl: string,
  ) {}

  /** Pure: builds the request without sending it. */
  abstract buildSpeechRequest(input: TTSSpeechInput): TTSProviderRequest;

  /** Model id after this backend's aliasing, which the route reports on. */
  resolveModel(): string {
    return this.configuredModel();
  }

  /**
   * Body key holding the text to speak. Overridden where a backend names it
   * something else, and read by the parameter merge as the one key a stored
   * parameter may not replace.
   */
  protected contentKey(): string {
    return "input";
  }

  /**
   * Serializes a speech body with this connection's speech parameters merged in.
   * Providers call this instead of JSON.stringify so the merge, and the guard
   * that comes with it, cannot be forgotten by a backend added later.
   *
   * Always the speech lane: sound effects and music are not synthesized through
   * a provider, and their parameters reach the game-audio builder instead.
   */
  protected jsonBody(payload: Record<string, unknown>): string {
    return JSON.stringify(
      applyAudioParameters(payload, audioParametersFor(this.cfg, "speech"), {
        protectedKey: this.contentKey(),
        label: "speech",
      }),
    );
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
