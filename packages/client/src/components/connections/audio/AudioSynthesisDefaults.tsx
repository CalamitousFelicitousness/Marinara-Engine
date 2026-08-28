// ──────────────────────────────────────────────
// Audio synthesis defaults
// ──────────────────────────────────────────────
// How this engine speaks: delivery, and the request budget around it.
//
// Every control here is optional. Leaving one alone follows the app-level TTS
// setting, which is what a connection nobody has tuned should do; setting one
// pins it to this engine, so a slow local engine and a cloud API stop having to
// share a timeout.

import { useState } from "react";
import { ChevronDown, ChevronUp, Gauge } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import {
  ELEVENLABS_TTS_LANGUAGE_OPTIONS,
  TTS_CHUNK_CHARS_MAX,
  TTS_CHUNK_CHARS_MIN,
  TTS_CONCURRENCY_MAX,
  TTS_CONCURRENCY_MIN,
  TTS_MAX_RETRIES_MAX,
  TTS_MAX_RETRIES_MIN,
  TTS_SOURCE_DEFINITIONS,
  TTS_TIMEOUT_MS_MAX,
  TTS_TIMEOUT_MS_MIN,
  type AudioConnectionSettings,
  type AudioGenerationSource,
} from "@marinara-engine/shared";
import { cn } from "../../../lib/utils";
import { audioSpeedRange, honorsAudioFormat } from "./audio-catalog";
import { INPUT_CLS, TtsDropdownIcon } from "./voice-controls";

/** Container names, not copy: they are what the provider is asked for. */
const AUDIO_FORMATS = ["mp3", "wav"] as const;

export interface AudioSynthesisDefaultsProps {
  source: AudioGenerationSource;
  value: AudioConnectionSettings;
  onChange: (next: AudioConnectionSettings) => void;
}

/** A number control that can be returned to "follow the app-level setting". */
function OptionalNumberRow({
  label,
  help,
  value,
  min,
  max,
  step,
  format,
  inheritLabel,
  onChange,
}: {
  label: string;
  help: string;
  value: number | undefined;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  inheritLabel: string;
  onChange: (next: number | undefined) => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  const active = value !== undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--muted-foreground)]">{label}</span>
        <span className="text-[0.625rem] text-[var(--muted-foreground)]">{active ? format(value) : inheritLabel}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={active ? value : min}
        onChange={(event) => onChange(Number(event.target.value))}
        className={cn("w-full accent-sky-400", !active && "opacity-50")}
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">{help}</p>
        {active && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="shrink-0 text-[0.625rem] text-sky-400 underline-offset-2 hover:underline"
          >
            {localizeUi("ui.connections.audiosynthesisdefaults.followAppSetting")}
          </button>
        )}
      </div>
    </div>
  );
}

