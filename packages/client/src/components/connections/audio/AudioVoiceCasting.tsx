// ──────────────────────────────────────────────
// Audio voice casting
// ──────────────────────────────────────────────
// Who sounds like what on this engine.
//
// Casting belongs to the connection because a voice id only means something to
// the engine that issued it: an ElevenLabs id is noise to a local server. Two
// saved engines therefore keep separate casts, and switching the default engine
// switches the whole cast with it.
//
// Leaving a field alone follows the app-level TTS setting, the same as the rest
// of a connection's settings.

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Plus, UserRound, X } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import type { AudioConnectionSettings, AudioGenerationSource, TTSVoiceAssignment } from "@marinara-engine/shared";
import { useCharacters } from "../../../hooks/use-characters";
import { useTTSVoices } from "../../../hooks/use-tts";
import { parseCharacterDisplayData } from "../../../lib/character-display";
import { cn } from "../../../lib/utils";
import { SettingsSwitch } from "../../panels/settings/SettingControls";
import {
  addSavedVoiceOption,
  CharacterSelect,
  CustomizableVoiceInput,
  ELEVENLABS_DEFAULT_FEMALE_VOICE_NAMES,
  ELEVENLABS_DEFAULT_MALE_VOICE_NAMES,
  ELEVENLABS_DEFAULT_VOICE_OPTIONS,
  isElevenLabsVoiceForGender,
  NpcDefaultVoicePool,
  PickOrTypeVoiceControl,
  VoiceSelect,
  type CharacterOption,
  type VoiceOption,
} from "./voice-controls";

export interface AudioVoiceCastingProps {
  connectionId: string;
  source: AudioGenerationSource;
  value: AudioConnectionSettings;
  onChange: (next: AudioConnectionSettings) => void;
}

