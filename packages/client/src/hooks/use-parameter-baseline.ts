// ──────────────────────────────────────────────
// React Query: generation parameter baseline
// ──────────────────────────────────────────────
import { useQuery } from "@tanstack/react-query";
import type { GenerationParameterBaseline } from "@marinara-engine/shared";
import { api } from "../lib/api-client";

export interface ParameterBaselineQuery {
  /** The chat whose stored connection, preset and mode apply unless a field below replaces them. */
  chatId?: string | null;
  /** Null asks for no connection; undefined keeps the chat's. */
  connectionId?: string | null;
  promptPresetId?: string | null;
  mode?: string | null;
  /** Only part of the cache key: a scene starting or ending changes the baseline. */
  sceneStatus?: string | null;
}

const QUERY_FIELDS = ["chatId", "connectionId", "promptPresetId", "mode"] as const;

export const parameterBaselineKeys = {
  all: ["parameter-baseline"] as const,
  detail: (query: ParameterBaselineQuery) => [...parameterBaselineKeys.all, query] as const,
};

/** What the layers below a chat resolve to, shown in its Connection state. */
export function useGenerationParameterBaseline(query: ParameterBaselineQuery, enabled = true) {
  return useQuery({
    queryKey: parameterBaselineKeys.detail(query),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      for (const field of QUERY_FIELDS) {
        const value = query[field];
        if (value !== undefined) params.set(field, value ?? "");
      }
      return api.get<GenerationParameterBaseline>(`/generate/parameter-baseline?${params.toString()}`, { signal });
    },
    enabled: enabled && Boolean(query.chatId || (query.connectionId !== undefined && query.mode)),
    staleTime: 30_000,
  });
}
