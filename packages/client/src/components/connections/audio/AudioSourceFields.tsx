// ──────────────────────────────────────────────
// Audio source fields
// ──────────────────────────────────────────────
// Which engine this connection is: source, endpoint, model, and default voice.
//
// The endpoint is only a field where it is a decision. A source that publishes
// one address hides it behind a disclosure, which stays available because
// pointing a source at a proxy is a real setup, and opens by itself when the
// saved address is not the published one.
//
// Voice and model catalogs are fetched by connection id, so they describe the
// saved row. While identity fields are unsaved the pickers keep showing the last
// catalog and say so, rather than listing a different endpoint's voices.

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Play, RefreshCw, Square } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { toast } from "sonner";
import { TTS_SOURCE_DEFINITIONS, TTS_SOURCES_WITH_MODEL_LISTING } from "@marinara-engine/shared";
import type { AudioGenerationSource } from "@marinara-engine/shared";
import { useTTSModels, useTTSVoices } from "../../../hooks/use-tts";
import { ttsService } from "../../../lib/tts-service";
import { cn } from "../../../lib/utils";
import { SettingsSwitch } from "../../panels/settings/SettingControls";
import { AUDIO_SOURCE_DISPLAY_ORDER, fallbackModelIds } from "./audio-catalog";
import {
  addSavedVoiceOption,
  CustomizableVoiceInput,
  ELEVENLABS_DEFAULT_VOICE_OPTIONS,
  INPUT_CLS,
  PickOrTypeVoiceControl,
  TtsDropdownIcon,
  VoiceSelect,
  type VoiceOption,
} from "./voice-controls";

const PREVIEW_ID = "audio-connection-preview";

export interface AudioSourceFieldsProps {
  connectionId: string;
  source: AudioGenerationSource;
  onSourceChange: (source: AudioGenerationSource) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  baseUrlError?: string | null;
  model: string;
  onModelChange: (value: string) => void;
  voice: string;
  onVoiceChange: (value: string) => void;
  soundEffects: boolean;
  onSoundEffectsChange: (value: boolean) => void;
  music: boolean;
  onMusicChange: (value: boolean) => void;
  /** True while identity fields differ from the saved row. */
  dirty: boolean;
  /** Saves the row if needed, so a catalog request describes what the server has. */
  onEnsureSaved: () => Promise<void>;
}

