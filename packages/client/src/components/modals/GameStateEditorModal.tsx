// ──────────────────────────────────────────────
// Game State Editor — the State Editor opened on a roleplay chat's current
// game state (what the tracker agents read back as <current_game_state>).
// ──────────────────────────────────────────────
import { useCallback, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation as useUiTranslation } from "react-i18next";
import { toast } from "sonner";
import type { GameState } from "@marinara-engine/shared";
import { Modal } from "../ui/Modal";
import { StateEditor } from "../ui/state-editor/StateEditor";
import { api } from "../../lib/api-client";
import { showConfirmDialog } from "../../lib/app-dialogs";
import {
  buildGameStateEditorPatch,
  buildGameStateEditorSections,
} from "../../lib/state-editor/game-state-editor-source";
import type { StateEditorChange } from "../../lib/state-editor/state-editor.types";
import { useChatStore } from "../../stores/chat.store";
import { useGameStateStore } from "../../stores/game-state.store";

interface GameStateEditorModalProps {
  open: boolean;
  onClose: () => void;
  chatId: string;
}

/** Section ids are agent types ("world-state"); localization keys are camelCase. */
const toKeySegment = (id: string) => id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

const sameTurn = (left: GameState, right: GameState) =>
  left.messageId === right.messageId && left.swipeIndex === right.swipeIndex;

/** Lands queued tracker-panel edits first, so the editor never shows (or overwrites) a stale copy. */
async function fetchFreshGameState(chatId: string): Promise<GameState | null> {
  await useGameStateStore.getState().flushPatch?.();
  return api.get<GameState | null>(`/chats/${chatId}/game-state`);
}

export function GameStateEditorModal({ open, onClose, chatId }: GameStateEditorModalProps) {
  const { t: localizeUi } = useUiTranslation();
  const qc = useQueryClient();
  const queryKey = useMemo(() => ["state-editor", "game-state", chatId] as const, [chatId]);
  const gameStateQuery = useQuery({
    queryKey,
    queryFn: () => fetchFreshGameState(chatId),
    enabled: open && !!chatId,
    staleTime: 0,
    gcTime: 0,
  });
  const [turnMovedOn, setTurnMovedOn] = useState(false);
  const [editorKey, setEditorKey] = useState(0);
  const dirtyRef = useRef(false);

  const snapshot = gameStateQuery.data ?? null;
  const sections = useMemo(
    () =>
      snapshot
        ? buildGameStateEditorSections(snapshot, (id, part) =>
            localizeUi(`ui.stateEditor.gameState.sections.${toKeySegment(id)}.${part}`),
          )
        : [],
    [localizeUi, snapshot],
  );

  const handleDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  const requestClose = useCallback(async () => {
    if (dirtyRef.current) {
      const confirmed = await showConfirmDialog({
        title: localizeUi("ui.stateEditor.discard.title"),
        message: localizeUi("ui.stateEditor.discard.closeMessage"),
        confirmLabel: localizeUi("ui.stateEditor.discard.confirm"),
        cancelLabel: localizeUi("ui.stateEditor.discard.cancel"),
        tone: "destructive",
      });
      if (!confirmed) return;
    }
    onClose();
  }, [localizeUi, onClose]);

  const reload = useCallback(async () => {
    setTurnMovedOn(false);
    dirtyRef.current = false;
    setEditorKey((key) => key + 1);
    await gameStateQuery.refetch();
  }, [gameStateQuery]);

  const save = useCallback(
    async (changes: StateEditorChange[]) => {
      if (!snapshot) throw new Error(localizeUi("ui.stateEditor.gameState.noState"));
      // Build the patch from a fresh copy so concurrent tracker or agent updates to other fields survive.
      const fresh = await fetchFreshGameState(chatId);
      if (!fresh || !sameTurn(fresh, snapshot)) {
        setTurnMovedOn(true);
        throw new Error(localizeUi("ui.stateEditor.gameState.turnMovedOn"));
      }
      const result = buildGameStateEditorPatch(fresh, changes);
      if ("error" in result) {
        const section = sections.find((item) => item.id === result.sectionId);
        throw new Error(section ? `${section.label}: ${result.error}` : result.error);
      }
      // Aim at the exact snapshot row, like the tracker panel's own patcher.
      await api.patch(`/chats/${chatId}/game-state`, {
        ...result.patch,
        manual: true,
        ...(fresh.messageId ? { messageId: fresh.messageId } : {}),
        ...(fresh.messageId && Number.isInteger(fresh.swipeIndex) && fresh.swipeIndex >= 0
          ? { swipeIndex: fresh.swipeIndex }
          : {}),
      });
      const saved = await api.get<GameState | null>(`/chats/${chatId}/game-state`);
      qc.setQueryData(queryKey, saved);
      void qc.invalidateQueries({ queryKey: ["agent-suite", "game-state", chatId] });
      if (useChatStore.getState().activeChatId === chatId) useGameStateStore.getState().setGameState(saved);
      toast.success(localizeUi("ui.stateEditor.gameState.saved"));
    },
    [chatId, localizeUi, qc, queryKey, sections, snapshot],
  );

  return (
    <Modal
      open={open}
      onClose={() => void requestClose()}
      title={localizeUi("ui.stateEditor.gameState.title")}
      width="max-w-5xl"
      mobileFullscreen
      panelClassName="sm:h-[min(90dvh,52rem)]"
      contentClassName="flex flex-col p-0! overflow-hidden!"
    >
      {gameStateQuery.isPending ? (
        <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-[var(--muted-foreground)]">
          <Loader2 size="1rem" className="animate-spin" />
          {localizeUi("ui.stateEditor.gameState.loading")}
        </div>
      ) : gameStateQuery.isError ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center text-sm text-[var(--muted-foreground)]">
          <AlertTriangle size="1.25rem" className="text-[var(--destructive)]" />
          {localizeUi("ui.stateEditor.gameState.loadFailed")}
          <button
            type="button"
            onClick={() => void reload()}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[var(--secondary)] px-3 text-xs font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] hover:bg-[var(--accent)]"
          >
            <RefreshCw size="0.875rem" />
            {localizeUi("ui.stateEditor.gameState.reload")}
          </button>
        </div>
      ) : !snapshot ? (
        <p className="flex flex-1 items-center justify-center px-6 py-16 text-center text-sm text-[var(--muted-foreground)]">
          {localizeUi("ui.stateEditor.gameState.noState")}
        </p>
      ) : (
        <StateEditor
          key={editorKey}
          sections={sections}
          onSave={save}
          onDirtyChange={handleDirtyChange}
          notice={
            turnMovedOn ? (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-[var(--destructive)]/10 px-3 py-2 text-xs text-[var(--destructive)] ring-1 ring-[var(--destructive)]/30"
              >
                <AlertTriangle size="0.875rem" className="shrink-0" />
                <span className="min-w-0 flex-1">{localizeUi("ui.stateEditor.gameState.turnMovedOnNotice")}</span>
                <button
                  type="button"
                  onClick={() => void reload()}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md bg-[var(--secondary)] px-2.5 font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] hover:bg-[var(--accent)]"
                >
                  <RefreshCw size="0.75rem" />
                  {localizeUi("ui.stateEditor.gameState.reload")}
                </button>
              </div>
            ) : null
          }
        />
      )}
    </Modal>
  );
}
