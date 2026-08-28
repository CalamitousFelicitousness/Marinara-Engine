// ──────────────────────────────────────────────
// Audio Purposes
// ──────────────────────────────────────────────
// The routing lanes an audio connection answers for. Each purpose resolves on
// its own: explicit connection id, then the purpose's default/fallback pair,
// then the base audio pair (defaultForAgents/fallbackForAgents), then the
// app-level TTS settings. A purpose with no pair of its own therefore behaves
// exactly like the base pair, which is what keeps an untouched install routing
// every lane to one engine.
//
// Purpose ids double as the /tts/game-audio `kind` wire values, so a generation
// request names its own lane.

export const AUDIO_PURPOSES = ["speech", "sfx", "music"] as const;
export type AudioPurpose = (typeof AUDIO_PURPOSES)[number];

/** Purposes /tts/game-audio serves. Speech is synthesized through /tts/speak. */
export const GAME_AUDIO_PURPOSES = ["sfx", "music"] as const;
export type GameAudioPurpose = (typeof GAME_AUDIO_PURPOSES)[number];

export function isGameAudioPurpose(purpose: AudioPurpose): purpose is GameAudioPurpose {
  return purpose !== "speech";
}

/** Chat metadata keys a game reads its audio pins from. Values are ids or absent. */
export interface GameAudioPinMetadata {
  /** All-purpose pin: answers every lane no purpose pin names. */
  gameAudioConnectionId?: unknown;
  gameVoiceConnectionId?: unknown;
  gameSfxConnectionId?: unknown;
  gameMusicConnectionId?: unknown;
}

const GAME_AUDIO_PIN_KEYS: Record<AudioPurpose, keyof GameAudioPinMetadata> = {
  speech: "gameVoiceConnectionId",
  sfx: "gameSfxConnectionId",
  music: "gameMusicConnectionId",
};

/** Metadata arrives as untyped JSON, so anything but a non-empty string is unset. */
function readPin(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The connection a game pinned for one purpose: the purpose pin, else the
 * all-purpose pin, else undefined so the server resolves the category chain.
 * One definition because the wizard, the drawer, and the game surface must
 * agree on which pin wins.
 */
export function effectiveGameAudioPin(
  metadata: GameAudioPinMetadata | null | undefined,
  purpose: AudioPurpose,
): string | undefined {
  if (!metadata) return undefined;
  return readPin(metadata[GAME_AUDIO_PIN_KEYS[purpose]]) ?? readPin(metadata.gameAudioConnectionId);
}
