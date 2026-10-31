// ──────────────────────────────────────────────
// Hook: TTS Config & Voices
// ──────────────────────────────────────────────
import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "../lib/api-client";
import type {
  GameAudioPurpose,
  TTSConfig,
  TTSEffectiveConfigResponse,
  TTSModelsResponse,
  TTSVoiceAssignmentInput,
  TTSVoiceModeInput,
  TTSVoicesResponse,
  TTSSource,
} from "@marinara-engine/shared";
import { TTS_API_KEY_MASK, TTS_SOURCES_WITH_MODEL_LISTING } from "@marinara-engine/shared";

export const ttsKeys = {
  /** Everything TTS. Connection mutations invalidate this: they change catalogs and resolution. */
  all: ["tts"] as const,
  config: ["tts", "config"] as const,
  effectiveConfig: (scope: string) => ["tts", "effective-config", scope] as const,
  effectiveRequest: (scope: string) => ["tts", "effective-request", scope] as const,
  gameAudioLane: (purpose: GameAudioPurpose, scope: string) => ["tts", "game-audio-lane", purpose, scope] as const,
  voices: (source: TTSSource, scope: string) => ["tts", "voices", source, scope] as const,
  models: (source: TTSSource, scope: string) => ["tts", "models", source, scope] as const,
};

/**
 * Which provider a catalog belongs to.
 *
 * A connection id lists that connection's catalog. Without one the endpoint
 * serves the app-level settings, whose identity for caching purposes is its
 * base URL, since it has no id.
 */
export interface TTSCatalogScope {
  connectionId?: string;
  baseUrl?: string;
  /**
   * Ask about this model rather than the saved one. Sources that publish voices
   * per model answer differently for each, so the picker would otherwise keep
   * showing the previous model's voices until the connection was saved.
   */
  model?: string;
}

/** What the catalog belongs to. Empty means nothing to ask about, which gates the query. */
const scopeIdentity = (scope: TTSCatalogScope) => scope.connectionId ?? scope.baseUrl ?? "";
const scopeKey = (scope: TTSCatalogScope) => `${scopeIdentity(scope)}\n${scope.model ?? ""}`;
const scopeQuery = (scope: TTSCatalogScope) => {
  const params = new URLSearchParams();
  if (scope.connectionId) params.set("connectionId", scope.connectionId);
  if (scope.model) params.set("model", scope.model);
  const query = params.toString();
  return query ? `?${query}` : "";
};

// ── Config ───────────────────────────────────────

export function useTTSConfig() {
  return useQuery({
    queryKey: ttsKeys.config,
    queryFn: () => api.get<TTSConfig>("/tts/config"),
    staleTime: 60_000,
  });
}

/**
 * Which engine a speak request reaches, and with which settings: app-level
 * settings merged with the connection that resolved.
 *
 * Omit connectionId for the default chain, which is what an unattended request
 * reaches. Pass one to ask about a specific connection; the empty string is the
 * sentinel for the app-level settings alone.
 */
export function useEffectiveTTSConfig(connectionId?: string) {
  const scoped = connectionId !== undefined;
  return useQuery({
    queryKey: ttsKeys.effectiveConfig(scoped ? connectionId : "auto"),
    queryFn: () =>
      api.get<TTSEffectiveConfigResponse>(
        `/tts/effective-config${scoped ? `?${new URLSearchParams({ connectionId })}` : ""}`,
      ),
    staleTime: 60_000,
  });
}

export interface GameAudioLaneReadiness {
  /** The Music & Sound Effects connection that answers for this lane, or null when none does. */
  connectionId: string | null;
  /** Whether that connection may generate for this lane and holds a usable key. */
  enabled: boolean;
}

/**
 * Which Music & Sound Effects connection a sound-effect or music request would reach.
 * Pass a pinned id to ask about it; one saved before the split resolves to its split.
 */
