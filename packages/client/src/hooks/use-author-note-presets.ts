// ──────────────────────────────────────────────
// Hooks: Author's Note Presets (React Query)
// ──────────────────────────────────────────────
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AuthorNotePreset, AuthorNotePresetSet } from "@marinara-engine/shared";
import { api } from "../lib/api-client";

const authorNotePresetKeys = {
  all: ["author-note-presets"] as const,
};

// Own root, so preset invalidations do not refetch sets by prefix match.
const authorNotePresetSetKeys = {
  all: ["author-note-preset-sets"] as const,
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
    mutationFn: (presetIds: string[]) => api.put<AuthorNotePreset[]>("/author-note-presets/reorder", { presetIds }),
    onSuccess: (presets) => {
      qc.setQueryData(authorNotePresetKeys.all, presets);
      qc.invalidateQueries({ queryKey: authorNotePresetKeys.all });
    },
  });
}

export function useAuthorNotePresetSets() {
  return useQuery({
    queryKey: authorNotePresetSetKeys.all,
    queryFn: () => api.get<AuthorNotePresetSet[]>("/author-note-presets/sets"),
  });
}

/** Replaces the whole list. Optimistic, so back-to-back edits build on each other. */
export function useSaveAuthorNotePresetSets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sets: AuthorNotePresetSet[]) => api.put<AuthorNotePresetSet[]>("/author-note-presets/sets", sets),
    onMutate: async (sets) => {
      await qc.cancelQueries({ queryKey: authorNotePresetSetKeys.all });
      qc.setQueryData(authorNotePresetSetKeys.all, sets);
    },
    onSuccess: (saved) => {
      qc.setQueryData(authorNotePresetSetKeys.all, saved);
    },
    onError: () => {
      qc.invalidateQueries({ queryKey: authorNotePresetSetKeys.all });
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
