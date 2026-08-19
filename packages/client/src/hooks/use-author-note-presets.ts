// ──────────────────────────────────────────────
// Hooks: Author's Note Presets (React Query)
// ──────────────────────────────────────────────
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AuthorNotePreset } from "@marinara-engine/shared";
import { api } from "../lib/api-client";

const authorNotePresetKeys = {
  all: ["author-note-presets"] as const,
};

export function useAuthorNotePresets() {
  return useQuery({
    queryKey: authorNotePresetKeys.all,
    queryFn: () => api.get<AuthorNotePreset[]>("/author-note-presets"),
  });
}

export function useCreateAuthorNotePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; content?: string; depth?: number }) =>
      api.post<AuthorNotePreset>("/author-note-presets", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: authorNotePresetKeys.all });
    },
  });
}

export function useUpdateAuthorNotePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; name?: string; content?: string; depth?: number }) =>
      api.patch<AuthorNotePreset>(`/author-note-presets/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: authorNotePresetKeys.all });
    },
  });
}

export function useReorderAuthorNotePresets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (presetIds: string[]) =>
      api.put<AuthorNotePreset[]>("/author-note-presets/reorder", { presetIds }),
    onSuccess: (presets) => {
      qc.setQueryData(authorNotePresetKeys.all, presets);
      qc.invalidateQueries({ queryKey: authorNotePresetKeys.all });
    },
  });
}

export function useDeleteAuthorNotePreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/author-note-presets/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: authorNotePresetKeys.all });
    },
  });
}
