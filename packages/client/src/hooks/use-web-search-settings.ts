import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WebSearchSettings, WebSearchTestResult } from "@marinara-engine/shared";
import { api } from "../lib/api-client";

const webSearchKey = ["web-search-settings"] as const;

/** The server-wide web search engine; reading it is privileged. */
export function useWebSearchSettings() {
  return useQuery({ queryKey: webSearchKey, queryFn: () => api.get<WebSearchSettings>("/admin/web-search") });
}

export function useSaveWebSearchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: WebSearchSettings) => api.put<WebSearchSettings>("/admin/web-search", values),
    onSuccess: (values) => qc.setQueryData(webSearchKey, values),
  });
}

/** Runs one search with the given values, saved or not. */
export function useTestWebSearch() {
  return useMutation({
    mutationFn: (values: WebSearchSettings) => api.post<WebSearchTestResult>("/admin/web-search/test", values),
  });
}
