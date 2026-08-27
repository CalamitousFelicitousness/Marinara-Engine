// ──────────────────────────────────────────────
// TTS Provider Registry
// ──────────────────────────────────────────────
// An explicit switch, the same shape as createLLMProvider in
// services/llm/provider-registry.ts. Not a plugin map: four backends do not
// need a registration mechanism, and the switch is the thing a reader can
// follow.
//
// Adding a backend means one provider file and one case here, instead of the
// five parallel ternary chains this replaced (URL, headers, body, text
// preparation, and speed inclusion), which had to be edited in lockstep.

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

  // Base URL wins over the configured source. A NanoGPT URL under an ElevenLabs
  // source has always sent NanoGPT-shaped requests, and existing setups rely on
  // it; dispatching on cfg.source alone would break them silently.
  if (isNanoGptBaseUrl(baseUrl)) return new NanoGptTTSProvider(cfg, baseUrl);

  switch (cfg.source) {
    case "elevenlabs":
      return new ElevenLabsTTSProvider(cfg, baseUrl);
    case "pockettts":
      return new PocketTtsProvider(cfg, baseUrl, options.pocketTtsMode ?? "openai");
    case "xai":
      return new XaiTTSProvider(cfg, baseUrl);
    case "openai":
    default:
      return new OpenAITTSProvider(cfg, baseUrl);
  }
}
