// ──────────────────────────────────────────────
// Nested per-character tracker data
// ──────────────────────────────────────────────
// A custom Character Tracker prompt can emit a schema richer than
// `PresentCharacter` defines, such as clothing layers with heel heights. That
// output was already persisted; this renders it, and makes it editable and
// lockable on the same dotted-path lock keys the flat fields use.
//
// Generic by necessity: the shape belongs to the user's prompt, so the tree is
// driven by the data rather than by any schema this component knows.
import { useState } from "react";
import { ChevronRight, Plus, X } from "lucide-react";
import {
  blankTrackerExtraTemplate,
  isTrackerExtraLeaf,
  isTrackerFieldLocked,
  readTrackerExtraAt,
  removeTrackerExtraAt,
  removeTrackerFieldLockPrefix,
  trackerExtraLockKey,
  writeTrackerExtraAt,
  type TrackerExtraPath,
  type TrackerFieldLocks,
} from "@marinara-engine/shared";
import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../../../lib/utils";
import { trackerEditableText } from "../../lib/tracker-display";
import { InlineEdit } from "../controls/InlineControls";
import { useTrackerLockContext } from "../TrackerLockContext";

/** Numbers stay numbers so a heel height does not silently become a string. */
function coerceLeaf(previous: unknown, next: string): unknown {
  if (typeof previous === "number") {
    const parsed = Number(next);
    return Number.isFinite(parsed) ? parsed : previous;
  }
  if (typeof previous === "boolean") return next.trim().toLowerCase() === "true";
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Path segments as a readable label: `footwear.0` renders as "footwear 1". */
function segmentLabel(segment: string | number): string {
  return typeof segment === "number" ? `${segment + 1}` : segment;
}

interface ExtrasNodeProps {
  node: unknown;
  path: TrackerExtraPath;
  prefix: string;
  fieldLocks: TrackerFieldLocks | null | undefined;
  depth: number;
  deleteMode: boolean;
  onEdit: (path: TrackerExtraPath, value: unknown) => void;
  onRemove: (path: TrackerExtraPath) => void;
  onAdd: (path: TrackerExtraPath) => void;
}

function ExtrasNode({ node, path, prefix, fieldLocks, depth, deleteMode, onEdit, onRemove, onAdd }: ExtrasNodeProps) {
  const { t: localizeUi } = useUiTranslation();
  const { lockMode, onToggleFieldLock } = useTrackerLockContext();
  // Top level opens by default; deeper nesting stays folded so a large tree does
  // not bury the stats above it.
  const [open, setOpen] = useState(depth < 1);
  const lockKey = trackerExtraLockKey(prefix, path);
  const label = path.length > 0 ? segmentLabel(path[path.length - 1]!) : "";

  if (isTrackerExtraLeaf(node)) {
    return (
      <div className="grid grid-cols-[minmax(3.5rem,0.4fr)_minmax(0,1fr)_auto] items-center gap-1">
        <span className="truncate px-0.5 text-[0.5625rem] text-[var(--muted-foreground)]" title={label}>
          {label}
        </span>
        <InlineEdit
          value={trackerEditableText(node)}
          onSave={(next) => onEdit(path, coerceLeaf(node, next))}
          placeholder={localizeUi("ui.trackerPanel.charactertrackercard.value")}
          ariaLabel={`${path.join(" ")} value`}
          className="min-w-0 px-0.5 py-0 text-[0.5625rem]"
          scrollOnHover
          locked={isTrackerFieldLocked(fieldLocks, lockKey)}
          lockMode={lockMode}
          onToggleLock={onToggleFieldLock ? () => onToggleFieldLock(lockKey) : undefined}
        />
        {deleteMode && typeof path[path.length - 1] === "string" ? (
          <button
            type="button"
            onClick={() => onRemove(path)}
            aria-label={localizeUi("ui.trackerPanel.charactertrackerextras.removeValue1", { value1: label })}
            className="rounded-sm p-0.5 text-[var(--destructive)] transition-colors hover:bg-[var(--foreground)]/8 active:scale-90"
          >
            <X size="0.625rem" />
          </button>
        ) : (
          <span />
        )}
      </div>
    );
  }

  const entries: Array<[string | number, unknown]> = Array.isArray(node)
    ? node.map((value, index) => [index, value])
    : isRecord(node)
      ? Object.entries(node)
      : [];

  return (
    <div className={cn(depth > 0 && "border-l border-[var(--border)]/40 pl-1.5")}>
      {path.length > 0 && (
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 items-center gap-0.5 rounded-sm px-0.5 py-0.5 text-left text-[0.5625rem] font-medium text-[var(--foreground)]/85 transition-colors hover:bg-[var(--foreground)]/6"
          >
            <ChevronRight size="0.5625rem" className={cn("shrink-0 transition-transform", open && "rotate-90")} />
            <span className="truncate">{label}</span>
            <span className="shrink-0 text-[var(--muted-foreground)]">{entries.length}</span>
          </button>
          {onToggleFieldLock && lockMode && (
            <button
              type="button"
              onClick={() => onToggleFieldLock(lockKey)}
              aria-label={localizeUi("ui.trackerPanel.charactertrackerextras.lockValue1", { value1: label })}
              className={cn(
                "rounded-sm px-1 text-[0.5rem] transition-colors",
                isTrackerFieldLocked(fieldLocks, lockKey)
                  ? "text-[var(--primary)]"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
              )}
            >
              {isTrackerFieldLocked(fieldLocks, lockKey) ? "🔒" : "🔓"}
            </button>
          )}
          {deleteMode && (
            <button
              type="button"
              onClick={() => onRemove(path)}
              aria-label={localizeUi("ui.trackerPanel.charactertrackerextras.removeValue1", { value1: label })}
              className="rounded-sm p-0.5 text-[var(--destructive)] transition-colors hover:bg-[var(--foreground)]/8 active:scale-90"
            >
              <X size="0.625rem" />
            </button>
          )}
        </div>
      )}

      {open && (
        <div className="flex flex-col gap-0.5 pl-1">
          {entries.map(([segment, value]) => (
            <ExtrasNode
              key={String(segment)}
              node={value}
              path={[...path, segment]}
              prefix={prefix}
              fieldLocks={fieldLocks}
              depth={depth + 1}
              deleteMode={deleteMode}
              onEdit={onEdit}
              onRemove={onRemove}
              onAdd={onAdd}
            />
          ))}
          {Array.isArray(node) && (
            <button
              type="button"
              onClick={() => onAdd(path)}
              className="inline-flex w-fit items-center gap-0.5 rounded-sm px-1 py-0.5 text-[0.5rem] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--foreground)]/8 hover:text-[var(--foreground)] active:scale-95"
            >
              <Plus size="0.5rem" />
              {localizeUi("ui.trackerPanel.charactertrackerextras.addRow")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function CharacterTrackerExtras({
  extras,
  lockPrefix,
  deleteMode,
  onChange,
}: {
  extras: Record<string, unknown>;
  lockPrefix: string;
  deleteMode: boolean;
  onChange: (nextExtras: Record<string, unknown>) => void;
}) {
  const { fieldLocks, onUpdateFieldLocks } = useTrackerLockContext();
  if (Object.keys(extras).length === 0) return null;

  const edit = (path: TrackerExtraPath, value: unknown) => {
    onChange(writeTrackerExtraAt(extras, path, value) as Record<string, unknown>);
  };

  const remove = (path: TrackerExtraPath) => {
    onChange(removeTrackerExtraAt(extras, path) as Record<string, unknown>);
    // Drop the removed node's locks with it, otherwise a later row sliding into
    // that path would inherit a lock nobody set on it.
    onUpdateFieldLocks?.((locks) => removeTrackerFieldLockPrefix(locks, trackerExtraLockKey(lockPrefix, path)));
  };

  const add = (path: TrackerExtraPath) => {
    const list = readTrackerExtraAt(extras, path);
    if (!Array.isArray(list)) return;
    // Copy the first row's shape so a new entry has the keys the prompt expects
    // rather than an empty object the agent has to infer.
    const template = list.length > 0 ? blankTrackerExtraTemplate(list[0]) : "";
    onChange(writeTrackerExtraAt(extras, path, [...list, template]) as Record<string, unknown>);
  };

  return (
    <div className="mt-0.5 flex flex-col gap-0.5 rounded-sm bg-[var(--foreground)]/4 p-0.5">
      {Object.entries(extras).map(([key, value]) => (
        <ExtrasNode
          key={key}
          node={value}
          path={[key]}
          prefix={lockPrefix}
          fieldLocks={fieldLocks}
          depth={0}
          deleteMode={deleteMode}
          onEdit={edit}
          onRemove={remove}
          onAdd={add}
        />
      ))}
    </div>
  );
}