export function AudioSynthesisDefaults({ source, value, onChange }: AudioSynthesisDefaultsProps) {
  const { t: localizeUi } = useUiTranslation();
  const [expanded, setExpanded] = useState(false);
  const speed = audioSpeedRange(source);
  const chunkMax = Math.min(TTS_CHUNK_CHARS_MAX, TTS_SOURCE_DEFINITIONS[source].maxInputChars);
  const patch = (next: Partial<AudioConnectionSettings>) => onChange({ ...value, ...next });
  const inherit = localizeUi("ui.connections.audiosynthesisdefaults.appSetting");

  return (
    <div className="mari-editor-panel space-y-2 p-3">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <Gauge size="0.875rem" className="text-sky-400" />
        <h3 className="flex-1 text-xs font-semibold text-[var(--foreground)]">
          {localizeUi("ui.connections.audiosynthesisdefaults.synthesisDefaults")}
        </h3>
        {expanded ? <ChevronUp size="0.75rem" /> : <ChevronDown size="0.75rem" />}
      </button>

      {expanded && (
        <div className="space-y-3 pt-1">
          <OptionalNumberRow
            label={localizeUi("ui.connections.audiosynthesisdefaults.speed")}
            help={localizeUi("ui.connections.audiosynthesisdefaults.speedHelp")}
            value={value.speed}
            min={speed.min}
            max={speed.max}
            step={0.05}
            format={(current) => `${current.toFixed(2)}x`}
            inheritLabel={inherit}
            onChange={(next) => patch({ speed: next })}
          />

          {honorsAudioFormat(source) && (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-[var(--muted-foreground)]">
                {localizeUi("ui.connections.audiosynthesisdefaults.audioFormat")}
              </span>
              <div className="relative">
                <select
                  value={value.audioFormat ?? ""}
                  onChange={(event) =>
                    patch({ audioFormat: event.target.value ? (event.target.value as "mp3" | "wav") : undefined })
                  }
                  className={cn(INPUT_CLS, "appearance-none pr-10")}
                >
                  <option value="">{inherit}</option>
                  {AUDIO_FORMATS.map((format) => (
                    <option key={format} value={format}>
                      {format}
                    </option>
                  ))}
                </select>
                <TtsDropdownIcon />
              </div>
            </label>
          )}

          {source === "elevenlabs" && (
            <>
              <OptionalNumberRow
                label={localizeUi("ui.connections.audiosynthesisdefaults.stability")}
                help={localizeUi("ui.connections.audiosynthesisdefaults.stabilityHelp")}
                value={value.elevenLabsStability}
                min={0}
                max={1}
                step={0.05}
                format={(current) => current.toFixed(2)}
                inheritLabel={inherit}
                onChange={(next) => patch({ elevenLabsStability: next })}
              />
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-[var(--muted-foreground)]">
                  {localizeUi("ui.connections.audiosynthesisdefaults.language")}
                </span>
                <div className="relative">
                  <select
                    value={value.elevenLabsLanguageCode ?? ""}
                    onChange={(event) => patch({ elevenLabsLanguageCode: event.target.value || undefined })}
                    className={cn(INPUT_CLS, "appearance-none pr-10")}
                  >
                    {ELEVENLABS_TTS_LANGUAGE_OPTIONS.map((option) => (
                      <option key={option.code} value={option.code}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <TtsDropdownIcon />
                </div>
              </label>
            </>
          )}

          <OptionalNumberRow
            label={localizeUi("ui.connections.audiosynthesisdefaults.requestTimeout")}
            help={localizeUi("ui.connections.audiosynthesisdefaults.requestTimeoutHelp")}
            value={value.timeoutMs}
            min={TTS_TIMEOUT_MS_MIN}
            max={TTS_TIMEOUT_MS_MAX}
            step={5_000}
            format={(current) => `${Math.round(current / 1000)}s`}
            inheritLabel={inherit}
            onChange={(next) => patch({ timeoutMs: next })}
          />
          <OptionalNumberRow
            label={localizeUi("ui.connections.audiosynthesisdefaults.chunkSize")}
            help={localizeUi("ui.connections.audiosynthesisdefaults.chunkSizeHelp")}
            value={value.chunkCharLimit}
            min={TTS_CHUNK_CHARS_MIN}
            max={chunkMax}
            step={50}
            format={(current) => `${current}`}
            inheritLabel={inherit}
            onChange={(next) => patch({ chunkCharLimit: next })}
          />
          <OptionalNumberRow
            label={localizeUi("ui.connections.audiosynthesisdefaults.retries")}
            help={localizeUi("ui.connections.audiosynthesisdefaults.retriesHelp")}
            value={value.maxRetries}
            min={TTS_MAX_RETRIES_MIN}
            max={TTS_MAX_RETRIES_MAX}
            step={1}
            format={(current) => `${current}`}
            inheritLabel={inherit}
            onChange={(next) => patch({ maxRetries: next })}
          />
          <OptionalNumberRow
            label={localizeUi("ui.connections.audiosynthesisdefaults.parallelRequests")}
            help={localizeUi("ui.connections.audiosynthesisdefaults.parallelRequestsHelp")}
            value={value.generationConcurrency}
            min={TTS_CONCURRENCY_MIN}
            max={TTS_CONCURRENCY_MAX}
            step={1}
            format={(current) => `${current}`}
            inheritLabel={inherit}
            onChange={(next) => patch({ generationConcurrency: next })}
          />
        </div>
      )}
    </div>
  );
}
