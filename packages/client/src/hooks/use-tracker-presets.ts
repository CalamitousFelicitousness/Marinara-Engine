// ──────────────────────────────────────────────
// Hooks: Tracker Presets (React Query)
// ──────────────────────────────────────────────
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateTrackerPresetInput, TrackerPreset, UpdateTrackerPresetInput } from "@marinara-engine/shared";
import { api } from "../lib/api-client";

const trackerPresetKeys = {
  all: ["tracker-presets"] as const,
  active: ["tracker-presets", "active"] as const,
};

export interface TrackerPresetApplyResult {
  applied: boolean;
  presetId: string | null;
  presetName: string | null;
  characters: number;
  persona: boolean;
}

export function useTrackerPresets() {
  return useQuery({
    queryKey: trackerPresetKeys.all,
    queryFn: () => api.get<TrackerPreset[]>("/tracker-presets"),
  });
}

/** Globally selected preset id. A chat may override it; `null` means none. */
export function useActiveTrackerPresetId() {
  return useQuery({
    queryKey: trackerPresetKeys.active,
    queryFn: async () => (await api.get<{ presetId: string | null }>("/tracker-presets/active")).presetId,
  });
}

export function useSetActiveTrackerPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (presetId: string | null) =>
      api.put<{ presetId: string | null }>("/tracker-presets/active", { presetId }),
    onSuccess: (result) => {
      qc.setQueryData(trackerPresetKeys.active, result.presetId);
    },
  });
}

export function useCreateTrackerPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTrackerPresetInput) => api.post<TrackerPreset>("/tracker-presets", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: trackerPresetKeys.all });
    },
  });
}

export function useUpdateTrackerPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: UpdateTrackerPresetInput & { id: string }) =>
      api.patch<TrackerPreset>(`/tracker-presets/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: trackerPresetKeys.all });
    },
  });
}

export function useDeleteTrackerPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/tracker-presets/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: trackerPresetKeys.all });
      // The server clears the global pointer when the selected preset goes.
      qc.invalidateQueries({ queryKey: trackerPresetKeys.active });
    },
  });
}

/**
 * Stamp a preset into an existing chat's tracker. Additive and idempotent, so
 * the button is safe to press twice. Invalidates nothing itself: the tracker
 * reads game state through its own query, refreshed by the caller.
 */
export function useApplyTrackerPreset() {
  return useMutation({
    mutationFn: (input: { chatId: string; presetId?: string; characters?: boolean; persona?: boolean }) =>
      api.post<TrackerPresetApplyResult>("/tracker-presets/apply", input),
  });
}
