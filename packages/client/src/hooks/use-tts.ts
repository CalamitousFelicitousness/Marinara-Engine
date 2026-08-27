// ──────────────────────────────────────────────
// Hook: TTS Config & Voices
// ──────────────────────────────────────────────
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api-client";
import type { TTSConfig, TTSModelsResponse, TTSVoicesResponse, TTSSource } from "@marinara-engine/shared";
import { TTS_API_KEY_MASK, TTS_SOURCES_WITH_MODEL_LISTING } from "@marinara-engine/shared";

const KEYS = {
  config: ["tts", "config"] as const,
  voices: (source: TTSSource, baseUrl: string) => ["tts", "voices", source, baseUrl] as const,
  models: (source: TTSSource, baseUrl: string) => ["tts", "models", source, baseUrl] as const,
};

// ── Config ───────────────────────────────────────

export function useTTSConfig() {
  return useQuery({
    queryKey: KEYS.config,
    queryFn: () => api.get<TTSConfig>("/tts/config"),
    staleTime: 60_000,
  });
}

export function useUpdateTTSConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: TTSConfig) => api.put<void>("/tts/config", config),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.config });
      qc.invalidateQueries({ queryKey: ["tts", "voices"] });
      qc.invalidateQueries({ queryKey: ["tts", "models"] });
    },
  });
}

// ── Voices ───────────────────────────────────────

export function useTTSVoices(source: TTSSource, baseUrl: string, enabled: boolean) {
  return useQuery({
    queryKey: KEYS.voices(source, baseUrl),
    queryFn: () => api.get<TTSVoicesResponse>("/tts/voices"),
    enabled: enabled && Boolean(baseUrl),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useTTSModels(source: TTSSource, baseUrl: string, enabled: boolean) {
  return useQuery({
    queryKey: KEYS.models(source, baseUrl),
    queryFn: () => api.get<TTSModelsResponse>("/tts/models"),
    // Derived, not a source literal: the card decides whether to render a model
    // dropdown from the same list, and a gate that disagrees with it leaves the
    // dropdown permanently on its fallback entries.
    enabled: enabled && TTS_SOURCES_WITH_MODEL_LISTING.includes(source) && Boolean(baseUrl),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

// ── Speak (fire-and-forget mutation used by tts-service) ─────────────────

export { TTS_API_KEY_MASK };
