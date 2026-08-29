// ──────────────────────────────────────────────
// Game Setup: audio routing
// ──────────────────────────────────────────────
// Which connection a game speaks with, which one makes its sound effects, and
// which one scores it. Each lane is pinned on its own; an unpinned lane follows
// the app-level chain for that purpose.
//
// "Use the default" is previewed from the server's own answer rather than from
// a copy of its resolution order, with one exception: when nothing answers for
// a lane but a capable connection exists, this screen previews that connection
// and the wizard pins it, so what a game does matches what was shown.

import { Music, Mic, Volume2 } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import type { AudioPurpose, GameAudioPurpose, TTSEffectiveConfigResponse } from "@marinara-engine/shared";
import { audioConnectionSupportsPurpose } from "../../lib/connection-filters";
import { cn } from "../../lib/utils";

export interface GameAudioSetupConnection {
  id: string;
  name: string;
  model?: string;
  provider?: string;
  audioSource?: string | null;
  audioSoundEffects?: boolean | string;
  audioMusic?: boolean | string;
}

export interface GameAudioLanePreview {
  /** Name of the connection this lane will use, for the "Use the default" hint. */
  connectionName: string | null;
  /** Whether that connection may generate for this lane. Always true for speech. */
  canGenerate: boolean;
  /**
   * Id the game must store for runtime to match this screen. Null when the
   * app-level chain already answers with the previewed connection.
   */
  pinnedId: string | null;
}

/**
 * What a lane will use when the game pins nothing itself.
 *
 * The server's answer decides, except where it answers with nothing usable and
 * a capable connection exists: an install with one audio connection and no
 * defaults set would otherwise show a lane that silently never runs.
 */
export function previewGameAudioLane(
  connections: readonly GameAudioSetupConnection[],
  purpose: AudioPurpose,
  explicitId: string | null,
  serverAnswer: TTSEffectiveConfigResponse | undefined,
): GameAudioLanePreview {
  const supports = (connection: GameAudioSetupConnection) =>
    purpose === "speech" ? true : audioConnectionSupportsPurpose(connection, purpose as GameAudioPurpose);

  if (explicitId) {
    const picked = connections.find((connection) => connection.id === explicitId) ?? null;
    return {
      connectionName: picked?.name ?? null,
      canGenerate: picked ? supports(picked) : false,
      pinnedId: explicitId,
    };
  }

  const answered = serverAnswer?.resolvedConnectionId
    ? (connections.find((connection) => connection.id === serverAnswer.resolvedConnectionId) ?? null)
    : null;
  const answerUsable =
    purpose === "speech" ? Boolean(serverAnswer?.resolvedConnectionId) : serverAnswer?.gameAudioEnabled === true;
  if (answerUsable) {
    return {
      connectionName: answered?.name ?? serverAnswer?.resolvedConnectionName ?? null,
      canGenerate: true,
      pinnedId: null,
    };
  }

  const capable = connections.find(supports) ?? null;
  if (capable) return { connectionName: capable.name, canGenerate: true, pinnedId: capable.id };
  return {
    connectionName: answered?.name ?? serverAnswer?.resolvedConnectionName ?? null,
    canGenerate: false,
    pinnedId: null,
  };
}

interface GameAudioLaneSelectProps {
  label: string;
  emptyLabel: string;
  value: string | null;
  options: readonly GameAudioSetupConnection[];
  preview: GameAudioLanePreview;
  incapableNote: string | null;
  onChange: (id: string | null) => void;
}

function GameAudioLaneSelect({
  label,
  emptyLabel,
  value,
  options,
  preview,
  incapableNote,
  onChange,
}: GameAudioLaneSelectProps) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <div className="mt-2">
      <label className="mb-1 block text-[0.625rem] font-medium text-[var(--muted-foreground)]">{label}</label>
      <select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--secondary)] px-2.5 py-1.5 text-xs text-[var(--foreground)]"
      >
        <option value="">{emptyLabel}</option>
        {options.map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connection.name}
            {connection.model ? localizeUi("ui.game.gamesetupwizard.value1", { value1: connection.model }) : ""}
          </option>
        ))}
      </select>
      {!value && preview.connectionName ? (
        <p className="mt-1 text-[0.55rem] text-[var(--muted-foreground)]">
          {localizeUi("ui.game.gamesetupwizard.willUseValue1", { value1: preview.connectionName })}
        </p>
      ) : null}
      {incapableNote && !preview.canGenerate ? (
        <p className="mt-1 text-[0.55rem] text-amber-700 dark:text-amber-400/80">{incapableNote}</p>
      ) : null}
    </div>
  );
}

interface GameAudioToggleProps {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  className?: string;
  onToggle: () => void;
}

function GameAudioToggle({ label, description, checked, disabled, className, onToggle }: GameAudioToggleProps) {
  const on = checked && !disabled;
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "mt-2 flex w-full items-center justify-between gap-3 text-left",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <span className="min-w-0">
        <span className="block text-[0.625rem] font-medium text-[var(--foreground)]">{label}</span>
        <span className="mt-0.5 block text-[0.55rem] leading-snug text-[var(--muted-foreground)]">{description}</span>
      </span>
      <span
        className={cn(
          "h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors",
          on ? "bg-[var(--primary)]" : "bg-[var(--muted-foreground)]/50",
        )}
      >
        <span className={cn("block h-4 w-4 rounded-full bg-white transition-transform", on && "translate-x-3.5")} />
      </span>
    </button>
  );
}

