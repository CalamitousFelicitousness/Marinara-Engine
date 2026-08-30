// ──────────────────────────────────────────────
// Engine parameters
// ──────────────────────────────────────────────
// The lane picker, the editor, and the proof.
//
// Parameters are per lane because an engine asked to speak and the same engine
// asked to score a scene take different keys. Only the lanes this connection can
// actually serve are offered, which its capability switches decide.
//
// The preview is the point of the section: parameters are free-form by
// necessity, so the only honest answer to "did that land" is the request itself.
// It describes the SAVED row, so it says so while there are unsaved edits rather
// than showing a stale body as though it were current.

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import {
  AUDIO_PURPOSES,
  isGameAudioPurpose,
  ttsSourceSupportsGameAudio,
  type AudioParameterMap,
  type AudioParameterRecord,
  type AudioPurpose,
  type TTSSourceId,
} from "@marinara-engine/shared";
import { useEffectiveAudioRequest, useTTSModels } from "../../../hooks/use-tts";
import { formatAudioRate } from "../../../lib/model-cost";
import { cn } from "../../../lib/utils";
import { AudioParameterEditor } from "./AudioParameterEditor";

export interface AudioParameterSectionProps {
  connectionId: string;
  source: TTSSourceId;
  /** The connection's own capability switches, which decide the lanes on offer. */
  soundEffects: boolean;
  music: boolean;
  value: AudioParameterMap | undefined;
  onChange: (next: AudioParameterMap) => void;
  /** True while the editor holds changes the server has not seen. */
  dirty: boolean;
}

const PURPOSE_LABEL_KEYS: Record<AudioPurpose, string> = {
  speech: "ui.connections.audioparametereditor.voice",
  sfx: "ui.connections.audioparametereditor.soundEffects",
  music: "ui.connections.audioparametereditor.music",
};

export function AudioParameterSection({
  connectionId,
  source,
  soundEffects,
  music,
  value,
  onChange,
  dirty,
}: AudioParameterSectionProps) {
  const { t: localizeUi } = useUiTranslation();
  const [expanded, setExpanded] = useState(false);
  const [purpose, setPurpose] = useState<AudioPurpose>("speech");
  const [previewOpen, setPreviewOpen] = useState(false);

  // A lane is offered when this backend can serve it and this connection opted
  // in. Reading the switches rather than the source alone keeps the tabs in step
  // with what the editor above actually has turned on.
  const lanes = AUDIO_PURPOSES.filter((candidate) => {
    if (!isGameAudioPurpose(candidate)) return true;
    if (!ttsSourceSupportsGameAudio(source, candidate)) return false;
    return candidate === "sfx" ? soundEffects : music;
  });
  const active = lanes.includes(purpose) ? purpose : "speech";

  const {
    data: preview,
    isFetching,
    refetch,
  } = useEffectiveAudioRequest(active, connectionId, previewOpen && expanded && !dirty);

  const record: AudioParameterRecord = value?.[active] ?? {};

  // The generator lanes pick their engine by model id rather than by route, so
  // the price of this lane is the price of whatever model its parameters name.
  const catalogScope = useMemo(() => ({ connectionId }), [connectionId]);
  const { data: catalog } = useTTSModels(source, catalogScope, expanded && isGameAudioPurpose(active));
  const modelRate = useMemo(() => {
    const named = typeof record.model === "string" ? record.model.trim() : "";
    if (!named || catalog?.source !== source) return null;
    const pricing = catalog.models.find((entry) => entry.id === named)?.pricing;
    return pricing ? formatAudioRate(pricing, localizeUi) : null;
  }, [catalog, source, record.model, localizeUi]);
  const setRecord = (next: AudioParameterRecord) => {
    const map: AudioParameterMap = { ...(value ?? {}) };
    // An emptied lane is removed rather than stored as {}, so a connection
    // nobody parameterized keeps inheriting instead of pinning an empty answer.
    if (Object.keys(next).length === 0) delete map[active];
    else map[active] = next;
    onChange(map);
  };

  return (
    <div className="mari-editor-panel space-y-2 p-3">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <SlidersHorizontal size="0.875rem" className="text-sky-400" />
        <h3 className="flex-1 text-xs font-semibold text-[var(--foreground)]">
          {localizeUi("ui.connections.audioparametereditor.title")}
        </h3>
        {expanded ? <ChevronUp size="0.75rem" /> : <ChevronDown size="0.75rem" />}
      </button>

      {expanded && (
        <div className="space-y-3 pt-1">
          <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
            {localizeUi("ui.connections.audioparametereditor.description")}
          </p>

          {lanes.length > 1 && (
            <div className="flex gap-1">
              {lanes.map((lane) => (
                <button
                  key={lane}
                  type="button"
                  onClick={() => setPurpose(lane)}
                  aria-pressed={active === lane}
                  className={cn(
                    "rounded-md px-2 py-1 text-[0.625rem] font-medium transition-colors",
                    active === lane
                      ? "bg-[var(--primary)]/15 text-[var(--foreground)]"
                      : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
                  )}
                >
                  {localizeUi(PURPOSE_LABEL_KEYS[lane])}
                </button>
              ))}
            </div>
          )}

          <AudioParameterEditor source={source} purpose={active} value={record} onChange={setRecord} />

          {modelRate && (
            <p className="text-[0.625rem] text-sky-400">
              {localizeUi("ui.connections.modelcost.rateLabel")} {modelRate}
            </p>
          )}

          <div className="border-t border-[var(--border)] pt-2">
            <button
              type="button"
              onClick={() => setPreviewOpen((open) => !open)}
              className="flex w-full items-center gap-1.5 text-left text-[0.625rem] font-medium text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
            >
              {previewOpen ? <ChevronUp size="0.6875rem" /> : <ChevronDown size="0.6875rem" />}
              <span className="flex-1">{localizeUi("ui.connections.audioparametereditor.previewRequest")}</span>
              {previewOpen && !dirty && (
                <RefreshCw
                  size="0.6875rem"
                  className={cn(isFetching && "animate-spin")}
                  onClick={(event) => {
                    event.stopPropagation();
                    void refetch();
                  }}
                />
              )}
            </button>

            {previewOpen && (
              <div className="mt-2 space-y-1.5">
                {dirty ? (
                  <p className="text-[0.625rem] leading-relaxed text-amber-500">
                    {localizeUi("ui.connections.audioparametereditor.previewNeedsSave")}
                  </p>
                ) : preview ? (
                  <>
                    <code className="block break-all text-[0.625rem] text-[var(--muted-foreground)]">
                      {preview.url}
                    </code>
                    <pre className="max-h-64 overflow-auto rounded-lg bg-[var(--secondary)]/40 p-2 text-[0.625rem] leading-relaxed text-[var(--foreground)] ring-1 ring-[var(--border)]">
                      {JSON.stringify(preview.body, null, 2)}
                    </pre>
                    <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
                      {localizeUi("ui.connections.audioparametereditor.previewHelp")}
                    </p>
                  </>
                ) : (
                  <p className="text-[0.625rem] text-[var(--muted-foreground)]">
                    {localizeUi("ui.connections.audioparametereditor.previewLoading")}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
