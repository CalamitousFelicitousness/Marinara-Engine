// ──────────────────────────────────────────────
// Hook: TTS Config & Voices
// ──────────────────────────────────────────────
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api-client";
import type {
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
  effectiveConfig: (scope: string) => ["tts", "effective-config", scope] as const,
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
 * What a speak request would actually use: app-level settings merged with the
 * resolved audio connection.
 *
 * Omit connectionId for the category default, which is what unattended autoplay
 * reaches. Pass one to ask about a specific connection; the empty string is the
 * sentinel for the app-level settings alone.
 */
export function useEffectiveTTSConfig(connectionId?: string) {
  const scoped = connectionId !== undefined;
  return useQuery({
    queryKey: ttsKeys.effectiveConfig(scoped ? connectionId : "auto"),
    queryFn: () =>
      api.get<TTSEffectiveConfigResponse>(
        `/tts/effective-config${scoped ? `?connectionId=${encodeURIComponent(connectionId)}` : ""}`,
      ),
    staleTime: 60_000,
  });
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
