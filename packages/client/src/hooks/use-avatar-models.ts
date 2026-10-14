// ──────────────────────────────────────────────
// Hooks: avatar models of the 2D and 3D avatar agents (React Query)
// ──────────────────────────────────────────────
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AVATAR_API_PREFIXES,
  avatarModelPath,
  type AvatarConfig,
  type AvatarConfigUpdate,
  type AvatarImportResult,
  type AvatarKind,
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

/** After any change to an owner's avatar (a save, import, removal or kept generation result): shows the
 *  returned avatar.json at once, then refreshes every avatar query. */
export function useAvatarModelChanged(owner: AvatarOwnerRef, onChanged?: () => void) {
  const qc = useQueryClient();
  return (config: AvatarConfig | null) => {
    qc.setQueryData(avatarModelKeys.detail(owner), config);
    onChanged?.();
    return qc.invalidateQueries({ queryKey: avatarModelKeys.all });
  };
}

/** Saving, importing and removing an owner's avatar, for the owner-wide settings and every kind's panel. */
export function useAvatarModelActions(owner: AvatarOwnerRef, onChanged?: () => void) {
  const changed = useAvatarModelChanged(owner, onChanged);
  const save = useMutation({
    mutationFn: (update: AvatarConfigUpdate) => api.put<AvatarConfig>(avatarModelPath(owner), update),
    onSuccess: (config) => void changed(config),
  });
  const importFile = useMutation({
    mutationFn: ({ kind, file }: { kind: AvatarKind; file: File }) => {
      const form = new FormData();
      form.append("kind", kind);
      form.append("file", file, file.name);
      return api.upload<AvatarImportResult>(`${avatarModelPath(owner)}/import`, form);
    },
    onSuccess: (result) => void changed(result.config),
  });
  const remove = useMutation({
    mutationFn: (kind: AvatarKind) => api.delete<AvatarConfig | null>(`${avatarModelPath(owner)}/kinds/${kind}`),
    onSuccess: (config) => void changed(config),
  });
  return { save, importFile, remove };
}
