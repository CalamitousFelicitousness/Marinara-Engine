// ──────────────────────────────────────────────
// Settings: Tracker Presets
// ──────────────────────────────────────────────
// Global library of tracker layouts plus the app-wide selection. A preset is a
// base layer, never a replacement: card and live tracker values win every name
// collision, so applying one is additive and idempotent.
//
// Saving is explicit. The draft is local until Save, matching the author's-note
// preset panel, so switching rows never writes a half-typed field name.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Layers, Loader2, Plus, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { toast } from "sonner";
import type { CharacterTrackerCustomFieldDefault, RPGStatPool, TrackerPreset } from "@marinara-engine/shared";
import { comparableTrackerName } from "@marinara-engine/shared";
import {
  useActiveTrackerPresetId,
  useApplyTrackerPreset,
  useExtractTrackerPreset,
  useCreateTrackerPreset,
  useDeleteTrackerPreset,
  useSetActiveTrackerPreset,
  useSetTrackerAutoAdopt,
  useTrackerAutoAdopt,
  useTrackerPresets,
  useUpdateTrackerPreset,
} from "../../../hooks/use-tracker-presets";
import { useChat, useUpdateChatMetadata } from "../../../hooks/use-chats";
import { useChatStore } from "../../../stores/chat.store";
import { useGameStateStore } from "../../../stores/game-state.store";
import { api } from "../../../lib/api-client";
import { cn } from "../../../lib/utils";
import { ToggleSetting } from "./SettingControls";

/** Sentinel for "inherit the global selection", distinct from an explicit none. */
const INHERIT = "__inherit__";

type FieldRow = CharacterTrackerCustomFieldDefault;
type StatRow = RPGStatPool;

interface PresetDraft {
  name: string;
  characterFields: FieldRow[];
  characterStats: StatRow[];
  personaFields: FieldRow[];
  personaStats: StatRow[];
}

const ROW_ACTIONS =
  "absolute right-2 top-1/2 -translate-y-1/2 flex shrink-0 items-center gap-0.5 rounded-lg bg-[var(--sidebar)] px-1 py-0.5 opacity-0 shadow-sm ring-1 ring-[var(--border)] transition-opacity group-hover:opacity-100 max-md:opacity-100";
const INPUT =
  "min-w-0 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-2 py-1.5 text-[0.6875rem] text-[var(--foreground)] outline-none transition-shadow focus:ring-1 focus:ring-[var(--primary)]";
const GHOST_BUTTON =
  "inline-flex items-center gap-1 rounded-sm bg-[var(--foreground)]/8 px-2 py-1 text-[0.625rem] font-medium text-[var(--foreground)]/75 ring-1 ring-[var(--border)]/70 transition-colors hover:bg-[var(--foreground)]/12 hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] active:scale-95 disabled:cursor-not-allowed disabled:opacity-60";

function toDraft(preset: TrackerPreset): PresetDraft {
  return {
    name: preset.name,
    characterFields: [...(preset.characterFields ?? [])],
    characterStats: [...(preset.characterStats ?? [])],
    personaFields: [...(preset.personaFields ?? [])],
    personaStats: [...(preset.personaStats ?? [])],
  };
}

/**
 * Append extracted rows the draft does not already name.
 *
 * Additive on purpose: the button never rewrites a row you typed, so pressing
 * it twice is a no-op and it cannot clobber a hand-tuned starting value.
 */
function appendNewRows<T extends { name: string }>(draftRows: T[], incoming: T[]): T[] {
  const known = new Set(draftRows.map((row) => comparableTrackerName(row.name)).filter(Boolean));
  const added = incoming.filter((row) => {
    const key = comparableTrackerName(row.name);
    return key && !known.has(key);
  });
  return added.length > 0 ? [...draftRows, ...added] : draftRows;
}

