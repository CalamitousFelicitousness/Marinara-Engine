// ──────────────────────────────────────────────
// TTS Configuration Card (Connections Panel)
// ──────────────────────────────────────────────
import { useState, useEffect, useMemo, useRef } from "react";
import { Volume2, Check, Loader2, Play, Square, ChevronDown, ChevronUp, Download } from "lucide-react";
import { cn } from "../../../lib/utils";
import { toast } from "sonner";
import { useEffectiveTTSConfig, useTTSConfig, useUpdateTTSConfig } from "../../../hooks/use-tts";
import { useConnections } from "../../../hooks/use-connections";
import { useUIStore } from "../../../stores/ui.store";
import { ttsService } from "../../../lib/tts-service";
import {
  listCachedTTSAudioEntries,
  listCachedTTSAudioMeta,
  type CachedTTSAudioExportEntry,
} from "../../../lib/tts-audio-cache";
import type { TTSConfig, TTSConversationCallAudioInputMode } from "@marinara-engine/shared";
import { ttsConfigSchema } from "@marinara-engine/shared";
import {
  TTS_DIALOGUE_PAUSE_DEFAULT_SECONDS,
  TTS_DIALOGUE_PAUSE_MAX_SECONDS,
  TTS_DIALOGUE_PAUSE_MIN_SECONDS,
  TTS_SOURCE_DEFINITIONS,
} from "@marinara-engine/shared";
import { HelpTooltip } from "../../ui/HelpTooltip";
import { SettingsCheckbox, SettingsSwitch } from "./SettingControls";
import { useTranslation as useUiTranslation } from "react-i18next";
import { INPUT_CLS } from "../../connections/audio/voice-controls";

// ── Sub-components ───────────────────────────────

function FieldRow({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <span className="text-xs font-medium text-[var(--foreground)]">{label}</span>
        {help && <HelpTooltip text={help} />}
      </div>
      {children}
    </div>
  );
}

type TTSLanguageConnectionOption = {
  id: string;
  name: string;
  model: string;
  defaultForAgents: unknown;
};

function isTTSLanguageConnectionOption(value: unknown): value is TTSLanguageConnectionOption {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const connection = value as Record<string, unknown>;
  return (
    typeof connection.id === "string" &&
    typeof connection.name === "string" &&
    typeof connection.model === "string" &&
    connection.provider !== "image_generation" &&
    connection.provider !== "video_generation" &&
    connection.provider !== "audio"
  );
}

function isDefaultAgentTTSConnection(connection: TTSLanguageConnectionOption): boolean {
  return connection.defaultForAgents === true || connection.defaultForAgents === "true";
}

function formatCacheBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function extensionForTTSBlob(blob: Blob): string {
  const type = blob.type.toLowerCase();
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  if (type.includes("wav")) return "wav";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("webm")) return "webm";
  if (type.includes("mp4") || type.includes("m4a")) return "m4a";
  return "audio";
}

function safeTTSFileStem(value: string): string {
  return (
    value
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "tts-clip"
  );
}

