// ──────────────────────────────────────────────
// Hook: TTS Config & Voices
// ──────────────────────────────────────────────
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api-client";
import type {
  AudioPurpose,
  TTSConfig,
  TTSEffectiveConfigResponse,
  TTSModelsResponse,
  TTSVoicesResponse,
  TTSSource,
} from "@marinara-engine/shared";
import { TTS_API_KEY_MASK, TTS_SOURCES_WITH_MODEL_LISTING } from "@marinara-engine/shared";

export const ttsKeys = {
  /** Everything TTS. Connection mutations invalidate this: they change catalogs and resolution. */
  all: ["tts"] as const,
  config: ["tts", "config"] as const,
  effectiveConfig: (purpose: AudioPurpose, scope: string) => ["tts", "effective-config", purpose, scope] as const,
  voices: (source: TTSSource, scope: string) => ["tts", "voices", source, scope] as const,
  models: (source: TTSSource, scope: string) => ["tts", "models", source, scope] as const,
};

/**
 * Which provider a catalog belongs to.
 *
 * A connection id lists that connection's catalog. Without one the endpoint
 * serves the app-level settings, whose identity for caching purposes is its
 * base URL, since it has no id.
 */
export interface TTSCatalogScope {
  connectionId?: string;
  baseUrl?: string;
  /**
   * Ask about this model rather than the saved one. Sources that publish voices
   * per model answer differently for each, so the picker would otherwise keep
   * showing the previous model's voices until the connection was saved.
   */
  model?: string;
}

/** What the catalog belongs to. Empty means nothing to ask about, which gates the query. */
const scopeIdentity = (scope: TTSCatalogScope) => scope.connectionId ?? scope.baseUrl ?? "";
const scopeKey = (scope: TTSCatalogScope) => `${scopeIdentity(scope)}\n${scope.model ?? ""}`;
const scopeQuery = (scope: TTSCatalogScope) => {
  const params = new URLSearchParams();
  if (scope.connectionId) params.set("connectionId", scope.connectionId);
  if (scope.model) params.set("model", scope.model);
  const query = params.toString();
  return query ? `?${query}` : "";
};

// ── Config ───────────────────────────────────────

export function useTTSConfig() {
  return useQuery({
    queryKey: ttsKeys.config,
    queryFn: () => api.get<TTSConfig>("/tts/config"),
    staleTime: 60_000,
  });
}

/**
 * Which engine answers for one purpose, and with which settings: app-level
 * settings merged with the connection that resolved.
 *
 * Omit connectionId for the category chain, which is what an unattended request
 * reaches. Pass one to ask about a specific connection; the empty string is the
 * sentinel for the app-level settings alone.
 *
 * Purposes are separate cache entries because they resolve to different
 * connections. A speech request sends no purpose parameter, so its URL is the
 * one the server has always answered.
 */
export function useEffectiveAudioConfig(purpose: AudioPurpose, connectionId?: string) {
  const scoped = connectionId !== undefined;
  return useQuery({
    queryKey: ttsKeys.effectiveConfig(purpose, scoped ? connectionId : "auto"),
    queryFn: () => {
      const params = new URLSearchParams();
      if (scoped) params.set("connectionId", connectionId);
      if (purpose !== "speech") params.set("purpose", purpose);
      const query = params.toString();
      return api.get<TTSEffectiveConfigResponse>(`/tts/effective-config${query ? `?${query}` : ""}`);
    },
    staleTime: 60_000,
  });
}

/** What a speak request would use. The speech lane of {@link useEffectiveAudioConfig}. */
export function useEffectiveTTSConfig(connectionId?: string) {
  return useEffectiveAudioConfig("speech", connectionId);
}

export function useUpdateTTSConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: TTSConfig) => api.put<void>("/tts/config", config),
    onSuccess: () => {
      // Playback settings feed the merged view, so it goes stale with them.
      qc.invalidateQueries({ queryKey: ttsKeys.all });
    },
  });
}

// ── Voices ───────────────────────────────────────

export function useTTSVoices(source: TTSSource, scope: TTSCatalogScope, enabled: boolean) {
  return useQuery({
    queryKey: ttsKeys.voices(source, scopeKey(scope)),
    queryFn: () => api.get<TTSVoicesResponse>(`/tts/voices${scopeQuery(scope)}`),
    enabled: enabled && Boolean(scopeIdentity(scope)),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useTTSModels(source: TTSSource, scope: TTSCatalogScope, enabled: boolean) {
  return useQuery({
    // The model list does not vary by model, so it keys on identity alone and a
    // model change does not refetch it.
    queryKey: ttsKeys.models(source, scopeIdentity(scope)),
    queryFn: () => api.get<TTSModelsResponse>(`/tts/models${scopeQuery({ connectionId: scope.connectionId })}`),
    // Derived, not a source literal: the editor decides whether to render a model
    // dropdown from the same list, and a gate that disagrees with it leaves the
    // dropdown permanently on its fallback entries.
    enabled: enabled && TTS_SOURCES_WITH_MODEL_LISTING.includes(source) && Boolean(scopeIdentity(scope)),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

// ── Speak (fire-and-forget mutation used by tts-service) ─────────────────

export { TTS_API_KEY_MASK };
