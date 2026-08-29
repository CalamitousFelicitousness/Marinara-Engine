// ──────────────────────────────────────────────
// Chat settings: this game's audio routing
// ──────────────────────────────────────────────
// The wizard picks a game's engines once. This is where they change afterwards,
// per lane, along with whether the game generates sound effects and music at
// all: before this, those two were decided at creation and never again.
//
// The empty option tells the truth about what answers next. A game created
// before the lanes split still carries one all-purpose pin, and that pin, not
// the app default, is what an unpinned lane will reach.

import { Volume2 } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import type { GameAudioPurpose } from "@marinara-engine/shared";
import { AgentSettingsCard, AgentSettingsToggle } from "./AgentSettingsControls";
import { audioConnectionSupportsPurpose, filterAudioGenerationConnections } from "../../lib/connection-filters";

export interface GameAudioSettingsConnection {
  id: string;
  name: string;
  model?: string;
  provider?: string;
  audioSource?: string | null;
  audioSoundEffects?: boolean | string;
  audioMusic?: boolean | string;
}

export interface GameAudioSettingsCardProps {
  connections: readonly GameAudioSettingsConnection[];
  metadata: Record<string, unknown>;
  onPinChange: (
    key: "gameVoiceConnectionId" | "gameSfxConnectionId" | "gameMusicConnectionId",
    id: string | null,
  ) => void;
  onSoundEffectsEnabledChange: (enabled: boolean) => void;
  onMusicEnabledChange: (enabled: boolean) => void;
}

export function GameAudioSettingsCard({
  connections,
  metadata,
  onPinChange,
  onSoundEffectsEnabledChange,
  onMusicEnabledChange,
}: GameAudioSettingsCardProps) {
  const { t: localizeUi } = useUiTranslation();
  const audioConnections = filterAudioGenerationConnections(connections);
  const legacyPin = typeof metadata.gameAudioConnectionId === "string" ? metadata.gameAudioConnectionId : "";
  // The one place a player can see the all-purpose pin a game may still carry.
  const emptyOptionLabel = legacyPin
    ? localizeUi("ui.chat.chatsettingsdrawer.useThisGamesAudioConnection")
    : localizeUi("ui.chat.chatsettingsdrawer.useTheAppDefault");

  const renderLane = (
    key: "gameVoiceConnectionId" | "gameSfxConnectionId" | "gameMusicConnectionId",
    label: string,
    purpose: GameAudioPurpose | null,
  ) => {
    const value = typeof metadata[key] === "string" ? (metadata[key] as string) : "";
    // A pinned connection stays listed even where it cannot generate, so the
    // pin can be seen and changed rather than silently disappearing.
    const options = audioConnections.filter(
      (connection) =>
        purpose === null || audioConnectionSupportsPurpose(connection, purpose) || connection.id === value,
    );
    return (
      <label className="flex flex-col gap-1">
        <span className="text-[0.625rem] font-medium text-[var(--foreground)]">{label}</span>
        <select
          value={value}
          onChange={(event) => onPinChange(key, event.target.value || null)}
          className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-2 text-xs text-[var(--foreground)] outline-none transition-colors focus:border-[var(--primary)]/50"
        >
          <option value="">{emptyOptionLabel}</option>
          {options.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name}
              {connection.model ? localizeUi("ui.chat.datablock.value1", { value1: connection.model }) : ""}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <AgentSettingsCard
      icon={<Volume2 size={14} />}
      title={localizeUi("ui.chat.chatsettingsdrawer.gameAudio")}
      description={localizeUi("ui.chat.chatsettingsdrawer.chooseWhichConnectionsThisGameSpeaksAndScoresWith")}
      initialOpen={false}
    >
      <div className="flex flex-col gap-2">
        {renderLane("gameVoiceConnectionId", localizeUi("ui.chat.chatsettingsdrawer.voiceConnection"), null)}
        {renderLane("gameSfxConnectionId", localizeUi("ui.chat.chatsettingsdrawer.soundEffectsConnection"), "sfx")}
        <AgentSettingsToggle
          label={localizeUi("ui.chat.chatsettingsdrawer.generateSceneSoundEffects")}
          description={localizeUi("ui.chat.chatsettingsdrawer.makeShortSoundEffectsForScenesAsTheyHappen")}
          enabled={metadata.gameAudioSoundEffectsEnabled !== false}
          onToggle={() => onSoundEffectsEnabledChange(metadata.gameAudioSoundEffectsEnabled === false)}
        />
        {renderLane("gameMusicConnectionId", localizeUi("ui.chat.chatsettingsdrawer.musicConnection"), "music")}
        <AgentSettingsToggle
          label={localizeUi("ui.chat.chatsettingsdrawer.generateBackgroundMusic")}
          description={localizeUi("ui.chat.chatsettingsdrawer.composeATrackForEachAreaAndEncounterTier")}
          enabled={metadata.gameAudioMusicEnabled !== false}
          onToggle={() => onMusicEnabledChange(metadata.gameAudioMusicEnabled === false)}
        />
      </div>
    </AgentSettingsCard>
  );
}