export function AudioSourceFields({
  connectionId,
  source,
  onSourceChange,
  baseUrl,
  onBaseUrlChange,
  baseUrlError,
  model,
  onModelChange,
  voice,
  onVoiceChange,
  soundEffects,
  onSoundEffectsChange,
  music,
  onMusicChange,
  dirty,
  onEnsureSaved,
}: AudioSourceFieldsProps) {
  const { t: localizeUi } = useUiTranslation();
  const definition = TTS_SOURCE_DEFINITIONS[source];
  const endpointOverridden = Boolean(baseUrl) && baseUrl !== definition.defaultBaseUrl;
  const [endpointOpen, setEndpointOpen] = useState(endpointOverridden);
  const [previewing, setPreviewing] = useState(false);

  // A saved address that is not the published one has to be visible, or the
  // setting becomes unreachable on the screen that owns it.
  useEffect(() => {
    if (endpointOverridden) setEndpointOpen(true);
  }, [endpointOverridden, source]);

  const catalogScope = useMemo(() => ({ connectionId }), [connectionId]);
  const {
    data: voicesData,
    isFetching: fetchingVoices,
    refetch: refetchVoices,
  } = useTTSVoices(source, catalogScope, Boolean(connectionId));
  const { data: modelsData, isFetching: fetchingModels } = useTTSModels(source, catalogScope, Boolean(connectionId));

  const voiceOptions = useMemo(() => {
    const fromProvider: VoiceOption[] =
      voicesData?.voiceOptions?.map((option) => ({ ...option })) ??
      voicesData?.voices?.map((id) => ({ id, name: id })) ??
      [];
    const base =
      fromProvider.length > 0 ? fromProvider : source === "elevenlabs" ? ELEVENLABS_DEFAULT_VOICE_OPTIONS : [];
    return addSavedVoiceOption(base, voice);
  }, [voicesData, source, voice]);

  const modelOptions = useMemo(() => {
    const provided = modelsData?.source === source ? (modelsData?.models ?? []) : [];
    const ids = provided.length > 0 ? provided.map((entry) => entry.id) : fallbackModelIds(source);
    return model && !ids.includes(model) ? [model, ...ids] : ids;
  }, [modelsData, source, model]);

  const usesModelPicker = TTS_SOURCES_WITH_MODEL_LISTING.includes(source);

  const handleSourceChange = (next: AudioGenerationSource) => {
    if (next === source) return;
    const previous = TTS_SOURCE_DEFINITIONS[source];
    const target = TTS_SOURCE_DEFINITIONS[next];
    // Only carry over what the user actually chose. A field still holding the
    // old source's default is not a choice, and keeping it would point the new
    // engine at the wrong address or a model it has never heard of.
    if (!baseUrl || baseUrl === previous.defaultBaseUrl) onBaseUrlChange(target.defaultBaseUrl);
    if (!model || model === previous.defaultModel) onModelChange(target.defaultModel);
    if (!voice || voice === previous.defaultVoice) onVoiceChange(target.defaultVoice);
    onSourceChange(next);
  };

  const handleRefreshVoices = async () => {
    try {
      await onEnsureSaved();
      await refetchVoices();
    } catch {
      toast.error(localizeUi("ui.connections.audioconnectionsettings.couldNotRefreshVoices"));
    }
  };

  const handleTestVoice = async () => {
    if (previewing) {
      ttsService.stop();
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    try {
      await onEnsureSaved();
      await ttsService.speak(localizeUi("ui.connections.audioconnectionsettings.testSentence"), PREVIEW_ID, {
        audioConnectionId: connectionId,
        voice: voice || undefined,
        throwOnError: true,
      });
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : localizeUi("ui.connections.audioconnectionsettings.testVoiceFailed"),
      );
    } finally {
      setPreviewing(false);
    }
  };

  const sourceDescription = (id: AudioGenerationSource) => {
    if (id === "elevenlabs") return localizeUi("ui.connections.connectioneditor.speechSoundEffectsAndMusicGeneration");
    if (id === "openai") return localizeUi("ui.connections.connectioneditor.openaiOrAnyCompatibleAudioSpeechEndpoint");
    if (id === "pockettts") return localizeUi("ui.connections.connectioneditor.localPocketttsServerFreePrivateOffline");
    if (id === "nanogpt") return localizeUi("ui.connections.audioconnectionsettings.nanogptSourceDescription");
    return localizeUi("ui.connections.connectioneditor.xaiGrokVoiceSynthesis");
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-1.5">
        {AUDIO_SOURCE_DISPLAY_ORDER.map((id) => TTS_SOURCE_DEFINITIONS[id]).map((candidate) => {
          const isActive = source === candidate.id;
          return (
            <button
              key={candidate.id}
              type="button"
              onClick={() => handleSourceChange(candidate.id)}
              className={cn(
                "flex flex-col gap-0.5 rounded-lg px-2.5 py-2 text-left text-[0.6875rem] transition-all",
                isActive
                  ? "bg-sky-400/15 text-sky-400 ring-1 ring-sky-400/30"
                  : "bg-[var(--secondary)] text-[var(--muted-foreground)] ring-1 ring-[var(--border)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="font-medium">{candidate.name}</span>
                {isActive && <Check size="0.625rem" />}
              </div>
              <span className="text-[0.625rem] opacity-80">{sourceDescription(candidate.id)}</span>
            </button>
          );
        })}
      </div>

      {definition.baseUrlMode === "editable" || endpointOpen ? (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-[var(--muted-foreground)]">
            {localizeUi("ui.connections.connectioneditor.baseUrl")}
          </span>
          <input
            value={baseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            placeholder={definition.defaultBaseUrl}
            className={cn(INPUT_CLS, baseUrlError && "ring-2 ring-red-500/60")}
          />
          {baseUrlError ? (
            <p className="text-[0.625rem] text-red-400">{baseUrlError}</p>
          ) : (
            <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
              {definition.baseUrlMode === "fixed"
                ? localizeUi("ui.connections.audioconnectionsettings.customEndpointHelp")
                : localizeUi("ui.connections.audioconnectionsettings.editableEndpointHelp")}
            </p>
          )}
          {definition.baseUrlMode === "fixed" && endpointOverridden && (
            <button
              type="button"
              onClick={() => onBaseUrlChange(definition.defaultBaseUrl)}
              className="text-[0.625rem] text-sky-400 underline-offset-2 hover:underline"
            >
              {localizeUi("ui.connections.audioconnectionsettings.resetToProviderDefault")}
            </button>
          )}
        </label>
      ) : (
        <button
          type="button"
          onClick={() => setEndpointOpen(true)}
          className="w-full rounded-xl bg-[var(--secondary)]/40 px-3 py-2 text-left text-[0.625rem] text-[var(--muted-foreground)] ring-1 ring-[var(--border)] hover:text-[var(--foreground)]"
        >
          {localizeUi("ui.connections.audioconnectionsettings.customEndpoint")}
        </button>
      )}

      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-[var(--muted-foreground)]">
          {localizeUi("ui.connections.connectioneditor.model")}
        </span>
        {usesModelPicker ? (
          <div className="relative">
            <select
              value={model}
              onChange={(event) => onModelChange(event.target.value)}
              className={cn(INPUT_CLS, "appearance-none pr-10")}
            >
              <option value="">{definition.defaultModel}</option>
              {modelOptions.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <TtsDropdownIcon />
          </div>
        ) : (
          <input
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
            placeholder={definition.defaultModel}
            className={INPUT_CLS}
          />
        )}
        <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
          {fetchingModels
            ? localizeUi("ui.panels.ttsconfigcard.loading")
            : localizeUi("ui.connections.audioconnectionsettings.modelHelp")}
        </p>
      </label>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-[var(--muted-foreground)]">
            {localizeUi("ui.connections.connectioneditor.defaultVoice")}
          </span>
          <button
            type="button"
            onClick={handleRefreshVoices}
            disabled={fetchingVoices || !connectionId}
            className="flex items-center gap-1 text-[0.625rem] text-sky-400 disabled:opacity-50"
          >
            {fetchingVoices ? <Loader2 size="0.625rem" className="animate-spin" /> : <RefreshCw size="0.625rem" />}
            {localizeUi("ui.connections.audioconnectionsettings.refreshVoices")}
          </button>
        </div>
        {source === "elevenlabs" ? (
          <VoiceSelect
            value={voice}
            options={voiceOptions}
            disabled={fetchingVoices}
            placeholder={localizeUi("ui.connections.audioconnectionsettings.chooseAVoice")}
            ariaLabel={localizeUi("ui.connections.connectioneditor.defaultVoice")}
            onChange={onVoiceChange}
          />
        ) : source === "openai" ? (
          <CustomizableVoiceInput
            value={voice}
            options={voiceOptions}
            placeholder={definition.defaultVoice}
            ariaLabel={localizeUi("ui.connections.connectioneditor.defaultVoice")}
            testId="audio-connection-voice"
            onChange={onVoiceChange}
          />
        ) : (
          <PickOrTypeVoiceControl
            value={voice}
            options={voiceOptions}
            fetching={fetchingVoices}
            selectLabel={localizeUi("ui.connections.connectioneditor.defaultVoice")}
            inputLabel={localizeUi("ui.connections.audioconnectionsettings.customVoiceId")}
            inputPlaceholder={definition.defaultVoice}
            onChange={onVoiceChange}
          />
        )}
        <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
          {dirty
            ? localizeUi("ui.connections.audioconnectionsettings.saveToLoadVoicesFromTheNewEndpoint")
            : localizeUi("ui.connections.connectioneditor.voiceIdOrNameUsedWhenNothingMoreSpecific")}
        </p>
      </div>

      <button
        type="button"
        onClick={handleTestVoice}
        disabled={!connectionId}
        className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--secondary)] px-3 py-2 text-xs font-medium ring-1 ring-[var(--border)] hover:bg-[var(--accent)] disabled:opacity-50"
      >
        {previewing ? <Square size="0.75rem" /> : <Play size="0.75rem" />}
        {previewing
          ? localizeUi("ui.connections.audioconnectionsettings.stopTest")
          : localizeUi("ui.connections.audioconnectionsettings.testVoice")}
      </button>

      {source === "elevenlabs" ? (
        <div className="space-y-2">
          <SettingsSwitch
            label={localizeUi("ui.connections.connectioneditor.gameSoundEffects")}
            description={localizeUi(
              "ui.connections.connectioneditor.letGameModeGenerateSoundEffectsWithThisConnection",
            )}
            checked={soundEffects}
            onChange={onSoundEffectsChange}
          />
          <SettingsSwitch
            label={localizeUi("ui.connections.connectioneditor.gameMusic")}
            description={localizeUi("ui.connections.connectioneditor.letGameModeGenerateMusicWithThisConnection")}
            checked={music}
            onChange={onMusicChange}
          />
        </div>
      ) : (
        <p className="rounded-xl bg-[var(--secondary)]/40 px-3 py-2 text-[0.625rem] text-[var(--muted-foreground)] ring-1 ring-[var(--border)]">
          {localizeUi("ui.connections.connectioneditor.soundEffectAndMusicGenerationCurrentlyRequiresTheElevenlabs")}
        </p>
      )}
    </div>
  );
}
