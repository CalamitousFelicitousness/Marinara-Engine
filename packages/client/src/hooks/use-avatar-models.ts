// ──────────────────────────────────────────────
// Hooks: avatar models of the 2D and 3D avatar agents (React Query)
// ──────────────────────────────────────────────
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AVATAR_API_PREFIXES,
  avatarModelPath,
  type AvatarConfig,
  type AvatarConfigUpdate,
  type AvatarOwnerRef,
  type AvatarOwnerSummary,
} from "@marinara-engine/shared";
import { avatarModelKeys } from "../features/avatars/contract";
import { ApiError, api } from "../lib/api-client";

/** Who has an avatar (without the per-kind data). */
export function useAvatarModelList(enabled = true) {
  return useQuery({
    queryKey: avatarModelKeys.list(),
    queryFn: () => api.get<AvatarOwnerSummary[]>(AVATAR_API_PREFIXES.models),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function fetchAvatarModel(owner: AvatarOwnerRef): Promise<AvatarConfig | null> {
  return api.get<AvatarConfig>(avatarModelPath(owner)).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
}

/** One owner's avatar.json, or null when the owner has none. */
export function useAvatarModel(owner: AvatarOwnerRef | null) {
  return useQuery({
    queryKey: owner ? avatarModelKeys.detail(owner) : [...avatarModelKeys.all, "none"],
    queryFn: () => fetchAvatarModel(owner!),
    enabled: owner !== null,
    staleTime: 5 * 60_000,
  });
}

/** Owner-wide settings (on/off, shown kind, movement switches). The kind setup panels import and remove. */
export function useUpdateAvatarModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ owner, update }: { owner: AvatarOwnerRef; update: AvatarConfigUpdate }) =>
      api.put<AvatarConfig>(avatarModelPath(owner), update),
    onSuccess: () => qc.invalidateQueries({ queryKey: avatarModelKeys.all }),
  });
}
