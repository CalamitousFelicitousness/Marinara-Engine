// ──────────────────────────────────────────────
// Hook: speak one chat message aloud on demand
// ──────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Message } from "@marinara-engine/shared";
import { useEffectiveTTSConfig } from "./use-tts";
import { ttsService } from "../lib/tts-service";
import { resolveTTSSynthesisPolicy } from "../lib/tts-synthesis-policy";
import {
  buildTTSVoiceRequests,
  findTTSCharacterIdBySpeakerName,
  getTTSPersonaVoice,
  isTTSSpeakerAmbiguous,
  resolveTTSMessagePersona,
  withTTSVoiceRequestCacheKeys,
} from "../lib/tts-dialogue";
import { useUIStore } from "../stores/ui.store";
import type { CharacterMap, PersonaInfo } from "../components/chat/chat-area.types";

type SpeakableMessage = Pick<Message, "id" | "chatId" | "role" | "characterId" | "content"> & { extra?: unknown };

/**
 * The Speak button of a message: the same voices, connection and cache keys as autoplay (ChatArea), so a message that
 * autoplayed replays from cache. `enabled` is false while text to speech is off, and the button stays hidden.
 */
export function useMessageSpeech(message: SpeakableMessage, characterMap?: CharacterMap, personaInfo?: PersonaInfo) {
  const { data: effectiveTts } = useEffectiveTTSConfig();
  const ttsConfig = effectiveTts?.config;
  const audioConnectionId = effectiveTts?.resolvedConnectionId ?? null;
  const enabled = effectiveTts?.speechEnabled ?? false;
  const ttsLineVolume = useUIStore((s) => s.ttsLineVolume);
  const persona = useMemo(
    () => resolveTTSMessagePersona(message as Parameters<typeof resolveTTSMessagePersona>[0], personaInfo),
    [message, personaInfo],
  );

  const requests = useMemo(() => {
    if (!enabled || !ttsConfig) return [];
    const ownUserMessage = message.role === "user";
    const mappedUserPersona = ownUserMessage && getTTSPersonaVoice(ttsConfig, persona);
    const fallbackSpeaker = mappedUserPersona
      ? persona?.name
      : message.role === "narrator"
        ? "Narrator"
        : message.characterId
          ? characterMap?.get(message.characterId)?.name
          : undefined;
    const fallbackId = ownUserMessage ? (mappedUserPersona ? persona?.id : undefined) : message.characterId;
    const built = buildTTSVoiceRequests(
      message.content,
      ttsConfig,
      fallbackSpeaker,
      fallbackId,
      (speaker) => findTTSCharacterIdBySpeakerName(speaker, characterMap ?? [], persona),
      {
        fastFirstChunk: ttsConfig.progressivePlayback,
        persona: ownUserMessage && !mappedUserPersona ? undefined : persona,
        isAmbiguousSpeaker: (speaker) => isTTSSpeakerAmbiguous(speaker, characterMap ?? [], persona),
      },
    );
    return withTTSVoiceRequestCacheKeys(built, ttsConfig, message.id, audioConnectionId);
  }, [
    audioConnectionId,
    characterMap,
    enabled,
    message.characterId,
    message.content,
    message.id,
    message.role,
    persona,
    ttsConfig,
  ]);

  const [state, setState] = useState(ttsService.getState());
  const [activeId, setActiveId] = useState<string | null>(ttsService.getActiveId());
  useEffect(
    () =>
      ttsService.subscribe((next, id) => {
        setState(next);
        setActiveId(id);
      }),
    [],
  );
  const speaking = activeId === message.id;
  const loading = speaking && state === "loading";
  const busyElsewhere =
    !speaking && (state === "loading" || state === "playing" || state === "paused" || state === "blocked");

  const toggle = useCallback(() => {
    // Read the singleton, never stale React state.
    const liveState = ttsService.getState();
    const liveIsThis = ttsService.getActiveId() === message.id;
    const liveBusy =
      liveState === "loading" || liveState === "playing" || liveState === "paused" || liveState === "blocked";
    if (liveIsThis) {
      ttsService.stop();
      return;
    }
    if (liveBusy || requests.length === 0) return;
    void ttsService.speakSequence(requests, message.id, {
      chatId: message.chatId,
      progressive: ttsConfig?.progressivePlayback,
      concurrency: ttsConfig?.generationConcurrency,
      policy: resolveTTSSynthesisPolicy(ttsConfig),
      volume: ttsLineVolume / 100,
      audioConnectionId: audioConnectionId ?? undefined,
    });
  }, [audioConnectionId, message.chatId, message.id, requests, ttsConfig, ttsLineVolume]);

  return { enabled, hasContent: requests.length > 0, speaking, loading, busyElsewhere, toggle };
}
