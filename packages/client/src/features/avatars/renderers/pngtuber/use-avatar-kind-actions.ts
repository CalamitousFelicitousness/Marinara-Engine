// Save, import and remove one kind of an owner's avatar (lane: 2D, shared by the PNGTuber and mesh avatar
// setup panels). Every change refreshes the avatar queries and tells the setup to reload.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  avatarModelPath,
  type AvatarConfig,
  type AvatarConfigUpdate,
  type AvatarImportResult,
  type AvatarKind,
  type AvatarOwnerRef,
} from "@marinara-engine/shared";
import { api } from "../../../../lib/api-client";
import { avatarModelKeys } from "../../contract";

export function useAvatarKindActions(owner: AvatarOwnerRef, kind: AvatarKind, onChanged: () => void) {
  const queryClient = useQueryClient();
  const changed = () => {
    void queryClient.invalidateQueries({ queryKey: avatarModelKeys.all });
    onChanged();
  };
  const save = useMutation({
    mutationFn: (update: AvatarConfigUpdate) => api.put<AvatarConfig>(avatarModelPath(owner), update),
    onSuccess: changed,
  });
  const importFile = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("kind", kind);
      form.append("file", file, file.name);
      return api.upload<AvatarImportResult>(`${avatarModelPath(owner)}/import`, form);
    },
    onSuccess: changed,
  });
  const remove = useMutation({
    mutationFn: () => api.delete<AvatarConfig | null>(`${avatarModelPath(owner)}/kinds/${kind}`),
    onSuccess: changed,
  });
  return { save, importFile, remove };
}
