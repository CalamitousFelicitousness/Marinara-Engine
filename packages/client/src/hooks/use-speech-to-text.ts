// ──────────────────────────────────────────────
// Hook: Speech to Text server settings
// ──────────────────────────────────────────────
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SpeechToTextConfig } from "@marinara-engine/shared";
import { api } from "../lib/api-client";

const KEYS = {
  config: ["speech-to-text", "config"] as const,
};

export function useSpeechToTextConfig(enabled = true) {
  return useQuery({
    queryKey: KEYS.config,
    queryFn: () => api.get<SpeechToTextConfig>("/speech-to-text/config"),
    staleTime: 60_000,
    enabled,
  });
}

export function useUpdateSpeechToTextConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: SpeechToTextConfig) => api.put<void>("/speech-to-text/config", config),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.config }),
  });
}

/** Sends a short silent clip to the saved server; rejects with the server's reason when it does not answer. */
export function useTestSpeechToText() {
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>("/speech-to-text/test", {}),
  });
}
