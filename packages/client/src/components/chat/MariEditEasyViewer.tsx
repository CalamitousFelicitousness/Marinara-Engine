// #4919 Easy Viewer: a human-readable rendering of Professor Mari's edits for the Keep/Restore
// review card. Instead of the raw `app_data … {JSON}` command, it shows each affected row as a
// before/after diff (removed text red, added text green), with a lorebook-entry layout that
// resembles the editor users know. All data comes from approval.diffPreview (full before/after row
// snapshots) — no server call. Per-row Dismiss hides a reviewed change to reduce clutter; the
// card's Keep/Restore still governs the whole batch.

import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { computeFieldChanges, type FieldChange } from "../../lib/mari-edit-diff";
import { diffWords } from "../../lib/word-diff";
import type { MariDbPendingApproval, MariDbRowChange } from "@marinara-engine/shared";
import { Check, FileText, Pencil, Sparkles, Trash2 } from "lucide-react";

type Row = Record<string, unknown> | null | undefined;

export function rowKey(change: MariDbRowChange): string {
  return `${change.table}:${change.id}:${change.action}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(row: Row, key: string): string {
  const value = row?.[key];
  return value === null || value === undefined ? "" : String(value);
}

function truthy(value: unknown): boolean {
  return value === true || value === 1 || value === "true" || value === "1";
}

function csvToList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return value.split(",").map((v) => v.trim()).filter(Boolean);
  return [];
}

// ── Inline text diff (removed red / added green) ────────────────────────────

function InlineTextDiff({ before, after }: { before: string; after: string }) {
  const segments = diffWords(before, after);
  return (
    <span className="whitespace-pre-wrap break-words">
      {segments.map((seg, i) => {
        if (seg.type === "equal") return <span key={i}>{seg.value}</span>;
        if (seg.type === "added") {
          return (
            <span key={i} className="rounded bg-emerald-500/25 text-[var(--foreground)]">
              {seg.value}
            </span>
          );
        }
        return (
          <span key={i} className="rounded bg-[var(--destructive)]/25 text-[var(--foreground)] line-through">
            {seg.value}
          </span>
        );
      })}
    </span>
  );
}

function EmptyValue() {
  const { t: localizeUi } = useUiTranslation();
  return <span className="italic opacity-60">{localizeUi("ui.chat.mariediteasyviewer.empty")}</span>;
}

// A single changed field: unified inline diff when both sides exist, otherwise a single
// green (added) or red (removed) block.
function FieldChangeView({ change }: { change: FieldChange }) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
        {change.label}
      </div>
      {change.kind === "changed" ? (
        <p className="max-h-40 overflow-auto rounded-md bg-[var(--background)]/70 p-1.5 text-[0.6875rem] leading-relaxed text-[var(--foreground)]">
          <InlineTextDiff before={change.before} after={change.after} />
        </p>
      ) : change.kind === "added" ? (
        <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-emerald-500/10 p-1.5 text-[0.6875rem] leading-relaxed text-[var(--foreground)]">
          {change.after || <EmptyValue />}
        </p>
      ) : (
        <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--destructive)]/10 p-1.5 text-[0.6875rem] leading-relaxed text-[var(--foreground)] line-through">
          {change.before || <EmptyValue />}
        </p>
      )}
    </div>
  );
}

// ── Lorebook key chips (added green / removed red / unchanged neutral) ───────

function KeyChips({ before, after }: { before: string[]; after: string[] }) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const all = [...new Set([...before, ...after])];
  if (all.length === 0) return <EmptyValue />;
  return (
    <div className="flex flex-wrap gap-1">
      {all.map((key) => {
        const added = afterSet.has(key) && !beforeSet.has(key);
        const removed = beforeSet.has(key) && !afterSet.has(key);
        return (
          <span
            key={key}
            className={cn(
              "rounded-md px-1.5 py-0.5 text-[0.625rem]",
              added && "bg-emerald-500/25 text-[var(--foreground)]",
              removed && "bg-[var(--destructive)]/25 text-[var(--foreground)] line-through",
              !added && !removed && "bg-[var(--secondary)]/60 text-[var(--muted-foreground)]",
            )}
          >
            {key}
          </span>
        );
      })}
    </div>
  );
}

const LOREBOOK_TOGGLES: Array<{ key: string; labelKey: string }> = [
  { key: "enabled", labelKey: "ui.chat.mariediteasyviewer.toggleEnabled" },
  { key: "constant", labelKey: "ui.chat.mariediteasyviewer.toggleConstant" },
  { key: "matchWholeWords", labelKey: "ui.chat.mariediteasyviewer.toggleWholeWords" },
  { key: "caseSensitive", labelKey: "ui.chat.mariediteasyviewer.toggleCaseSensitive" },
  { key: "useRegex", labelKey: "ui.chat.mariediteasyviewer.toggleRegex" },
  { key: "locked", labelKey: "ui.chat.mariediteasyviewer.toggleLocked" },
];

function LorebookEntryDiff({ change }: { change: MariDbRowChange }) {
  const { t: localizeUi } = useUiTranslation();
  const before = change.before ?? null;
  const after = change.after ?? null;
  const source = after ?? before; // for delete, describe the removed row
  const nameBefore = stringField(before, "name");
  const nameAfter = stringField(after, "name");
  const contentBefore = stringField(before, "content");
  const contentAfter = stringField(after, "content");
  const descBefore = stringField(before, "description");
  const descAfter = stringField(after, "description");

  // Only surface toggle CHANGES on a genuine update; on insert/delete the whole entry is added or
  // removed (shown by the name/content), so per-toggle chips would misrepresent it as flips.
  const changedToggles =
    before && after
      ? LOREBOOK_TOGGLES.filter(({ key }) => truthy(before[key]) !== truthy(after[key])).map(({ key, labelKey }) => ({
          label: localizeUi(labelKey),
          on: truthy(after[key]),
        }))
      : [];

  return (
    <div className="mari-editor-panel mari-editor-panel--soft space-y-2 rounded-lg p-2">
      <div className="text-[0.6875rem] font-semibold text-[var(--foreground)]">
        {nameBefore || nameAfter ? (
          <InlineTextDiff before={nameBefore} after={nameAfter} />
        ) : (
          localizeUi("ui.chat.mariediteasyviewer.untitledEntry")
        )}
      </div>

      <div>
        <div className="mb-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
          {localizeUi("ui.chat.mariediteasyviewer.primaryKeys")}
        </div>
        <KeyChips before={csvToList(before?.keys)} after={csvToList(after?.keys)} />
      </div>

      {(csvToList(before?.secondaryKeys).length > 0 || csvToList(after?.secondaryKeys).length > 0) && (
        <div>
          <div className="mb-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
            {localizeUi("ui.chat.mariediteasyviewer.secondaryKeys")}
          </div>
          <KeyChips before={csvToList(before?.secondaryKeys)} after={csvToList(after?.secondaryKeys)} />
        </div>
      )}

      {contentBefore !== contentAfter && (
        <div>
          <div className="mb-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
            {localizeUi("ui.chat.mariediteasyviewer.content")}
          </div>
          <p className="max-h-40 overflow-auto rounded-md bg-[var(--background)]/70 p-1.5 text-[0.6875rem] leading-relaxed text-[var(--foreground)]">
            <InlineTextDiff before={contentBefore} after={contentAfter} />
          </p>
        </div>
      )}

      {descBefore !== descAfter && (
        <div>
          <div className="mb-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
            {localizeUi("ui.chat.mariediteasyviewer.description")}
          </div>
          <p className="max-h-40 overflow-auto rounded-md bg-[var(--background)]/70 p-1.5 text-[0.6875rem] leading-relaxed text-[var(--foreground)]">
            <InlineTextDiff before={descBefore} after={descAfter} />
          </p>
        </div>
      )}

      {changedToggles.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {changedToggles.map((toggle) => (
            <span
              key={toggle.label}
              className={cn(
                "rounded-md px-1.5 py-0.5 text-[0.625rem]",
                toggle.on ? "bg-emerald-500/25 text-[var(--foreground)]" : "bg-[var(--destructive)]/25 text-[var(--foreground)]",
              )}
            >
              {toggle.label}: {toggle.on ? localizeUi("ui.chat.mariediteasyviewer.on") : localizeUi("ui.chat.mariediteasyviewer.off")}
            </span>
          ))}
        </div>
      )}

      {!source && <EmptyValue />}
    </div>
  );
}

function GenericRowDiff({ change }: { change: MariDbRowChange }) {
  const { t: localizeUi } = useUiTranslation();
  const fields = computeFieldChanges(change);
  if (fields.length === 0) {
    return <p className="text-[0.6875rem] italic text-[var(--muted-foreground)]">{localizeUi("ui.chat.mariediteasyviewer.noFieldChanges")}</p>;
  }
  return (
    <div className="space-y-1.5">
      {fields.map((field) => (
        <FieldChangeView key={field.path} change={field} />
      ))}
    </div>
  );
}

// ── Row title + action metadata ─────────────────────────────────────────────

function rowTitle(change: MariDbRowChange, localizeUi: (key: string) => string): string {
  const row = asRecord(change.after) ?? asRecord(change.before);
  if (change.table === "characters") {
    const data = asRecord(row?.data);
    return (data && stringField(data, "name")) || localizeUi("ui.chat.mariediteasyviewer.character");
  }
  if (change.table === "lorebook_entries") return localizeUi("ui.chat.mariediteasyviewer.lorebookEntry");
  const name = row ? stringField(row, "name") : "";
  if (name) return name;
  if (change.table === "mari_instructions") return localizeUi("ui.chat.mariediteasyviewer.memory");
  if (change.table === "prompt_presets") return localizeUi("ui.chat.mariediteasyviewer.preset");
  return localizeUi("ui.chat.mariediteasyviewer.change");
}

function actionMeta(action: MariDbRowChange["action"], localizeUi: (key: string) => string) {
  if (action === "insert") {
    return { label: localizeUi("ui.chat.mariediteasyviewer.actionNew"), icon: Sparkles, tone: "text-[var(--primary)]" };
  }
  if (action === "delete") {
    return { label: localizeUi("ui.chat.mariediteasyviewer.actionRemoved"), icon: Trash2, tone: "text-[var(--destructive)]" };
  }
  return { label: localizeUi("ui.chat.mariediteasyviewer.actionEdited"), icon: Pencil, tone: "text-[var(--muted-foreground)]" };
}

function RowCard({ change, onDismiss }: { change: MariDbRowChange; onDismiss: () => void }) {
  const { t: localizeUi } = useUiTranslation();
  const meta = actionMeta(change.action, localizeUi);
  const MetaIcon = meta.icon;
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--background)]/40 p-2">
      <div className="mb-1.5 flex min-w-0 items-center gap-1.5">
        <MetaIcon size="0.75rem" className={cn("shrink-0", meta.tone)} />
        <span className="truncate text-[0.6875rem] font-semibold text-[var(--foreground)]">
          {rowTitle(change, localizeUi)}
        </span>
        <span className={cn("shrink-0 text-[0.625rem]", meta.tone)}>{meta.label}</span>
        <button
          type="button"
          onClick={onDismiss}
          title={localizeUi("ui.chat.mariediteasyviewer.dismissHint")}
          aria-label={localizeUi("ui.chat.mariediteasyviewer.dismiss")}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.625rem] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
        >
          <Check size="0.7rem" />
          {localizeUi("ui.chat.mariediteasyviewer.dismiss")}
        </button>
      </div>
      {change.table === "lorebook_entries" ? <LorebookEntryDiff change={change} /> : <GenericRowDiff change={change} />}
    </div>
  );
}

export function MariEditEasyViewer({
  approval,
  hidden,
  onDismissRow,
}: {
  approval: MariDbPendingApproval;
  hidden: ReadonlySet<string>;
  onDismissRow: (key: string) => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  const rows = approval.diffPreview.filter((change) => !hidden.has(rowKey(change)));

  if (approval.diffPreview.length === 0) {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[0.6875rem] italic text-[var(--muted-foreground)]">
        <FileText size="0.75rem" />
        {localizeUi("ui.chat.mariediteasyviewer.noPreview")}
      </p>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {rows.length === 0 ? (
        <p className="text-[0.6875rem] italic text-[var(--muted-foreground)]">
          {localizeUi("ui.chat.mariediteasyviewer.allDismissed")}
        </p>
      ) : (
        rows.map((change) => (
          <RowCard key={rowKey(change)} change={change} onDismiss={() => onDismissRow(rowKey(change))} />
        ))
      )}
      {approval.diffTruncated && (
        <p className="text-[0.625rem] text-[var(--muted-foreground)]">
          {localizeUi("ui.chat.databaseworkspaceapprovalcard.thisPreviewMayNotShowEveryAffectedRow")}
        </p>
      )}
    </div>
  );
}
