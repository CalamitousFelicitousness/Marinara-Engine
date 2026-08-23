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
//
// Layout follows the card's own custom-field rows: font size comes from the
// list wrapper (never per-row, or the rows render smaller than their siblings),
// and the label/value split only appears once the card is wide enough for it.
import { useState } from "react";
import { ChevronRight, Plus, X } from "lucide-react";
import {
  blankTrackerExtraTemplate,
  countTrackerExtraLeaves,
  isEmptyTrackerExtraContainer,
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
import { TRACKER_ROW_CLASS, TRACKER_ROW_WITH_ACTION_CLASS } from "../../lib/tracker-row-layout";
import { trackerEditableText } from "../../lib/tracker-display";
import { InlineEdit } from "../controls/InlineControls";
import { useTrackerLockContext } from "../TrackerLockContext";

// Matches CHARACTER_CUSTOM_FIELD_LIST_CLASS so extras read at the same size as
// the custom-field rows above them. `rem` resolves against the app's root size,
// which the panel scales down, so a per-row override lands near 6px.
const EXTRAS_LIST_CLASS =
  "relative z-[1] mt-1 grid gap-px border-t border-[color-mix(in_srgb,var(--tracker-profile-rule)_34%,transparent)] pt-1 text-[length:var(--tracker-fs-0-5625)] @min-[176px]:text-[length:var(--tracker-fs-0-625)]";

/** Subtrees at or below these sizes unfold on first render. */
const OPEN_BY_DEFAULT_TOP_LEVEL = 24;
const OPEN_BY_DEFAULT_NESTED = 8;

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

/** Path segments as a readable label: `heel_height_cm` renders as "heel height cm". */
function segmentLabel(segment: string | number): string {
  return typeof segment === "number" ? `${segment + 1}` : segment.replace(/_/gu, " ");
}

/**
 * Array rows are numbered, which says nothing. Borrow the row's own descriptive
 * field when it has one, so `clothing.outerwear.0` reads as "red cape".
 */
function arrayItemLabel(node: unknown, index: number): string {
  if (isRecord(node)) {
    for (const key of ["item", "name", "title", "label", "type"]) {
      const value = node[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return `${index + 1}`;
}

function openByDefault(node: unknown, depth: number): boolean {
  const limit = depth === 0 ? OPEN_BY_DEFAULT_TOP_LEVEL : OPEN_BY_DEFAULT_NESTED;
  return countTrackerExtraLeaves(node, limit + 1) <= limit;
}

interface ExtrasNodeProps {
  node: unknown;
  path: TrackerExtraPath;
  prefix: string;
  fieldLocks: TrackerFieldLocks | null | undefined;
  depth: number;
  addMode: boolean;
  deleteMode: boolean;
  readable: boolean;
  label: string;
  onEdit: (path: TrackerExtraPath, value: unknown) => void;
  onRemove: (path: TrackerExtraPath) => void;
  onAdd: (path: TrackerExtraPath) => void;
}

function ExtrasNode({
  node,
  path,
  prefix,
  fieldLocks,
  depth,
  addMode,
  deleteMode,
  readable,
  label,
  onEdit,
  onRemove,
  onAdd,
}: ExtrasNodeProps) {
  const { t: localizeUi } = useUiTranslation();
  const { lockMode, onToggleFieldLock } = useTrackerLockContext();
  const [open, setOpen] = useState(() => openByDefault(node, depth));
  const lockKey = trackerExtraLockKey(prefix, path);

  if (isTrackerExtraLeaf(node)) {
    return (
      <div className={cn(TRACKER_ROW_CLASS, deleteMode && TRACKER_ROW_WITH_ACTION_CLASS)}>
        <span
          className="truncate px-0.5 font-medium text-[color:var(--tracker-inline-muted,var(--muted-foreground))]"
          title={String(path[path.length - 1] ?? "")}
        >
          {label}
        </span>
        <InlineEdit
          value={trackerEditableText(node)}
          onSave={(next) => onEdit(path, coerceLeaf(node, next))}
          placeholder={localizeUi("ui.trackerPanel.charactertrackercard.value")}
          ariaLabel={`${path.join(" ")} value`}
          className="min-w-0 px-0.5 py-0"
          scrollOnHover={!readable}
          twoLinePreview={readable}
          locked={isTrackerFieldLocked(fieldLocks, lockKey)}
          lockMode={lockMode}
          onToggleLock={onToggleFieldLock ? () => onToggleFieldLock(lockKey) : undefined}
        />
        {deleteMode && typeof path[path.length - 1] === "string" && (
          <button
            type="button"
            onClick={() => onRemove(path)}
            aria-label={localizeUi("ui.trackerPanel.charactertrackerextras.removeValue1", { value1: label })}
            className="flex h-5 w-5 items-center justify-center justify-self-end rounded text-[var(--destructive)] transition-all hover:bg-[var(--destructive)]/10 active:scale-90 [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6"
          >
            <X size="0.625rem" />
          </button>
        )}
      </div>
    );
  }

  const entries: Array<[string | number, unknown]> = Array.isArray(node)
    ? node.map((value, index) => [index, value])
    : isRecord(node)
      ? Object.entries(node)
      : [];
  // An empty container is noise: a chevron over nothing. The agent re-emits the
  // key every turn, so hiding it loses no data and costs no round trip.
  const visible = entries.filter(([, value]) => !isEmptyTrackerExtraContainer(value));
  if (visible.length === 0) return null;

  return (
    <div className={cn("min-w-0", depth > 0 && "border-l border-[var(--tracker-profile-rule)]/40 pl-1")}>
      <div className="flex min-w-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-0.5 rounded-sm px-0.5 py-0.5 text-left font-semibold text-[color:var(--tracker-inline-foreground,var(--foreground))] transition-colors hover:bg-[var(--tracker-profile-accent-solid)]/10"
        >
          <ChevronRight
            size="0.6875rem"
            className={cn("shrink-0 opacity-70 transition-transform", open && "rotate-90")}
          />
          <span className="truncate">{label}</span>
          <span className="shrink-0 tabular-nums opacity-55">{visible.length}</span>
        </button>
        {onToggleFieldLock && lockMode && (
          <button
            type="button"
            onClick={() => onToggleFieldLock(lockKey)}
            aria-label={localizeUi("ui.trackerPanel.charactertrackerextras.lockValue1", { value1: label })}
            className={cn(
              "shrink-0 rounded-sm px-1 transition-colors",
              isTrackerFieldLocked(fieldLocks, lockKey) ? "text-[var(--primary)]" : "opacity-55 hover:opacity-100",
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
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--destructive)] transition-all hover:bg-[var(--destructive)]/10 active:scale-90 [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6"
          >
            <X size="0.625rem" />
          </button>
        )}
      </div>

      {open && (
        <div className="grid min-w-0 gap-px pl-1">
          {visible.map(([segment, value]) => (
            <ExtrasNode
              key={String(segment)}
              node={value}
              path={[...path, segment]}
              prefix={prefix}
              fieldLocks={fieldLocks}
              depth={depth + 1}
              addMode={addMode}
              deleteMode={deleteMode}
              readable={readable}
              label={typeof segment === "number" ? arrayItemLabel(value, segment) : segmentLabel(segment)}
              onEdit={onEdit}
              onRemove={onRemove}
              onAdd={onAdd}
            />
          ))}
          {addMode && Array.isArray(node) && (
            <button
              type="button"
              onClick={() => onAdd(path)}
              className="inline-flex w-fit items-center gap-0.5 rounded-sm px-1 py-0.5 opacity-60 transition-opacity hover:opacity-100 active:scale-95"
            >
              <Plus size="0.5625rem" />
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
  addMode,
  deleteMode,
  readable = false,
  onChange,
}: {
  extras: Record<string, unknown>;
  lockPrefix: string;
  addMode: boolean;
  deleteMode: boolean;
  readable?: boolean;
  onChange: (nextExtras: Record<string, unknown>) => void;
}) {
  const { fieldLocks, onUpdateFieldLocks } = useTrackerLockContext();
  const sections = Object.entries(extras).filter(([, value]) => !isEmptyTrackerExtraContainer(value));
  if (sections.length === 0) return null;

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
    <div className={EXTRAS_LIST_CLASS}>
      {sections.map(([key, value]) => (
        <ExtrasNode
          key={key}
          node={value}
          path={[key]}
          prefix={lockPrefix}
          fieldLocks={fieldLocks}
          depth={0}
          addMode={addMode}
          deleteMode={deleteMode}
          readable={readable}
          label={segmentLabel(key)}
          onEdit={edit}
          onRemove={remove}
          onAdd={add}
        />
      ))}
    </div>
  );
}
