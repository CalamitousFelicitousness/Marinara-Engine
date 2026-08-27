// ──────────────────────────────────────────────
// TTS Provider Registry
// ──────────────────────────────────────────────
// An explicit switch, the same shape as createLLMProvider in
// services/llm/provider-registry.ts. Not a plugin map: a handful of backends do
// not need a registration mechanism, and the switch is the thing a reader can
// follow.
//
// A backend costs one provider file and one case here. Everything downstream
// (URL, headers, body, text preparation, speed) comes from the provider, so
// none of it can drift out of step with the others.

import type { TTSConfig } from "@marinara-engine/shared";
import { BaseTTSProvider } from "./base-tts-provider.js";
import { ElevenLabsTTSProvider } from "./elevenlabs.provider.js";
import { NanoGptTTSProvider, OpenAITTSProvider } from "./openai.provider.js";
import { PocketTtsProvider, type PocketTtsApiMode } from "./pockettts.provider.js";
import { XaiTTSProvider } from "./xai.provider.js";
import { configuredBaseUrl, isNanoGptBaseUrl } from "./tts-endpoints.js";

export interface CreateTTSProviderOptions {
  /** Probed by the caller, since detection needs a request and providers do no I/O. */
  pocketTtsMode?: PocketTtsApiMode;
}

export function createTTSProvider(cfg: TTSConfig, options: CreateTTSProviderOptions = {}): BaseTTSProvider {
  const baseUrl = configuredBaseUrl(cfg);

  // Base URL wins over the configured source, so a NanoGPT URL saved under an
  // ElevenLabs or OpenAI source keeps sending NanoGPT-shaped requests. That was
  // the only way to reach NanoGPT before it had a source of its own, and those
  // configs still exist; dispatching on cfg.source alone would break them.
  if (isNanoGptBaseUrl(baseUrl)) return new NanoGptTTSProvider(cfg, baseUrl);

  switch (cfg.source) {
    case "elevenlabs":
      return new ElevenLabsTTSProvider(cfg, baseUrl);
    case "nanogpt":
      // Reached when the base URL was changed to a proxy or a self-hosted
      // gateway; the detection above covers nano-gpt.com itself.
      return new NanoGptTTSProvider(cfg, baseUrl);
    case "pockettts":
      return new PocketTtsProvider(cfg, baseUrl, options.pocketTtsMode ?? "openai");
    case "xai":
      return new XaiTTSProvider(cfg, baseUrl);
    case "openai":
    default:
      return new OpenAITTSProvider(cfg, baseUrl);
  }
}
