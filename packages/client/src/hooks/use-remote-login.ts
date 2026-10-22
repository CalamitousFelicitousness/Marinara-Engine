// ──────────────────────────────────────────────
// React Query: remote login, signed-in devices and pairing codes
// ──────────────────────────────────────────────
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api-client";

export type RemoteSession = { id: string; label: string; createdAt: number; lastSeenAt: number; current: boolean };
export type PairingCode = { code: string; expiresAt: number };

const sessionsKey = ["access-sessions"] as const;

export function useRemoteSessions(enabled: boolean) {
  return useQuery({
    queryKey: sessionsKey,
    queryFn: () => api.get<{ sessions: RemoteSession[] }>("/access/sessions").then((body) => body.sessions),
    enabled,
    retry: false,
  });
}

/** A login change also changes who is signed in and why devices were refused. */
function useLoginMutation<T>(mutationFn: (input: T) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["access-status"] }),
        qc.invalidateQueries({ queryKey: sessionsKey }),
        qc.invalidateQueries({ queryKey: ["access-refusals"] }),
      ]);
    },
  });
}

export const useSetRemoteLogin = () =>
  useLoginMutation((body: { user: string; password: string }) => api.put("/access/login", body));

export const useRemoveRemoteLogin = () => useLoginMutation(() => api.delete("/access/login"));

export const useEndSession = () =>
  useLoginMutation((id: string) => api.delete(`/access/sessions/${encodeURIComponent(id)}`));

export const useEndOtherSessions = () => useLoginMutation(() => api.delete("/access/sessions"));

export function useCreatePairingCode() {
  return useMutation({ mutationFn: () => api.post<PairingCode>("/access/pairing-codes") });
}