function downloadTTSClip(entry: CachedTTSAudioExportEntry, index: number): void {
  const url = URL.createObjectURL(entry.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${String(index + 1).padStart(3, "0")}-${safeTTSFileStem(entry.key)}.${extensionForTTSBlob(entry.blob)}`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <SettingsCheckbox label={label} checked={checked} onChange={onChange} align="between" />;
}

// ── Main card ─────────────────────────────────────

export function TTSConfigCard() {
  const { t: localizeUi } = useUiTranslation();
  const { data: savedConfig, isLoading } = useTTSConfig();
  const updateConfig = useUpdateTTSConfig();
  const { data: connections } = useConnections();
  // What a speak request would actually reach, so the card reports the engine
  // rather than guessing from settings it no longer owns.
  const { data: effectiveConfig } = useEffectiveTTSConfig();
  const resolvedConnectionId = effectiveConfig?.resolvedConnectionId ?? null;
  const resolvedConnectionName = effectiveConfig?.resolvedConnectionName ?? null;
  const resolvedSourceName = effectiveConfig ? TTS_SOURCE_DEFINITIONS[effectiveConfig.resolvedSource].name : "";
  const speechEnabled = effectiveConfig?.speechEnabled ?? false;
  const openConnectionDetail = useUIStore((state) => state.openConnectionDetail);
  const openModal = useUIStore((state) => state.openModal);

  // Local draft state
  // Local draft state: playback policy only. How an engine speaks lives on the
  // audio connection that speaks it.
  const [enabled, setEnabled] = useState(false);
  const [autoplayRP, setAutoplayRP] = useState(false);
  const [autoplayConvo, setAutoplayConvo] = useState(false);
  const [autoplayGame, setAutoplayGame] = useState(false);
  const [progressivePlayback, setProgressivePlayback] = useState(false);
  const [dialogueOnly, setDialogueOnly] = useState(false);
  const [roleplaySpeakerExtractorEnabled, setRoleplaySpeakerExtractorEnabled] = useState(false);
  const [roleplaySpeakerExtractorConnectionId, setRoleplaySpeakerExtractorConnectionId] = useState("");
  const [roleplaySpeakerExtractorEmotionsEnabled, setRoleplaySpeakerExtractorEmotionsEnabled] = useState(false);
  const [dialoguePauseSeconds, setDialoguePauseSeconds] = useState(TTS_DIALOGUE_PAUSE_DEFAULT_SECONDS);
  const [callAudioEnabled, setCallAudioEnabled] = useState(false);
  const [callAudioInputMode, setCallAudioInputMode] = useState<TTSConversationCallAudioInputMode>("local_whisper");
  const [callVideoInputEnabled, setCallVideoInputEnabled] = useState(false);
  const [callCharacterVideoEnabled, setCallCharacterVideoEnabled] = useState(false);
  const [callAutomaticVideoClipsEnabled, setCallAutomaticVideoClipsEnabled] = useState(false);
  const [callCustomVideoClipsEnabled, setCallCustomVideoClipsEnabled] = useState(false);

  const [expanded, setExpanded] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ttsState, setTTSState] = useState(ttsService.getState());
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [ttsCacheSummary, setTtsCacheSummary] = useState({ count: 0, bytes: 0 });
  const [exportingTtsCache, setExportingTtsCache] = useState(false);

  // Populate draft from server on load
  useEffect(() => {
    if (!savedConfig) return;
    setEnabled(savedConfig.enabled);
    setAutoplayRP(savedConfig.autoplayRP);
    setAutoplayConvo(savedConfig.autoplayConvo);
    setAutoplayGame(savedConfig.autoplayGame);
    setProgressivePlayback(savedConfig.progressivePlayback ?? false);
    setDialogueOnly(savedConfig.dialogueOnly ?? false);
    setRoleplaySpeakerExtractorEnabled(savedConfig.roleplaySpeakerExtractorEnabled ?? false);
    setRoleplaySpeakerExtractorConnectionId(savedConfig.roleplaySpeakerExtractorConnectionId ?? "");
    setRoleplaySpeakerExtractorEmotionsEnabled(savedConfig.roleplaySpeakerExtractorEmotionsEnabled ?? false);
    setDialoguePauseSeconds((savedConfig.dialoguePauseMs ?? TTS_DIALOGUE_PAUSE_DEFAULT_SECONDS * 1000) / 1000);
    setCallAudioEnabled(savedConfig.callAudioEnabled ?? false);
    setCallAudioInputMode(savedConfig.callAudioInputMode ?? "local_whisper");
    setCallVideoInputEnabled(savedConfig.callVideoInputEnabled ?? false);
    setCallCharacterVideoEnabled(savedConfig.callCharacterVideoEnabled ?? false);
    setCallAutomaticVideoClipsEnabled(savedConfig.callAutomaticVideoClipsEnabled ?? false);
    setCallCustomVideoClipsEnabled(savedConfig.callCustomVideoClipsEnabled ?? false);
    setSaveStatus("idle");
  }, [savedConfig]);

  // Track TTS playback state for the preview button
  useEffect(
    () =>
      ttsService.subscribe((s) => {
        setTTSState(s);
        if (s === "error") {
          setPreviewError(ttsService.getLastError() ?? "TTS preview failed.");
        }
      }),
    [],
  );

  // Clear debounce timer on unmount
  useEffect(
    () => () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    void listCachedTTSAudioMeta().then((entries) => {
      if (cancelled) return;
      setTtsCacheSummary({
        count: entries.length,
        bytes: entries.reduce((total, entry) => total + Math.max(0, entry.size || 0), 0),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, ttsState]);

  // Spreads what the server last returned, then overrides only the playback
  // fields this card owns. ttsConfigSchema fills absent fields with defaults and
  // the storage layer reads a blank key as an explicit clear, so a partial
  // payload would wipe stored credentials and every saved source profile.
  const buildPayload = (overrides?: Partial<TTSConfig>): TTSConfig => ({
    ...ttsConfigSchema.parse(savedConfig ?? {}),
    enabled,
    autoplayRP,
    autoplayConvo,
    autoplayGame,
    progressivePlayback,
    dialogueOnly,
    roleplaySpeakerExtractorEnabled,
    roleplaySpeakerExtractorConnectionId,
    roleplaySpeakerExtractorEmotionsEnabled,
    dialoguePauseMs: dialoguePauseSeconds * 1000,
    callAudioEnabled,
    callSttConnectionId: "",
    callSttModel: "",
    callAudioInputMode,
    callVideoInputEnabled,
    callCharacterVideoEnabled,
    callAutomaticVideoClipsEnabled,
    callCustomVideoClipsEnabled,
    // Soundboard is intentionally always-on for Conversation Calls. Saving this card also migrates old false values.
    callSoundboardEnabled: true,
    ...overrides,
  });

  const saveNow = async (payload: TTSConfig) => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setSaveStatus("saving");
    await updateConfig.mutateAsync(payload);
    setSaveStatus("saved");
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(() => {
      setSaveStatus((s) => (s === "saved" ? "idle" : s));
      statusTimerRef.current = null;
    }, 2000);
  };

  const mark = (overrides?: Partial<TTSConfig>) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus("idle");
    setPreviewError(null);
    const payload = buildPayload(overrides);
    saveTimerRef.current = setTimeout(async () => {
      try {
        await saveNow(payload);
      } catch {
        setSaveStatus("error");
        toast.error(localizeUi("ui.panels.ttsconfigcard.failedToSaveTtsSettings"));
      }
    }, 600);
  };

  const handlePreview = () => {
    if (ttsState === "playing" || ttsState === "loading") {
      ttsService.stop();
      return;
    }
    setPreviewError(null);
    void (async () => {
      try {
        try {
          await saveNow(buildPayload());
        } catch {
          setSaveStatus("error");
          throw new Error("Failed to save TTS settings before preview.");
        }
        // Names no connection, so it reaches whatever autoplay would.
        await ttsService.speak(localizeUi("ui.panels.ttsconfigcard.testPlaybackSentence"), "tts-preview", {
          throwOnError: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "TTS preview failed.";
        setPreviewError(message);
        toast.error(message);
      }
    })();
  };
  const handleExportCachedClips = async () => {
    setExportingTtsCache(true);
    try {
      const entries = await listCachedTTSAudioEntries();
      if (entries.length === 0) {
        toast.info(localizeUi("ui.panels.ttsconfigcard.noCachedTtsClipsToExportYet"));
        setTtsCacheSummary({ count: 0, bytes: 0 });
        return;
      }

      entries.forEach((entry, index) => downloadTTSClip(entry, index));
      setTtsCacheSummary({
        count: entries.length,
        bytes: entries.reduce((total, entry) => total + Math.max(0, entry.size || entry.blob.size), 0),
      });
      toast.success(
        localizeUi("ui.panels.ttsconfigcard.exportedValue1CachedTtsClipValue2", {
          value1: entries.length,
          value2: entries.length === 1 ? "" : localizeUi("ui.noodle.stageprofileview.s"),
        }),
      );
    } catch {
      toast.error(localizeUi("ui.panels.ttsconfigcard.failedToExportCachedTtsClips"));
    } finally {
      setExportingTtsCache(false);
    }
  };

  const languageConnectionOptions = useMemo(
    () => (connections ?? []).filter(isTTSLanguageConnectionOption).sort((a, b) => a.name.localeCompare(b.name)),
    [connections],
  );
  const defaultAgentConnection = languageConnectionOptions.find(isDefaultAgentTTSConnection) ?? null;
  const selectedExtractorConnectionMissing =
    !!roleplaySpeakerExtractorConnectionId &&
    !languageConnectionOptions.some((connection) => connection.id === roleplaySpeakerExtractorConnectionId);
  const previewDisabled = !speechEnabled || ttsState === "loading";
  const previewTitle = !speechEnabled
    ? localizeUi("ui.panels.ttsconfigcard.enableTtsFirst")
    : ttsState === "playing"
      ? localizeUi("ui.panels.ttsconfigcard.stopPreview")
      : localizeUi("ui.panels.ttsconfigcard.testPlayback");
  if (isLoading) return null;

  return (
    <div
      className={cn(
        "rounded-xl border border-sky-400/20 bg-gradient-to-br from-sky-400/5 to-blue-500/5 p-3 transition-all",
        expanded && "border-sky-400/30",
      )}
    >
      {/* ── Header ── */}
      <div className="flex items-center gap-2.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-400 to-blue-500 text-white shadow-sm">
          <Volume2 size="1rem" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{localizeUi("ui.panels.ttsconfigcard.textToSpeech")}</div>
          <div className="truncate text-[0.6875rem] text-[var(--muted-foreground)]">
            {!enabled
              ? localizeUi("ui.panels.ttsconfigcard.speechIsOff")
              : resolvedConnectionName
                ? localizeUi("ui.panels.ttsconfigcard.value1Value2", {
                    value1: resolvedConnectionName,
                    value2: resolvedSourceName,
                  })
                : localizeUi("ui.panels.ttsconfigcard.noAudioConnectionConfiguredYet")}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Enable toggle */}
          <SettingsSwitch
            checked={enabled}
            onChange={(checked) => {
              setEnabled(checked);
              mark({ enabled: checked });
            }}
            ariaLabel={enabled ? "Disable TTS" : "Enable TTS"}
            title={
              enabled
                ? localizeUi("ui.panels.ttsconfigcard.disableTts")
                : localizeUi("ui.panels.ttsconfigcard.enableTts")
            }
            className="rounded-lg p-1 hover:bg-[var(--secondary)]"
          />

          <button
            onClick={() => setExpanded((v) => !v)}
            className="mari-chrome-control mari-chrome-control--small h-8 min-h-0 w-8 p-0"
            title={
              expanded ? localizeUi("ui.panels.ttsconfigcard.collapse") : localizeUi("ui.panels.ttsconfigcard.expand")
            }
          >
            {expanded ? <ChevronUp size="0.875rem" /> : <ChevronDown size="0.875rem" />}
          </button>
        </div>
      </div>

      {/* ── Expanded body ── */}
      {expanded && (
        <div className="mt-3 space-y-4 border-t border-sky-400/10 pt-3">
          {/* Which engine speaks. The settings live on the connection itself. */}
          <div className="flex items-center gap-2 rounded-xl border border-sky-400/15 bg-sky-400/5 px-2.5 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">{localizeUi("ui.panels.ttsconfigcard.voicedBy")}</div>
              <div className="truncate text-[0.625rem] text-[var(--muted-foreground)]">
                {resolvedConnectionName
                  ? localizeUi("ui.panels.ttsconfigcard.value1Value2", {
                      value1: resolvedConnectionName,
                      value2: resolvedSourceName,
                    })
                  : localizeUi("ui.panels.ttsconfigcard.noAudioConnectionConfiguredYet")}
              </div>
            </div>
            <button
              type="button"
              onClick={() =>
                resolvedConnectionId ? openConnectionDetail(resolvedConnectionId) : openModal("create-connection")
              }
              className="mari-chrome-control mari-chrome-control--small shrink-0 text-xs"
            >
              {resolvedConnectionId
                ? localizeUi("ui.panels.ttsconfigcard.editAudioConnection")
                : localizeUi("ui.panels.ttsconfigcard.createAudioConnection")}
            </button>
          </div>

          {/* Auto-play */}
          <div className="space-y-1">
            <span className="text-xs font-medium">{localizeUi("ui.panels.ttsconfigcard.autoPlay")}</span>
            <ToggleRow
              label={localizeUi("ui.panels.ttsconfigcard.roleplayMessages")}
              checked={autoplayRP}
              onChange={(v) => {
                setAutoplayRP(v);
                mark({ autoplayRP: v });
              }}
            />
            <ToggleRow
              label={localizeUi("ui.panels.ttsconfigcard.roleplaySpeakerExtractor")}
              checked={roleplaySpeakerExtractorEnabled}
              onChange={(value) => {
                setRoleplaySpeakerExtractorEnabled(value);
                mark({ roleplaySpeakerExtractorEnabled: value });
              }}
            />
            {roleplaySpeakerExtractorEnabled && (
              <div className="ml-2 space-y-2 rounded-xl border border-[var(--border)] bg-[var(--secondary)]/35 p-2.5">
                <FieldRow
                  label={localizeUi("ui.panels.ttsconfigcard.speakerExtractorConnection")}
                  help={localizeUi("ui.panels.ttsconfigcard.speakerExtractorConnectionHelp")}
                >
                  <select
                    value={roleplaySpeakerExtractorConnectionId}
                    onChange={(event) => {
                      const connectionId = event.target.value;
                      setRoleplaySpeakerExtractorConnectionId(connectionId);
                      mark({ roleplaySpeakerExtractorConnectionId: connectionId });
                    }}
                    className={cn(INPUT_CLS, "cursor-pointer appearance-none")}
                  >
                    <option value="">
                      {defaultAgentConnection
                        ? localizeUi("ui.panels.ttsconfigcard.defaultAgentConnectionNamed", {
                            name: defaultAgentConnection.name,
                          })
                        : localizeUi("ui.panels.ttsconfigcard.defaultAgentConnectionNotConfigured")}
                    </option>
                    {selectedExtractorConnectionMissing && (
                      <option value={roleplaySpeakerExtractorConnectionId}>
                        {localizeUi("ui.panels.ttsconfigcard.selectedConnectionUnavailable")}
                      </option>
                    )}
                    {languageConnectionOptions.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.model
                          ? localizeUi("ui.panels.ttsconfigcard.connectionNameAndModel", {
                              name: connection.name,
                              model: connection.model,
                            })
                          : connection.name}
                      </option>
                    ))}
                  </select>
                </FieldRow>
                {languageConnectionOptions.length === 0 && (
                  <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
                    {localizeUi("ui.panels.ttsconfigcard.noLanguageModelConnectionsAvailable")}
                  </p>
                )}
                <ToggleRow
                  label={localizeUi("ui.panels.ttsconfigcard.enableEmotionIndicators")}
                  checked={roleplaySpeakerExtractorEmotionsEnabled}
                  onChange={(value) => {
                    setRoleplaySpeakerExtractorEmotionsEnabled(value);
                    mark({ roleplaySpeakerExtractorEmotionsEnabled: value });
                  }}
                />
                <p className="text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
                  {localizeUi("ui.panels.ttsconfigcard.roleplaySpeakerExtractorHelp")}
                </p>
              </div>
            )}
            <ToggleRow
              label={localizeUi("ui.panels.ttsconfigcard.conversationMessages")}
              checked={autoplayConvo}
              onChange={(v) => {
                setAutoplayConvo(v);
                mark({ autoplayConvo: v });
              }}
            />
            <ToggleRow
              label={localizeUi("ui.panels.ttsconfigcard.gameNarration")}
              checked={autoplayGame}
              onChange={(v) => {
                setAutoplayGame(v);
                mark({ autoplayGame: v });
              }}
            />
            <ToggleRow
              label={localizeUi("ui.panels.ttsconfigcard.progressivePlayback")}
              checked={progressivePlayback}
              onChange={(v) => {
                setProgressivePlayback(v);
                mark({ progressivePlayback: v });
              }}
            />
            <ToggleRow
              label={localizeUi("ui.panels.ttsconfigcard.onlyReadDialogues")}
              checked={dialogueOnly}
              onChange={(v) => {
                setDialogueOnly(v);
                mark({ dialogueOnly: v });
              }}
            />
            {dialogueOnly && (
              <FieldRow
                label={localizeUi("ui.panels.ttsconfigcard.pauseBetweenDialoguesValue1Value2", {
                  value1: dialoguePauseSeconds,
                  value2:
                    dialoguePauseSeconds === 1
                      ? localizeUi("ui.panels.ttsconfigcard.second")
                      : localizeUi("ui.panels.ttsconfigcard.seconds"),
                })}
                help={localizeUi("ui.panels.ttsconfigcard.addsSilenceBetweenSeparateDialogueLinesInTheSame")}
              >
                <input
                  type="range"
                  aria-label={localizeUi("ui.panels.ttsconfigcard.pauseBetweenDialoguesInSeconds")}
                  min={TTS_DIALOGUE_PAUSE_MIN_SECONDS}
                  max={TTS_DIALOGUE_PAUSE_MAX_SECONDS}
                  step={1}
                  value={dialoguePauseSeconds}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setDialoguePauseSeconds(next);
                    mark({ dialoguePauseMs: next * 1000 });
                  }}
                  className="w-full accent-[var(--primary)]"
                />
                <div className="flex justify-between text-[0.6rem] text-[var(--muted-foreground)]">
                  <span>
                    {TTS_DIALOGUE_PAUSE_MIN_SECONDS} {localizeUi("ui.noodle.stageprofileview.s")}
                  </span>
                  <span>
                    {TTS_DIALOGUE_PAUSE_MAX_SECONDS} {localizeUi("ui.noodle.stageprofileview.s")}
                  </span>
                </div>
              </FieldRow>
            )}
          </div>

          <div className="flex items-center gap-2 rounded-xl border border-sky-400/15 bg-sky-400/5 px-2.5 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium">{localizeUi("ui.panels.ttsconfigcard.cachedClips")}</div>
              <div className="truncate text-[0.625rem] text-[var(--muted-foreground)]">
                {ttsCacheSummary.count} {localizeUi("ui.panels.ttsconfigcard.clip")}
                {ttsCacheSummary.count === 1 ? "" : localizeUi("ui.noodle.stageprofileview.s")} ·{" "}
                {formatCacheBytes(ttsCacheSummary.bytes)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleExportCachedClips()}
              disabled={exportingTtsCache || ttsCacheSummary.count === 0}
              className="mari-chrome-control mari-chrome-control--small shrink-0 text-xs"
              title={localizeUi("ui.panels.ttsconfigcard.exportCachedTtsClips")}
            >
              {exportingTtsCache ? <Loader2 size="0.75rem" className="animate-spin" /> : <Download size="0.75rem" />}
            </button>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            {/* Preview */}
            <button
              onClick={handlePreview}
              disabled={previewDisabled}
              className={cn(
                "flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs ring-1 transition-all",
                ttsState === "playing"
                  ? "bg-sky-500/10 text-sky-400 ring-sky-400/30 hover:bg-sky-500/20"
                  : "bg-[var(--secondary)] text-[var(--muted-foreground)] ring-[var(--border)] hover:text-[var(--foreground)] hover:ring-sky-400/60",
                previewDisabled && "cursor-not-allowed opacity-50",
              )}
              title={previewTitle}
            >
              {ttsState === "loading" ? (
                <Loader2 size="0.75rem" className="animate-spin" />
              ) : ttsState === "playing" ? (
                <Square size="0.75rem" />
              ) : (
                <Play size="0.75rem" />
              )}
              {ttsState === "loading"
                ? localizeUi("ui.panels.ttsconfigcard.loading")
                : ttsState === "playing"
                  ? localizeUi("ui.chat.summarypopover.stop")
                  : localizeUi("settings.notifications.customSound.actions.preview")}
            </button>

            <div className="flex-1" />

            {/* Auto-save status */}
            {saveStatus === "saving" && (
              <span className="flex items-center gap-1 text-[0.6875rem] text-[var(--muted-foreground)]">
                <Loader2 size="0.625rem" className="animate-spin" />
                {localizeUi("chat.settings.inlineEditor.saving")}
              </span>
            )}
            {saveStatus === "saved" && (
              <span className="flex items-center gap-1 text-[0.6875rem] text-emerald-400">
                <Check size="0.625rem" />
                {localizeUi("chat.settings.inlineEditor.saved")}
              </span>
            )}
            {saveStatus === "error" && (
              <span className="text-[0.6875rem] text-[var(--destructive)]">
                {localizeUi("ui.panels.ttsconfigcard.saveFailed")}
              </span>
            )}
          </div>
          {previewError && (
            <p className="rounded-lg border border-[var(--destructive)]/20 bg-[var(--destructive)]/10 px-2.5 py-2 text-[0.6875rem] leading-relaxed text-[var(--destructive)]">
              {previewError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
