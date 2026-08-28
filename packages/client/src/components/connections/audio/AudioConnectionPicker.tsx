// ──────────────────────────────────────────────
// Audio connection picker
// ──────────────────────────────────────────────
// Which saved engine speaks, chosen where speech is configured.
//
// The value is the audio category default (`defaultForAgents` on the row), the
// same flag the Connections defaults section writes, so the two screens cannot
// disagree and there is no second notion of "active engine" to keep in sync.
// The server keeps that flag exclusive per provider, so selecting is one write
// and the previous default clears itself.
//
// The select answers "which engine is picked". Resolution `origin` answers
// "which engine speaks": a fallback row or the legacy settings blob still
// resolves when nothing is picked. The note below the select is the only place
// that difference is visible, so it renders whenever the two disagree.

import { useMemo } from "react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { Volume2 } from "lucide-react";
import { TTS_SOURCE_DEFINITIONS, type TTSSourceId } from "@marinara-engine/shared";
import { useConnections, useUpdateConnection } from "../../../hooks/use-connections";
import { useEffectiveTTSConfig } from "../../../hooks/use-tts";
import { filterAudioGenerationConnections, isConnectionFlagTrue } from "../../../lib/connection-filters";
import { useUIStore } from "../../../stores/ui.store";
import { HelpTooltip } from "../../ui/HelpTooltip";

type AudioConnectionOption = {
  id: string;
  name: string;
  audioSource: string | null;
  defaultForAgents: unknown;
  provider: unknown;
  profileImportReviewRequired: unknown;
};

/** `/connections` returns untyped rows; take only the fields this picker reads. */
function toAudioConnectionOption(value: unknown): AudioConnectionOption | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.name !== "string") return null;
  return {
    id: row.id,
    name: row.name,
    audioSource: typeof row.audioSource === "string" ? row.audioSource : null,
    defaultForAgents: row.defaultForAgents,
    provider: row.provider,
    profileImportReviewRequired: row.profileImportReviewRequired,
  };
}

function sourceLabel(source: string | null): string {
  const definition = TTS_SOURCE_DEFINITIONS[source as TTSSourceId];
  return definition ? definition.name : "";
}

export function AudioConnectionPicker() {
  const { t: localizeUi } = useUiTranslation();
  const { data: connections } = useConnections();
  const { data: effectiveConfig } = useEffectiveTTSConfig();
  const updateConnection = useUpdateConnection();
  const openConnectionDetail = useUIStore((state) => state.openConnectionDetail);
  const openModal = useUIStore((state) => state.openModal);

  const audioConnections = useMemo(
    () =>
      filterAudioGenerationConnections((connections ?? []).map(toAudioConnectionOption).filter((row) => row !== null)),
    [connections],
  );
  const selected = audioConnections.find((row) => isConnectionFlagTrue(row.defaultForAgents)) ?? null;

  const resolvedName = effectiveConfig?.resolvedConnectionName ?? null;
  const resolvedSourceName = effectiveConfig ? TTS_SOURCE_DEFINITIONS[effectiveConfig.resolvedSource].name : "";
  // Origin "explicit" cannot occur here: this picker asks for the unscoped
  // resolution, never for one connection's. Worth saying only when something
  // would actually speak, since an off switch explains its own silence.
  const speaksSomethingElse = Boolean(effectiveConfig?.speechEnabled && effectiveConfig.origin !== "default");

  const handleChange = (nextId: string) => {
    if (nextId === (selected?.id ?? "")) return;
    if (!nextId) {
      if (selected) updateConnection.mutate({ id: selected.id, defaultForAgents: false });
      return;
    }
    updateConnection.mutate({ id: nextId, defaultForAgents: true });
  };

  return (
    <div className="space-y-1.5 rounded-xl border border-sky-400/15 bg-sky-400/5 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <Volume2 size="0.75rem" className="shrink-0 text-sky-400" />
        <span className="text-xs font-medium">{localizeUi("ui.connections.audioconnectionpicker.voicedBy")}</span>
        <HelpTooltip text={localizeUi("ui.connections.audioconnectionpicker.voicedByHelp")} />
      </div>

      <div className="flex items-center gap-1.5">
        <select
          value={selected?.id ?? ""}
          onChange={(event) => handleChange(event.target.value)}
          disabled={updateConnection.isPending || audioConnections.length === 0}
          className="mari-chrome-field h-9 min-w-0 flex-1 px-2 py-0 text-[0.6875rem]"
          aria-label={localizeUi("ui.connections.audioconnectionpicker.audioConnection")}
        >
          <option value="">
            {audioConnections.length === 0
              ? localizeUi("ui.connections.audioconnectionpicker.noAudioConnectionsYet")
              : localizeUi("ui.connections.audioconnectionpicker.useTheFallbackThenTheTextToSpeechSettings")}
          </option>
          {audioConnections.map((connection) => {
            const source = sourceLabel(connection.audioSource);
            return (
              <option key={connection.id} value={connection.id}>
                {source
                  ? localizeUi("ui.connections.audioconnectionpicker.value1Value2", {
                      value1: connection.name,
                      value2: source,
                    })
                  : connection.name}
              </option>
            );
          })}
        </select>
        <button
          type="button"
          onClick={() =>
            selected ? openConnectionDetail(selected.id) : openModal("create-connection", { initialProvider: "audio" })
          }
          className="mari-chrome-control mari-chrome-control--small shrink-0 text-xs"
        >
          {selected
            ? localizeUi("ui.connections.audioconnectionpicker.edit")
            : localizeUi("ui.connections.audioconnectionpicker.create")}
        </button>
      </div>

      {speaksSomethingElse && (
        <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
          {resolvedName
            ? localizeUi("ui.connections.audioconnectionpicker.speakingThroughValue1", {
                value1: resolvedName,
              })
            : localizeUi("ui.connections.audioconnectionpicker.speakingThroughLegacySettings", {
                value1: resolvedSourceName,
              })}
        </p>
      )}
    </div>
  );
}
