// ──────────────────────────────────────────────
// Engine parameters
// ──────────────────────────────────────────────
// The editor and the proof, for the speech request.
//
// The preview is the point of the section: parameters are free-form by
// necessity, so the only honest answer to "did that land" is the request itself.
// It describes the SAVED row, so it says so while there are unsaved edits rather
// than showing a stale body as though it were current.

import { useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw, SlidersHorizontal } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import type { AudioParameterMap, AudioParameterRecord, TTSSourceId } from "@marinara-engine/shared";
import { useEffectiveAudioRequest } from "../../../hooks/use-tts";
import { cn } from "../../../lib/utils";
import { AudioParameterEditor } from "./AudioParameterEditor";

export interface AudioParameterSectionProps {
  connectionId: string;
  source: TTSSourceId;
  value: AudioParameterMap | undefined;
  onChange: (next: AudioParameterMap) => void;
  /** True while the editor holds changes the server has not seen. */
  dirty: boolean;
}

export function AudioParameterSection({ connectionId, source, value, onChange, dirty }: AudioParameterSectionProps) {
  const { t: localizeUi } = useUiTranslation();
  const [expanded, setExpanded] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const {
    data: preview,
    isFetching,
    refetch,
  } = useEffectiveAudioRequest(connectionId, previewOpen && expanded && !dirty);

  const record: AudioParameterRecord = value?.speech ?? {};
  const setRecord = (next: AudioParameterRecord) => {
    const map: AudioParameterMap = { ...(value ?? {}) };
    // An emptied record is removed rather than stored as {}, so a connection
    // nobody parameterized keeps inheriting instead of pinning an empty answer.
    if (Object.keys(next).length === 0) delete map.speech;
    else map.speech = next;
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

          <AudioParameterEditor source={source} purpose="speech" value={record} onChange={setRecord} />

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
