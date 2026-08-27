// ──────────────────────────────────────────────
// TTS Outbound URL Policy
// ──────────────────────────────────────────────
// The single policy for every TTS fetch: /speak, the PocketTTS probe, and the
// ElevenLabs and xAI listings.
//
// The base URL is operator provenance, typed into the TTS card, so
// isTtsLocalUrlsEnabled() is default-on. TTS_LOCAL_URLS_ENABLED=false denies
// private and LAN addresses, for a server reachable past loopback.
//
// Source-independent: no source may widen the policy, or the opt-out would be
// partial and an operator who hardened the install would keep LAN reach through
// whichever source was exempt.
//
// Loopback and mDNS are unconditional, matching llmFetch (base-provider.ts), so
// hardening never breaks a localhost engine.
//
// Separate from PROVIDER_LOCAL_URLS_ENABLED so either subsystem can be hardened
// alone. They share a default, not a mechanism.

import { isTtsLocalUrlsEnabled } from "../../config/runtime-config.js";
import type { OutboundUrlPolicy } from "../../utils/security.js";

export const TTS_LOCAL_URLS_FLAG = "TTS_LOCAL_URLS_ENABLED";

export function ttsUrlPolicy(): OutboundUrlPolicy {
  return {
    allowLocal: isTtsLocalUrlsEnabled(),
    allowLoopback: true,
    allowMdns: true,
    allowedProtocols: ["https:", "http:"],
    flagName: TTS_LOCAL_URLS_FLAG,
  };
}
