// ──────────────────────────────────────────────
// Multiswipe: candidate-count gesture menus and status badges
// ──────────────────────────────────────────────
// A plain click on the send button, the regenerate button, or the next-swipe
// chevron keeps stock single-candidate behavior. Right-click (desktop) or
// long-press (touch) opens the count menu, so asking for several candidates is
// always a deliberate act.
//
// useMultiSwipeCountMenu owns the gesture and knows nothing about what a count
// is used for. The adapters below bind it to a surface, which is what let the
// send button reuse the gesture without touching the regenerate path.
import { Bot } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { multiSwipeCountOptions } from "../../lib/multi-swipe-policy";
import { useMultiSwipeStore } from "../../stores/multi-swipe.store";
import { useUIStore } from "../../stores/ui.store";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";

const LONG_PRESS_MS = 500;

interface MultiSwipeCountMenuOptions {
  /** Runs with the chosen candidate count (always >= 2). Absent hides the counts. */
  onSelectCount?: (count: number) => void;
  /** Localization key for one count entry, resolved with `{ value1: count }`. */
  countLabelKey: string;
  /** Entries rendered above the counts. Memoize at the call site. */
  leadingItems?: ContextMenuItem[];
  /** Plain click, when no long-press just opened the menu. */
  onPlainClick?: () => void;
  /** Chat mode, so a surface that cannot fan out offers no counts. */
  chatMode?: string | null;
  disabled?: boolean;
}

/**
 * Trigger props for the element that should open the menu, plus the menu node.
 * Spread the props onto a button; render the node next to it.
 */
export function useMultiSwipeCountMenu({
  onSelectCount,
  countLabelKey,
  leadingItems,
  onPlainClick,
  chatMode,
  disabled,
}: MultiSwipeCountMenuOptions) {
  const { t: localizeUi } = useTranslation();
  const multiSwipeMax = useUIStore((state) => state.multiSwipeMax);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearLongPress, [clearLongPress]);

  const counts = useMemo(
    () => (onSelectCount ? multiSwipeCountOptions({ multiSwipeMax, chatMode }) : []),
    [chatMode, multiSwipeMax, onSelectCount],
  );

  const hasMenu = counts.length > 0 || (leadingItems?.length ?? 0) > 0;

  const openMenu = useCallback(
    (x: number, y: number) => {
      if (!hasMenu || disabled) return;
      setMenuPosition({ x, y });
    },
    [disabled, hasMenu],
  );

  const items: ContextMenuItem[] = useMemo(() => {
    const entries: ContextMenuItem[] = [...(leadingItems ?? [])];
    if (onSelectCount) {
      for (const count of counts) {
        entries.push({
          label: localizeUi(countLabelKey, { value1: count }),
          onSelect: () => onSelectCount(count),
        });
      }
    }
    return entries;
  }, [countLabelKey, counts, leadingItems, localizeUi, onSelectCount]);

  // Memoized so the memo() on the surfaces that spread these still holds.
  const triggerProps = useMemo(
    () => ({
      onContextMenu: (event: React.MouseEvent) => {
        if (!hasMenu || disabled) return;
        event.preventDefault();
        event.stopPropagation();
        openMenu(event.clientX, event.clientY);
      },
      onPointerDown: (event: ReactPointerEvent) => {
        suppressClickRef.current = false;
        if (event.pointerType !== "touch" || !hasMenu || disabled) return;
        const { clientX, clientY } = event;
        clearLongPress();
        longPressTimerRef.current = window.setTimeout(() => {
          suppressClickRef.current = true;
          openMenu(clientX, clientY);
        }, LONG_PRESS_MS);
      },
      onPointerUp: clearLongPress,
      onPointerCancel: clearLongPress,
      onPointerLeave: clearLongPress,
    }),
    [clearLongPress, disabled, hasMenu, openMenu],
  );

  /** Plain click: stock behavior, unless a long-press just opened the menu. */
  const handlePlainClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onPlainClick?.();
  }, [onPlainClick]);

  const menu = menuPosition ? (
    <ContextMenu x={menuPosition.x} y={menuPosition.y} items={items} onClose={() => setMenuPosition(null)} />
  ) : null;

  return { triggerProps, menu, handlePlainClick, hasMenu };
}