/** Drop half-typed rows so a nameless field never reaches the tracker. */
function cleanDraft(draft: PresetDraft) {
  return {
    name: draft.name.trim() || "Untitled preset",
    characterFields: draft.characterFields.filter((row) => row.name.trim()),
    characterStats: draft.characterStats.filter((row) => row.name.trim()),
    personaFields: draft.personaFields.filter((row) => row.name.trim()),
    personaStats: draft.personaStats.filter((row) => row.name.trim()),
  };
}

function FieldRows({
  rows,
  onChange,
  namePlaceholder,
  valuePlaceholder,
}: {
  rows: FieldRow[];
  onChange: (rows: FieldRow[]) => void;
  namePlaceholder: string;
  valuePlaceholder: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1">
          <input
            value={row.name}
            onChange={(event) =>
              onChange(rows.map((entry, i) => (i === index ? { ...entry, name: event.target.value } : entry)))
            }
            placeholder={namePlaceholder}
            className={cn(INPUT, "flex-1")}
          />
          <input
            value={row.value}
            onChange={(event) =>
              onChange(rows.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)))
            }
            placeholder={valuePlaceholder}
            className={cn(INPUT, "flex-1")}
          />
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
            className="shrink-0 rounded-sm p-1 text-[var(--destructive)] transition-colors hover:bg-[var(--foreground)]/8 active:scale-90"
          >
            <X size="0.75rem" />
          </button>
        </div>
      ))}
    </div>
  );
}

function StatRows({
  rows,
  onChange,
  namePlaceholder,
}: {
  rows: StatRow[];
  onChange: (rows: StatRow[]) => void;
  namePlaceholder: string;
}) {
  const patch = (index: number, next: Partial<StatRow>) =>
    onChange(rows.map((entry, i) => (i === index ? { ...entry, ...next } : entry)));

  return (
    <div className="flex flex-col gap-1">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-1">
          <input
            value={row.name}
            onChange={(event) => patch(index, { name: event.target.value })}
            placeholder={namePlaceholder}
            className={cn(INPUT, "flex-1")}
          />
          <input
            type="number"
            value={row.value}
            onChange={(event) => patch(index, { value: Number(event.target.value) || 0 })}
            className={cn(INPUT, "w-14")}
          />
          <input
            type="number"
            value={row.max}
            onChange={(event) => patch(index, { max: Math.max(1, Number(event.target.value) || 1) })}
            className={cn(INPUT, "w-14")}
          />
          <input
            type="color"
            value={row.color}
            onChange={(event) => patch(index, { color: event.target.value })}
            className="h-7 w-8 shrink-0 cursor-pointer rounded-md border border-[var(--border)] bg-[var(--secondary)]"
          />
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
            className="shrink-0 rounded-sm p-1 text-[var(--destructive)] transition-colors hover:bg-[var(--foreground)]/8 active:scale-90"
          >
            <X size="0.75rem" />
          </button>
        </div>
      ))}
    </div>
  );
}

function Group({
  label,
  hint,
  onAdd,
  children,
}: {
  label: string;
  hint?: string;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="text-[0.625rem] font-medium text-[var(--foreground)]">{label}</span>
        <button type="button" onClick={onAdd} className={GHOST_BUTTON}>
          <Plus size="0.625rem" />
        </button>
      </div>
      {children}
      {hint && <p className="px-0.5 text-[0.5625rem] leading-relaxed text-[var(--muted-foreground)]">{hint}</p>}
    </div>
  );
}