export function AudioVoiceCasting({ connectionId, source, value, onChange }: AudioVoiceCastingProps) {
  const { t: localizeUi } = useUiTranslation();
  const [expanded, setExpanded] = useState(false);
  const { data: characters } = useCharacters();
  const catalogScope = useMemo(() => ({ connectionId }), [connectionId]);
  const { data: voicesData, isFetching } = useTTSVoices(source, catalogScope, Boolean(connectionId) && expanded);

  const patch = (next: Partial<AudioConnectionSettings>) => onChange({ ...value, ...next });
  const assignments = value.voiceAssignments ?? [];
  const perCharacter = value.voiceMode === "per-character";

  const voiceOptions = useMemo<VoiceOption[]>(() => {
    const fromProvider =
      voicesData?.voiceOptions?.map((option) => ({ ...option })) ??
      voicesData?.voices?.map((id) => ({ id, name: id })) ??
      [];
    if (fromProvider.length > 0) return fromProvider;
    return source === "elevenlabs" ? ELEVENLABS_DEFAULT_VOICE_OPTIONS : [];
  }, [voicesData, source]);

  const characterOptions = useMemo<CharacterOption[]>(() => {
    return ((characters ?? []) as Array<{ id?: string; data?: unknown; comment?: string | null }>)
      .map((character) => {
        if (!character.id) return null;
        const info = parseCharacterDisplayData({ data: character.data, comment: character.comment });
        return {
          id: character.id,
          name: info.name,
          label: info.comment ? `${info.name} (${info.comment})` : info.name,
        };
      })
      .filter((option): option is CharacterOption => Boolean(option))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [characters]);

  const assignedCharacterIds = useMemo(
    () => new Set(assignments.map((assignment) => assignment.characterId).filter(Boolean)),
    [assignments],
  );

  const updateAssignment = (index: number, next: Partial<TTSVoiceAssignment>) => {
    patch({ voiceAssignments: assignments.map((entry, i) => (i === index ? { ...entry, ...next } : entry)) });
  };

  const renderVoiceControl = (current: string, onVoiceChange: (next: string) => void, ariaLabel: string) => {
    const options = addSavedVoiceOption(voiceOptions, current);
    if (source === "elevenlabs") {
      return (
        <VoiceSelect
          value={current}
          options={options}
          disabled={isFetching}
          placeholder={localizeUi("ui.connections.audioconnectionsettings.chooseAVoice")}
          ariaLabel={ariaLabel}
          compact
          onChange={onVoiceChange}
        />
      );
    }
    if (source === "openai") {
      return (
        <CustomizableVoiceInput
          value={current}
          options={options}
          placeholder={localizeUi("ui.connections.audioconnectionsettings.chooseAVoice")}
          ariaLabel={ariaLabel}
          testId="audio-casting-voice"
          compact
          onChange={onVoiceChange}
        />
      );
    }
    return (
      <PickOrTypeVoiceControl
        value={current}
        options={options}
        fetching={isFetching}
        selectLabel={ariaLabel}
        inputLabel={localizeUi("ui.connections.audioconnectionsettings.customVoiceId")}
        onChange={onVoiceChange}
      />
    );
  };

  const poolOptions = (gender: "male" | "female") => {
    if (source !== "elevenlabs") return voiceOptions;
    const names = gender === "male" ? ELEVENLABS_DEFAULT_MALE_VOICE_NAMES : ELEVENLABS_DEFAULT_FEMALE_VOICE_NAMES;
    const matching = voiceOptions.filter((option) => isElevenLabsVoiceForGender(option, gender, names));
    return matching.length > 0 ? matching : voiceOptions;
  };

  const togglePoolVoice = (gender: "male" | "female", voiceId: string, checked: boolean) => {
    const key = gender === "male" ? "npcDefaultMaleVoices" : "npcDefaultFemaleVoices";
    const current = (gender === "male" ? value.npcDefaultMaleVoices : value.npcDefaultFemaleVoices) ?? [];
    const next = checked ? [...current, voiceId] : current.filter((entry) => entry !== voiceId);
    patch({ [key]: next } as Partial<AudioConnectionSettings>);
  };

  return (
    <div className="mari-editor-panel space-y-2 p-3">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <UserRound size="0.875rem" className="text-sky-400" />
        <h3 className="flex-1 text-xs font-semibold text-[var(--foreground)]">
          {localizeUi("ui.connections.audiovoicecasting.voiceCasting")}
        </h3>
        {expanded ? <ChevronUp size="0.75rem" /> : <ChevronDown size="0.75rem" />}
      </button>

      {expanded && (
        <div className="space-y-3 pt-1">
          <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
            {localizeUi("ui.connections.audiovoicecasting.castingIsSavedOnThisConnection")}
          </p>

          <div className="grid grid-cols-2 gap-1.5">
            {(["single", "per-character"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => patch({ voiceMode: mode })}
                className={cn(
                  "rounded-lg px-2.5 py-2 text-[0.6875rem] font-medium transition-all",
                  (value.voiceMode ?? "single") === mode
                    ? "bg-sky-400/15 text-sky-400 ring-1 ring-sky-400/30"
                    : "bg-[var(--secondary)] text-[var(--muted-foreground)] ring-1 ring-[var(--border)] hover:bg-[var(--accent)]",
                )}
              >
                {mode === "single"
                  ? localizeUi("ui.connections.audiovoicecasting.oneVoiceForEveryone")
                  : localizeUi("ui.connections.audiovoicecasting.aVoicePerCharacter")}
              </button>
            ))}
          </div>

          {perCharacter && (
            <div className="space-y-2">
              {assignments.map((assignment, index) => (
                <div
                  key={`${assignment.characterId}-${index}`}
                  className="space-y-1.5 rounded-xl bg-[var(--secondary)]/40 p-2 ring-1 ring-[var(--border)]"
                >
                  <div className="flex items-center gap-1.5">
                    <div className="flex-1">
                      <CharacterSelect
                        value={assignment.characterId}
                        options={characterOptions}
                        assignedCharacterIds={assignedCharacterIds}
                        onChange={(characterId) => {
                          const option = characterOptions.find((entry) => entry.id === characterId);
                          updateAssignment(index, { characterId, characterName: option?.name ?? "" });
                        }}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => patch({ voiceAssignments: assignments.filter((_, i) => i !== index) })}
                      className="shrink-0 rounded-lg p-1.5 text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                      aria-label={localizeUi("ui.connections.audiovoicecasting.removeAssignment")}
                    >
                      <X size="0.75rem" />
                    </button>
                  </div>
                  {renderVoiceControl(
                    assignment.voice,
                    (next) => updateAssignment(index, { voice: next }),
                    localizeUi("ui.connections.audiovoicecasting.characterVoice"),
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  const next =
                    characterOptions.find((option) => !assignedCharacterIds.has(option.id)) ?? characterOptions[0];
                  patch({
                    voiceAssignments: [
                      ...assignments,
                      { characterId: next?.id ?? "", characterName: next?.name ?? "", voice: "" },
                    ],
                  });
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--secondary)] px-3 py-2 text-xs font-medium ring-1 ring-[var(--border)] hover:bg-[var(--accent)]"
              >
                <Plus size="0.75rem" />
                {localizeUi("ui.connections.audiovoicecasting.addACharacterVoice")}
              </button>
            </div>
          )}

          <SettingsSwitch
            label={localizeUi("ui.connections.audiovoicecasting.narratorVoice")}
            description={localizeUi("ui.connections.audiovoicecasting.narratorVoiceHelp")}
            checked={value.narratorVoiceEnabled ?? false}
            onChange={(checked) => patch({ narratorVoiceEnabled: checked })}
          />
          {value.narratorVoiceEnabled &&
            renderVoiceControl(
              value.narratorVoice ?? "",
              (next) => patch({ narratorVoice: next }),
              localizeUi("ui.connections.audiovoicecasting.narratorVoice"),
            )}

          <SettingsSwitch
            label={localizeUi("ui.connections.audiovoicecasting.randomNpcVoices")}
            description={localizeUi("ui.connections.audiovoicecasting.randomNpcVoicesHelp")}
            checked={value.npcDefaultVoicesEnabled ?? false}
            onChange={(checked) => patch({ npcDefaultVoicesEnabled: checked })}
          />
          {value.npcDefaultVoicesEnabled && (
            <div className="space-y-2">
              <NpcDefaultVoicePool
                label={localizeUi("ui.connections.audiovoicecasting.maleVoicePool")}
                options={poolOptions("male")}
                selected={value.npcDefaultMaleVoices ?? []}
                onToggle={(voiceId, checked) => togglePoolVoice("male", voiceId, checked)}
              />
              <NpcDefaultVoicePool
                label={localizeUi("ui.connections.audiovoicecasting.femaleVoicePool")}
                options={poolOptions("female")}
                selected={value.npcDefaultFemaleVoices ?? []}
                onToggle={(voiceId, checked) => togglePoolVoice("female", voiceId, checked)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
