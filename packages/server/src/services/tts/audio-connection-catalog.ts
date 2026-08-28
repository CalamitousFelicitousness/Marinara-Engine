// ──────────────────────────────────────────────
// Audio Connection Catalog
// ──────────────────────────────────────────────
// Model listing and reachability for an audio connection.
//
// The generic connection handlers cannot serve one: they build the catalog URL
// from PROVIDERS[provider].modelsEndpoint, which is empty for audio, and they
// send an ElevenLabs auth header whatever the connection actually targets. So
// audio branches off here, where the source is known.
//
// fetchProviderModels lives in the TTS route module because an upstream-owned
// regression resolves several of its neighbours from there. Importing it back
// is the smaller price: moving it would edit a file that test reads by source
// text.

import { TTS_SOURCES_WITH_MODEL_LISTING, type TTSModelsResponse } from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { fetchProviderModels } from "../../routes/tts.routes.js";
import { safeFetch } from "../../utils/security.js";
import { createAppSettingsStorage } from "../storage/app-settings.storage.js";
import { createConnectionsStorage } from "../storage/connections.storage.js";
import { resolveAudioConfig } from "./audio-config-resolution.js";
import { configuredBaseUrl, optionalBearerHeaders } from "./tts-endpoints.js";
import { ttsUrlPolicy } from "./url-policy.js";

const PROBE_TIMEOUT_MS = 10_000;

export interface AudioConnectionTestResult {
  success: boolean;
  message: string;
  latencyMs: number;
  modelName: string | null;
}

async function resolveForConnection(db: DB, connectionId: string) {
  return resolveAudioConfig(createAppSettingsStorage(db), createConnectionsStorage(db), connectionId);
}

/**
 * Models this audio connection can speak with.
 * An empty list is a valid answer: most sources take a free-text model id, and
 * the editor renders a text field rather than an empty dropdown.
 */
export async function fetchModelsForAudioConnection(db: DB, connectionId: string): Promise<TTSModelsResponse | null> {
  const { cfg, resolvedSource, resolvedConnectionId } = await resolveForConnection(db, connectionId);
  // Resolution falls through to the category default when an id does not name a
  // usable audio row, which would list another connection's models.
  if (resolvedConnectionId !== connectionId) return null;
  if (!TTS_SOURCES_WITH_MODEL_LISTING.includes(resolvedSource)) {
    return { models: [], fromProvider: false, source: resolvedSource };
  }
  return await fetchProviderModels(cfg);
}

/**
 * Checks that the configured endpoint answers.
 *
 * Sources that publish a catalog are verified against it, so the key is
 * exercised too. The rest have no universal catalog, and any HTTP reply counts
 * as reachable: a local engine answering 404 on /models has still proved its
 * address is right, which is the question this button is asked. Synthesis
 * itself is what Test voice checks.
 */
export async function testAudioConnection(db: DB, connectionId: string): Promise<AudioConnectionTestResult | null> {
  const { cfg, resolvedSource, resolvedConnectionId } = await resolveForConnection(db, connectionId);
  if (resolvedConnectionId !== connectionId) return null;

  const start = Date.now();
  const modelName = cfg.model || null;

  if (TTS_SOURCES_WITH_MODEL_LISTING.includes(resolvedSource)) {
    const response = await fetchProviderModels(cfg);
    return {
      success: true,
      message: `${resolvedSource} answered with ${response.models.length} speech model${response.models.length === 1 ? "" : "s"}.`,
      latencyMs: Date.now() - start,
      modelName,
    };
  }

  const base = configuredBaseUrl(cfg);
  try {
    const response = await safeFetch(`${base}/models`, {
      headers: optionalBearerHeaders(cfg.apiKey),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      policy: ttsUrlPolicy(),
      maxResponseBytes: 2 * 1024 * 1024,
    });
    return {
      success: true,
      message: response.ok
        ? `${base} answered. Use Test voice to check synthesis itself.`
        : `${base} is reachable but answered ${response.status} for a model list, which is normal for this source. Use Test voice to check synthesis itself.`,
      latencyMs: Date.now() - start,
      modelName,
    };
  } catch (error) {
    return {
      success: false,
      message: `Could not reach ${base}: ${error instanceof Error ? error.message : "unknown error"}`,
      latencyMs: Date.now() - start,
      modelName,
    };
  }
}