export function TrackerPresetSettings() {
  const { t: localizeUi } = useUiTranslation();
  const activeChatId = useChatStore((s) => s.activeChatId);
  const { data: activeChat } = useChat(activeChatId);

  const { data: presets, isLoading } = useTrackerPresets();
  const { data: activePresetId } = useActiveTrackerPresetId();
  const setActive = useSetActiveTrackerPreset();
  const { data: autoAdopt } = useTrackerAutoAdopt();
  const setAutoAdopt = useSetTrackerAutoAdopt();
  const createPreset = useCreateTrackerPreset();
  const updatePreset = useUpdateTrackerPreset();
  const deletePreset = useDeleteTrackerPreset();
  const applyPreset = useApplyTrackerPreset();
  const extractPreset = useExtractTrackerPreset();
  const updateChatMetadata = useUpdateChatMetadata();
  const setGameState = useGameStateStore((s) => s.setGameState);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PresetDraft | null>(null);

  const editing = useMemo(
    () => (editingId ? (presets ?? []).find((preset) => preset.id === editingId) : undefined),
    [editingId, presets],
  );

  // Load the row into the draft only when the identity changes, so a save that
  // refetches the list does not wipe keystrokes typed since.
  useEffect(() => {
    setDraft(editing ? toDraft(editing) : null);
  }, [editing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => {
    if (!editing || !draft) return false;
    return JSON.stringify(toDraft(editing)) !== JSON.stringify(draft);
  }, [draft, editing]);

  const handleCreate = useCallback(async () => {
    const created = await createPreset.mutateAsync({
      name: localizeUi("ui.panels.trackerpresetsettings.newPreset"),
      characterFields: [],
      characterStats: [],
      personaFields: [],
      personaStats: [],
    });
    if (created?.id) setEditingId(created.id);
  }, [createPreset, localizeUi]);

  const handleDuplicate = useCallback(
    async (preset: TrackerPreset) => {
      const created = await createPreset.mutateAsync({
        ...cleanDraft(toDraft(preset)),
        name: localizeUi("ui.panels.trackerpresetsettings.copyOfValue1", { value1: preset.name }),
      });
      if (created?.id) setEditingId(created.id);
    },
    [createPreset, localizeUi],
  );

  const handleDelete = useCallback(
    async (preset: TrackerPreset) => {
      if (!confirm(localizeUi("ui.panels.trackerpresetsettings.deleteValue1", { value1: preset.name }))) return;
      await deletePreset.mutateAsync(preset.id);
      setEditingId((current) => (current === preset.id ? null : current));
    },
    [deletePreset, localizeUi],
  );

  const handleSave = useCallback(async () => {
    if (!editing || !draft) return;
    try {
      await updatePreset.mutateAsync({ id: editing.id, ...cleanDraft(draft) });
      toast.success(localizeUi("ui.panels.trackerpresetsettings.presetSaved"));
    } catch {
      toast.error(localizeUi("ui.panels.trackerpresetsettings.presetSaveFailed"));
    }
  }, [draft, editing, localizeUi, updatePreset]);

  const handleApply = useCallback(async () => {
    if (!activeChatId) return;
    try {
      const result = await applyPreset.mutateAsync({ chatId: activeChatId });
      if (!result.applied) {
        toast.info(localizeUi("ui.panels.trackerpresetsettings.noPresetAppliesToThisChat"));
        return;
      }
      // Tracker state is a Zustand store fed by a direct GET, not React Query,
      // so nothing invalidates it for us.
      const refreshed = await api.get<Parameters<typeof setGameState>[0]>(`/chats/${activeChatId}/game-state`);
      setGameState(refreshed ?? null);
      toast.success(
        localizeUi("ui.panels.trackerpresetsettings.appliedValue1ToValue2Characters", {
          value1: result.presetName ?? "",
          value2: result.characters,
        }),
      );
    } catch {
      toast.error(localizeUi("ui.panels.trackerpresetsettings.applyFailed"));
    }
  }, [activeChatId, applyPreset, localizeUi, setGameState]);

  const handleBuildFromChat = useCallback(async () => {
    if (!activeChatId || !draft) return;
    try {
      const extracted = await extractPreset.mutateAsync(activeChatId);
      const next: PresetDraft = {
        ...draft,
        characterFields: appendNewRows(draft.characterFields, extracted.characterFields),
        characterStats: appendNewRows(draft.characterStats, extracted.characterStats),
        personaFields: appendNewRows(draft.personaFields, extracted.personaFields),
        personaStats: appendNewRows(draft.personaStats, extracted.personaStats),
      };
      const added =
        next.characterFields.length -
        draft.characterFields.length +
        (next.characterStats.length - draft.characterStats.length) +
        (next.personaFields.length - draft.personaFields.length) +
        (next.personaStats.length - draft.personaStats.length);
      if (added === 0) {
        toast.info(localizeUi("ui.panels.trackerpresetsettings.nothingNewToBuildFrom"));
        return;
      }
      setDraft(next);
      toast.success(localizeUi("ui.panels.trackerpresetsettings.addedValue1RowsFromThisChat", { value1: added }));
    } catch {
      toast.error(localizeUi("ui.panels.trackerpresetsettings.buildFailed"));
    }
  }, [activeChatId, draft, extractPreset, localizeUi]);

  const isRoleplayChat = !!activeChatId && activeChat?.mode === "roleplay";

  const chatOverride = useMemo(() => {
    if (!activeChat) return INHERIT;
    const raw = activeChat.metadata;
    let metadata: Record<string, unknown> = {};
    if (typeof raw === "string") {
      // Never throw from a memo: malformed metadata would take the whole
      // settings panel down on render.
      try {
        metadata = (JSON.parse(raw || "{}") ?? {}) as Record<string, unknown>;
      } catch {
        return INHERIT;
      }
    } else if (raw && typeof raw === "object") {
      metadata = raw as Record<string, unknown>;
    }
    if (!("trackerPresetId" in metadata)) return INHERIT;
    const value = metadata.trackerPresetId;
    if (value === null) return "";
    return typeof value === "string" && value.trim() ? value : INHERIT;
  }, [activeChat]);

  const handleChatOverride = useCallback(
    (value: string) => {
      if (!activeChatId) return;
      updateChatMetadata.mutate({
        id: activeChatId,
        // Three states. The metadata PATCH merges keys and cannot delete one,
        // so "inherit" is stored as "" rather than by removing the key;
        // readChatTrackerPresetId treats "" and a missing key identically.
        trackerPresetId: value === INHERIT ? "" : value === "" ? null : value,
      });
    },
    [activeChatId, updateChatMetadata],
  );

  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-lg bg-[var(--background)]/36 p-1.5 ring-1 ring-[var(--border)]">
      <div className="flex min-h-5 items-center justify-between gap-2 px-0.5">
        <span className="inline-flex min-w-0 items-center gap-1 text-[0.625rem] font-medium text-[var(--foreground)]">
          <Layers size="0.6875rem" className="text-[var(--primary)]" />
          {localizeUi("ui.panels.trackerpresetsettings.trackerPresets")}
        </span>
        {isLoading && <Loader2 size="0.625rem" className="animate-spin text-[var(--muted-foreground)]" />}
      </div>

      <p className="rounded-md bg-[var(--secondary)]/42 px-2 py-2 text-[0.5625rem] leading-relaxed text-[var(--muted-foreground)]">
        {localizeUi("ui.panels.trackerpresetsettings.presetsDescription")}
      </p>

      <label className="grid gap-1">
        <span className="px-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
          {localizeUi("ui.panels.trackerpresetsettings.activePreset")}
        </span>
        <select
          value={activePresetId ?? ""}
          onChange={(event) => setActive.mutate(event.target.value || null)}
          className={INPUT}
        >
          <option value="">{localizeUi("ui.panels.trackerpresetsettings.none")}</option>
          {(presets ?? []).map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
            </option>
          ))}
        </select>
      </label>

      <ToggleSetting
        label={localizeUi("ui.panels.trackerpresetsettings.autoAdopt")}
        checked={autoAdopt === true}
        onChange={(enabled) => setAutoAdopt.mutate(enabled)}
        help={localizeUi("ui.panels.trackerpresetsettings.autoAdoptHelp")}
      />

      {isRoleplayChat && (
        <>
          <label className="grid gap-1">
            <span className="px-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
              {localizeUi("ui.panels.trackerpresetsettings.presetForThisChat")}
            </span>
            <select value={chatOverride} onChange={(event) => handleChatOverride(event.target.value)} className={INPUT}>
              <option value={INHERIT}>
                {localizeUi("ui.panels.trackerpresetsettings.useGlobalValue1", {
                  value1:
                    (presets ?? []).find((preset) => preset.id === activePresetId)?.name ??
                    localizeUi("ui.panels.trackerpresetsettings.none"),
                })}
              </option>
              <option value="">{localizeUi("ui.panels.trackerpresetsettings.noPresetForThisChat")}</option>
              {(presets ?? []).map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
          </label>

          <button type="button" onClick={handleApply} disabled={applyPreset.isPending} className={GHOST_BUTTON}>
            {applyPreset.isPending ? <Loader2 size="0.625rem" className="animate-spin" /> : <Wand2 size="0.625rem" />}
            {localizeUi("ui.panels.trackerpresetsettings.applyToThisChat")}
          </button>
          <p className="px-0.5 text-[0.5625rem] leading-relaxed text-[var(--muted-foreground)]">
            {localizeUi("ui.panels.trackerpresetsettings.applyHint")}
          </p>
        </>
      )}

      <div className="flex items-center justify-between gap-2 px-0.5 pt-1">
        <span className="text-[0.625rem] font-medium text-[var(--foreground)]">
          {localizeUi("ui.panels.trackerpresetsettings.library")}
        </span>
        <button type="button" onClick={handleCreate} disabled={createPreset.isPending} className={GHOST_BUTTON}>
          <Plus size="0.625rem" />
          {localizeUi("ui.panels.trackerpresetsettings.newPreset")}
        </button>
      </div>

      {(presets ?? []).length === 0 ? (
        <p className="rounded-md bg-[var(--secondary)]/42 px-2 py-2 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
          {localizeUi("ui.panels.trackerpresetsettings.noPresetsYet")}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {(presets ?? []).map((preset) => (
            <div
              key={preset.id}
              className={cn(
                "group relative rounded-md bg-[var(--secondary)]/42 ring-1 transition-colors",
                editingId === preset.id ? "ring-[var(--primary)]/60" : "ring-transparent hover:bg-[var(--accent)]/40",
              )}
            >
              <button
                type="button"
                onClick={() => setEditingId(editingId === preset.id ? null : preset.id)}
                className="flex w-full min-w-0 flex-col items-start gap-0.5 px-2 py-1.5 pr-16 text-left"
              >
                <span className="truncate text-[0.6875rem] font-medium text-[var(--foreground)]">{preset.name}</span>
                <span className="text-[0.5625rem] text-[var(--muted-foreground)]">
                  {localizeUi("ui.panels.trackerpresetsettings.rowSummaryValue1Value2Value3Value4", {
                    value1: preset.characterFields?.length ?? 0,
                    value2: preset.characterStats?.length ?? 0,
                    value3: preset.personaFields?.length ?? 0,
                    value4: preset.personaStats?.length ?? 0,
                  })}
                </span>
              </button>
              <div className={ROW_ACTIONS}>
                <button
                  type="button"
                  onClick={() => handleDuplicate(preset)}
                  title={localizeUi("ui.panels.trackerpresetsettings.duplicate")}
                  className="rounded-sm p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--foreground)]/8 active:scale-90"
                >
                  <Copy size="0.75rem" />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(preset)}
                  title={localizeUi("ui.panels.trackerpresetsettings.delete")}
                  className="rounded-sm p-1 text-[var(--destructive)] transition-colors hover:bg-[var(--foreground)]/8 active:scale-90"
                >
                  <Trash2 size="0.75rem" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && draft && (
        <div className="mt-1 flex flex-col gap-2 rounded-md bg-[var(--secondary)]/42 p-2">
          <label className="grid gap-1">
            <span className="px-0.5 text-[0.625rem] text-[var(--muted-foreground)]">
              {localizeUi("ui.panels.trackerpresetsettings.presetName")}
            </span>
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              className={INPUT}
            />
          </label>

          {activeChatId && (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                onClick={handleBuildFromChat}
                disabled={extractPreset.isPending}
                className={GHOST_BUTTON}
              >
                {extractPreset.isPending ? (
                  <Loader2 size="0.625rem" className="animate-spin" />
                ) : (
                  <Sparkles size="0.625rem" />
                )}
                {localizeUi("ui.panels.trackerpresetsettings.buildFromThisChat")}
              </button>
              <p className="px-0.5 text-[0.5625rem] leading-relaxed text-[var(--muted-foreground)]">
                {localizeUi("ui.panels.trackerpresetsettings.buildFromThisChatHint")}
              </p>
            </div>
          )}

          <Group
            label={localizeUi("ui.panels.trackerpresetsettings.characterFields")}
            hint={localizeUi("ui.panels.trackerpresetsettings.characterFieldsHint")}
            onAdd={() => setDraft({ ...draft, characterFields: [...draft.characterFields, { name: "", value: "" }] })}
          >
            <FieldRows
              rows={draft.characterFields}
              onChange={(characterFields) => setDraft({ ...draft, characterFields })}
              namePlaceholder={localizeUi("ui.panels.trackerpresetsettings.fieldNamePlaceholder")}
              valuePlaceholder={localizeUi("ui.panels.trackerpresetsettings.startingValuePlaceholder")}
            />
          </Group>

          <Group
            label={localizeUi("ui.panels.trackerpresetsettings.characterStats")}
            hint={localizeUi("ui.panels.trackerpresetsettings.characterStatsHint")}
            onAdd={() =>
              setDraft({
                ...draft,
                characterStats: [...draft.characterStats, { name: "", value: 100, max: 100, color: "#a78bfa" }],
              })
            }
          >
            <StatRows
              rows={draft.characterStats}
              onChange={(characterStats) => setDraft({ ...draft, characterStats })}
              namePlaceholder={localizeUi("ui.panels.trackerpresetsettings.statNamePlaceholder")}
            />
          </Group>

          <Group
            label={localizeUi("ui.panels.trackerpresetsettings.personaFields")}
            onAdd={() => setDraft({ ...draft, personaFields: [...draft.personaFields, { name: "", value: "" }] })}
          >
            <FieldRows
              rows={draft.personaFields}
              onChange={(personaFields) => setDraft({ ...draft, personaFields })}
              namePlaceholder={localizeUi("ui.panels.trackerpresetsettings.fieldNamePlaceholder")}
              valuePlaceholder={localizeUi("ui.panels.trackerpresetsettings.startingValuePlaceholder")}
            />
          </Group>

          <Group
            label={localizeUi("ui.panels.trackerpresetsettings.personaStats")}
            onAdd={() =>
              setDraft({
                ...draft,
                personaStats: [...draft.personaStats, { name: "", value: 100, max: 100, color: "#38bdf8" }],
              })
            }
          >
            <StatRows
              rows={draft.personaStats}
              onChange={(personaStats) => setDraft({ ...draft, personaStats })}
              namePlaceholder={localizeUi("ui.panels.trackerpresetsettings.statNamePlaceholder")}
            />
          </Group>

          <div className="flex items-center justify-end gap-1.5 px-0.5">
            {dirty && (
              <span className="text-[0.5625rem] text-[var(--primary)]">
                {localizeUi("ui.panels.trackerpresetsettings.edited")}
              </span>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || updatePreset.isPending}
              className={GHOST_BUTTON}
            >
              {updatePreset.isPending && <Loader2 size="0.625rem" className="animate-spin" />}
              {localizeUi("ui.panels.trackerpresetsettings.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
