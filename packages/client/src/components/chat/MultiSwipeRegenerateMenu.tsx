// ──────────────────────────────────────────────
// Multiswipe: "regenerate x N" gesture menu and progress badge
// ──────────────────────────────────────────────
// A plain click on the regenerate button or the next-swipe chevron keeps stock
// single-swipe behavior. Right-click (desktop) or long-press (touch) opens the
// count menu, so asking for several candidates is always a deliberate act.
import { MAX_MULTI_SWIPE_CANDIDATES } from "@marinara-engine/shared";
import { Bot } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { useMultiSwipeStore } from "../../stores/multi-swipe.store";
import { useUIStore } from "../../stores/ui.store";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";

const LONG_PRESS_MS = 500;

interface MultiSwipeMenuOptions {
  messageId: string;
  onRegenerate?: (messageId: string, options?: { skipTouchConfirm?: boolean; candidateCount?: number }) => void;
  /** Present when this message still has deferred agents waiting on a choice. */
  onFinalize?: (messageId: string) => void;
  disabled?: boolean;
}

/**
 * Trigger props for the element that should open the menu, plus the menu node.
 * Spread the props onto a button; render the node next to it.
 */
export function useMultiSwipeRegenerateMenu({ messageId, onRegenerate, onFinalize, disabled }: MultiSwipeMenuOptions) {
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

  const counts = useMemo(() => {
    const max = Math.min(Math.max(multiSwipeMax, 1), MAX_MULTI_SWIPE_CANDIDATES);
    const values: number[] = [];
    for (let count = 2; count <= max; count++) values.push(count);
    return values;
  }, [multiSwipeMax]);

  const hasMenu = (counts.length > 0 && Boolean(onRegenerate)) || Boolean(onFinalize);

  const openMenu = useCallback(
    (x: number, y: number) => {
      if (!hasMenu || disabled) return;
      setMenuPosition({ x, y });
    },
    [disabled, hasMenu],
  );

  const items: ContextMenuItem[] = useMemo(() => {
    const entries: ContextMenuItem[] = [];
    if (onFinalize) {
      entries.push({
        label: localizeUi("ui.chat.multiswipe.finalizeNow"),
        onSelect: () => onFinalize(messageId),
      });
    }
    if (onRegenerate) {
      for (const count of counts) {
        entries.push({
          label: localizeUi("ui.chat.multiswipe.generateCandidatesValue1", { value1: count }),
          onSelect: () => onRegenerate(messageId, { skipTouchConfirm: true, candidateCount: count }),
        });
      }
    }
    return entries;
  }, [counts, localizeUi, messageId, onFinalize, onRegenerate]);

  // Memoized so the memo() on the regenerate button still holds.
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

  /** Plain click: a single swipe, unless a long-press just opened the menu. */
  const handlePlainClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onRegenerate?.(messageId);
  }, [messageId, onRegenerate]);

  const menu = menuPosition ? (
    <ContextMenu x={menuPosition.x} y={menuPosition.y} items={items} onClose={() => setMenuPosition(null)} />
  ) : null;

  return { triggerProps, menu, handlePlainClick, hasMenu };
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