interface MultiSwipeRegenerateMenuOptions {
  messageId: string;
  onRegenerate?: (messageId: string, options?: { skipTouchConfirm?: boolean; candidateCount?: number }) => void;
  /** Present when this message still has deferred agents waiting on a choice. */
  onFinalize?: (messageId: string) => void;
  chatMode?: string | null;
  disabled?: boolean;
}

/** Count menu for a message's regenerate button and create-next-swipe chevron. */
export function useMultiSwipeRegenerateMenu({
  messageId,
  onRegenerate,
  onFinalize,
  chatMode,
  disabled,
}: MultiSwipeRegenerateMenuOptions) {
  const { t: localizeUi } = useTranslation();

  const leadingItems = useMemo(
    () =>
      onFinalize
        ? [{ label: localizeUi("ui.chat.multiswipe.finalizeNow"), onSelect: () => onFinalize(messageId) }]
        : undefined,
    [localizeUi, messageId, onFinalize],
  );

  const onSelectCount = useMemo(
    () =>
      onRegenerate
        ? (count: number) => onRegenerate(messageId, { skipTouchConfirm: true, candidateCount: count })
        : undefined,
    [messageId, onRegenerate],
  );

  const onPlainClick = useCallback(() => onRegenerate?.(messageId), [messageId, onRegenerate]);

  return useMultiSwipeCountMenu({
    onSelectCount,
    countLabelKey: "ui.chat.multiswipe.generateCandidatesValue1",
    leadingItems,
    onPlainClick,
    chatMode,
    disabled,
  });
}

interface MultiSwipeSendMenuOptions {
  /** The surface's own send. `candidateCount` is absent for a plain click. */
  onSend: (options?: { candidateCount?: number }) => void;
  chatMode?: string | null;
  disabled?: boolean;
}

/**
 * Count menu for the composer's send button, so a fan-out no longer needs an
 * assistant message to reroll first. The chosen count rides the same request
 * field the regenerate menu uses; the server decides whether the turn may fan
 * out at all and clamps the ones that may not.
 */
export function useMultiSwipeSendMenu({ onSend, chatMode, disabled }: MultiSwipeSendMenuOptions) {
  const onSelectCount = useCallback((count: number) => onSend({ candidateCount: count }), [onSend]);
  const onPlainClick = useCallback(() => onSend(), [onSend]);

  return useMultiSwipeCountMenu({
    onSelectCount,
    countLabelKey: "ui.chat.multiswipe.sendCandidatesValue1",
    onPlainClick,
    chatMode,
    disabled,
  });
}

/**
 * "Agents pending" pill for a swipe whose deferred agents never ran. Clicking it
 * runs them now; they also run on their own when the chat continues from here.
 * The primary affordance for the state, with the gesture menu as the secondary.
 */
export function MultiSwipePendingBadge({
  chatId,
  messageId,
  onFinalize,
}: {
  chatId: string;
  messageId: string;
  onFinalize: (messageId: string) => void;
}) {
  const { t: localizeUi } = useTranslation();
  const progress = useMultiSwipeStore((state) => state.progressByChatId[chatId]);
  // The marker is written before the candidate tail starts, so while this
  // message is still generating its spread the progress pill speaks for it.
  if (progress?.messageId === messageId) return null;
  return (
    <button
      type="button"
      onClick={() => onFinalize(messageId)}
      title={localizeUi("ui.chat.multiswipe.pendingBadgeHint")}
      className="inline-flex items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-amber-200 transition-colors hover:bg-amber-500/20"
    >
      <Bot size="0.6875rem" className="shrink-0" />
      {localizeUi("ui.chat.multiswipe.pendingBadge")}
    </button>
  );
}

/** "Generating swipe 2 of 4" pill shown while the candidate tail runs. */
export function MultiSwipeProgressBadge({ chatId, messageId }: { chatId: string; messageId: string }) {
  const { t: localizeUi } = useTranslation();
  const progress = useMultiSwipeStore((state) => state.progressByChatId[chatId]);
  if (!progress || progress.messageId !== messageId) return null;
  return (
    <span className="tabular-nums text-[0.625rem] font-medium opacity-80">
      {localizeUi("ui.chat.multiswipe.progressValue1OfValue2", {
        value1: progress.current,
        value2: progress.total,
      })}
    </span>
  );
}