export interface GameAudioSetupSectionProps {
  connections: readonly GameAudioSetupConnection[];
  voiceConnectionId: string | null;
  onVoiceConnectionChange: (id: string | null) => void;
  sfxConnectionId: string | null;
  onSfxConnectionChange: (id: string | null) => void;
  musicConnectionId: string | null;
  onMusicConnectionChange: (id: string | null) => void;
  voicePreview: GameAudioLanePreview;
  sfxPreview: GameAudioLanePreview;
  musicPreview: GameAudioLanePreview;
  enableGameSoundEffects: boolean;
  onEnableGameSoundEffectsChange: (value: boolean) => void;
  enableGameMusic: boolean;
  onEnableGameMusicChange: (value: boolean) => void;
}

export function GameAudioSetupSection({
  connections,
  voiceConnectionId,
  onVoiceConnectionChange,
  sfxConnectionId,
  onSfxConnectionChange,
  musicConnectionId,
  onMusicConnectionChange,
  voicePreview,
  sfxPreview,
  musicPreview,
  enableGameSoundEffects,
  onEnableGameSoundEffectsChange,
  enableGameMusic,
  onEnableGameMusicChange,
}: GameAudioSetupSectionProps) {
  const { t: localizeUi } = useUiTranslation();

  // A connection that cannot generate for a lane is not offered there, but one
  // already pinned stays listed so the pin can be seen and changed.
  const optionsFor = (purpose: GameAudioPurpose, selectedId: string | null) =>
    connections.filter(
      (connection) => audioConnectionSupportsPurpose(connection, purpose) || connection.id === selectedId,
    );

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
      <div className="flex items-center gap-2.5">
        <Music size={14} className="text-[var(--muted-foreground)]" />
        <div className="flex-1">
          <span className="block text-xs font-medium text-[var(--foreground)]">
            {localizeUi("ui.game.gamesetupwizard.gameAudio")}
          </span>
          <span className="block text-[0.575rem] text-[var(--muted-foreground)]">
            {localizeUi("ui.game.gamesetupwizard.chooseWhichConnectionSpeaksAndWhichOnesGenerate")}
          </span>
        </div>
      </div>

      <div className="mt-1 flex items-center gap-1.5">
        <Mic size={11} className="text-[var(--muted-foreground)]" />
        <span className="text-[0.575rem] font-medium text-[var(--muted-foreground)]">
          {localizeUi("ui.game.gamesetupwizard.voice")}
        </span>
      </div>
      <GameAudioLaneSelect
        label={localizeUi("ui.game.gamesetupwizard.voiceConnection")}
        emptyLabel={localizeUi("ui.game.gamesetupwizard.useTheDefaultVoiceConnection")}
        value={voiceConnectionId}
        options={connections}
        preview={voicePreview}
        incapableNote={null}
        onChange={onVoiceConnectionChange}
      />

      <div className="mt-3 flex items-center gap-1.5 border-t border-[var(--border)] pt-3">
        <Volume2 size={11} className="text-[var(--muted-foreground)]" />
        <span className="text-[0.575rem] font-medium text-[var(--muted-foreground)]">
          {localizeUi("ui.game.gamesetupwizard.soundEffects")}
        </span>
      </div>
      <GameAudioLaneSelect
        label={localizeUi("ui.game.gamesetupwizard.soundEffectsConnection")}
        emptyLabel={localizeUi("ui.game.gamesetupwizard.useTheDefaultSoundEffectsConnection")}
        value={sfxConnectionId}
        options={optionsFor("sfx", sfxConnectionId)}
        preview={sfxPreview}
        incapableNote={localizeUi("ui.game.gamesetupwizard.noConnectionHereCanGenerateSoundEffects")}
        onChange={onSfxConnectionChange}
      />
      <GameAudioToggle
        label={localizeUi("ui.game.gamesetupwizard.soundEffects")}
        description={localizeUi("ui.game.gamesetupwizard.generateShortSceneSoundEffectsAfterGmTurns")}
        checked={enableGameSoundEffects}
        disabled={!sfxPreview.canGenerate}
        onToggle={() => onEnableGameSoundEffectsChange(!enableGameSoundEffects)}
      />

      <div className="mt-3 flex items-center gap-1.5 border-t border-[var(--border)] pt-3">
        <Music size={11} className="text-[var(--muted-foreground)]" />
        <span className="text-[0.575rem] font-medium text-[var(--muted-foreground)]">
          {localizeUi("game.toolbar.volume.music")}
        </span>
      </div>
      <GameAudioLaneSelect
        label={localizeUi("ui.game.gamesetupwizard.musicConnection")}
        emptyLabel={localizeUi("ui.game.gamesetupwizard.useTheDefaultMusicConnection")}
        value={musicConnectionId}
        options={optionsFor("music", musicConnectionId)}
        preview={musicPreview}
        incapableNote={localizeUi("ui.game.gamesetupwizard.noConnectionHereCanGenerateMusic")}
        onChange={onMusicConnectionChange}
      />
      <GameAudioToggle
        label={localizeUi("game.toolbar.volume.music")}
        description={localizeUi("ui.game.gamesetupwizard.generateBackgroundMusicForScenes")}
        checked={enableGameMusic}
        disabled={!musicPreview.canGenerate}
        onToggle={() => onEnableGameMusicChange(!enableGameMusic)}
      />

      {connections.length === 0 ? (
        <p className="mt-2 text-[0.55rem] text-amber-700 dark:text-amber-400/80">
          {localizeUi("ui.game.gamesetupwizard.noAudioConnectionsFoundAddOneInSettings")}
        </p>
      ) : null}
    </div>
  );
}
