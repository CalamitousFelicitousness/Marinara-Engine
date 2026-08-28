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
}

const scopeKey = (scope: TTSCatalogScope) => scope.connectionId ?? scope.baseUrl ?? "";
const scopeQuery = (scope: TTSCatalogScope) =>
  scope.connectionId ? `?connectionId=${encodeURIComponent(scope.connectionId)}` : "";

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
    enabled: enabled && Boolean(scopeKey(scope)),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useTTSModels(source: TTSSource, scope: TTSCatalogScope, enabled: boolean) {
  return useQuery({
    queryKey: ttsKeys.models(source, scopeKey(scope)),
    queryFn: () => api.get<TTSModelsResponse>(`/tts/models${scopeQuery(scope)}`),
    // Derived, not a source literal: the editor decides whether to render a model
    // dropdown from the same list, and a gate that disagrees with it leaves the
    // dropdown permanently on its fallback entries.
    enabled: enabled && TTS_SOURCES_WITH_MODEL_LISTING.includes(source) && Boolean(scopeKey(scope)),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

// ── Speak (fire-and-forget mutation used by tts-service) ─────────────────

export { TTS_API_KEY_MASK };