export function useGameAudioLaneReadiness(purpose: GameAudioPurpose, connectionId?: string | null) {
  return useQuery({
    queryKey: ttsKeys.gameAudioLane(purpose, connectionId || "auto"),
    queryFn: async (): Promise<GameAudioLaneReadiness> => {
      const params = new URLSearchParams({ kind: purpose });
      if (connectionId) params.set("audioConnectionId", connectionId);
      const answer = await api.get<{ connectionId: string | null; music: boolean; soundEffects: boolean }>(
        `/audio/config?${params}`,
      );
      return { connectionId: answer.connectionId, enabled: purpose === "music" ? answer.music : answer.soundEffects };
    },
    staleTime: 60_000,
  });
}

/** The request body a lane would send, built and not sent, with the key masked. */
export interface TTSEffectiveRequestResponse {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  multipart: boolean;
  resolvedConnectionId: string | null;
  resolvedConnectionName: string | null;
  resolvedSource: TTSSource;
}

/**
 * What this connection would actually send. Enabled only when asked for, since
 * it describes the SAVED row: an unsaved parameter is not in it yet, and the
 * editor says so rather than showing a stale body as though it were current.
 */
export function useEffectiveAudioRequest(connectionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ttsKeys.effectiveRequest(connectionId),
    queryFn: () =>
      api.get<TTSEffectiveRequestResponse>(`/tts/effective-request?${new URLSearchParams({ connectionId })}`),
    enabled: enabled && Boolean(connectionId),
    staleTime: 0,
  });
}

export function useUpdateTTSConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: TTSConfig) => api.put<void>("/tts/config", config),
    onSuccess: () => {
      // Playback settings feed the merged view, so it goes stale with them.
      qc.invalidateQueries({ queryKey: ttsKeys.all });
    },
  });
}

/** Cast edits land on the speaking connection, so its row goes stale with the merged view. */
function invalidateSpeakingCast(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ttsKeys.all });
  // connectionKeys.all; importing it would cycle with use-connections.
  qc.invalidateQueries({ queryKey: ["connections"] });
}

/** Sets or clears one character's voice in the speaking cast, leaving every other TTS setting as stored. */
export function useUpdateTTSVoiceAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TTSVoiceAssignmentInput) => api.put<void>("/tts/config/voice-assignment", input),
    onSuccess: () => invalidateSpeakingCast(qc),
  });
}

/** Switches the speaking cast between one shared voice and a voice per character, leaving every other TTS setting as stored. */
export function useUpdateTTSVoiceMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TTSVoiceModeInput) => api.put<void>("/tts/config/voice-mode", input),
    onSuccess: () => invalidateSpeakingCast(qc),
  });
}

// ── Voices ───────────────────────────────────────

export function useTTSVoices(source: TTSSource, scope: TTSCatalogScope, enabled: boolean) {
  return useQuery({
    queryKey: ttsKeys.voices(source, scopeKey(scope)),
    queryFn: () => api.get<TTSVoicesResponse>(`/tts/voices${scopeQuery(scope)}`),
    enabled: enabled && Boolean(scopeIdentity(scope)),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function useTTSModels(source: TTSSource, scope: TTSCatalogScope, enabled: boolean) {
  return useQuery({
    // The model list does not vary by model, so it keys on identity alone and a
    // model change does not refetch it.
    queryKey: ttsKeys.models(source, scopeIdentity(scope)),
    queryFn: () => api.get<TTSModelsResponse>(`/tts/models${scopeQuery({ connectionId: scope.connectionId })}`),
    // Derived, not a source literal: the editor decides whether to render a model
    // dropdown from the same list, and a gate that disagrees with it leaves the
    // dropdown permanently on its fallback entries.
    enabled: enabled && TTS_SOURCES_WITH_MODEL_LISTING.includes(source) && Boolean(scopeIdentity(scope)),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

// ── Speak (fire-and-forget mutation used by tts-service) ─────────────────

export { TTS_API_KEY_MASK };
