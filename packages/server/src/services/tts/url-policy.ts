// ──────────────────────────────────────────────
// TTS Outbound URL Policy
// ──────────────────────────────────────────────
// One policy for every TTS request. Previously each call site spelled its own:
// /speak used pockettts-bypass-or-flag, the PocketTTS probe hardcoded
// allowLocal, and xAI voice listing hardcoded never-local while still naming
// TTS_LOCAL_URLS_ENABLED in its rejection message.
//
// Loopback is allowed for every source, matching llmFetch (base-provider.ts).
// docs/CONFIGURATION.md already promises "loopback provider addresses stay
// allowed so local model servers keep working"; TTS was the outlier that made a
// localhost engine need a flag no LLM server needs. TTS_LOCAL_URLS_ENABLED
// still gates private and LAN addresses.
//
// Kept separate from PROVIDER_LOCAL_URLS_ENABLED: that flag auto-enables on
// Android for LLM providers, and inheriting it here would silently widen TTS.

import { TTS_SOURCE_DEFINITIONS, type TTSSource } from "@marinara-engine/shared";
import { isTtsLocalUrlsEnabled } from "../../config/runtime-config.js";
import type { OutboundUrlPolicy } from "../../utils/security.js";

export const TTS_LOCAL_URLS_FLAG = "TTS_LOCAL_URLS_ENABLED";

export function ttsUrlPolicy(source: TTSSource): OutboundUrlPolicy {
  return {
    allowLocal: TTS_SOURCE_DEFINITIONS[source].localByDefault || isTtsLocalUrlsEnabled(),
    allowLoopback: true,
    allowMdns: true,
    allowedProtocols: ["https:", "http:"],
    flagName: TTS_LOCAL_URLS_FLAG,
  };
}
