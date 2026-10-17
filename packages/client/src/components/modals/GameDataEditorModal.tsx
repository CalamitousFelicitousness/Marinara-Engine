// ──────────────────────────────────────────────
// Game Data Editor — the State Editor opened on a Game Mode chat's own data
// (party cards, NPCs, journal, story, maps, …). Read-only for now.
// ──────────────────────────────────────────────
import { useMemo } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation as useUiTranslation } from "react-i18next";
import type { Chat } from "@marinara-engine/shared";
import { Modal } from "../ui/Modal";
import { StateEditor } from "../ui/state-editor/StateEditor";
import { api } from "../../lib/api-client";
import { trackChatMetadataSave } from "../../lib/chat-metadata-save-barrier";
import { buildGameDataEditorSections, readGameMetadata } from "../../lib/state-editor/game-data-editor-source";

interface GameDataEditorModalProps {
  open: boolean;
  onClose: () => void;
  chatId: string;
}

/** Waits for queued metadata writes, so the editor shows what the server will hold. */
async function fetchGameMetadata(chatId: string): Promise<Record<string, unknown>> {
  await trackChatMetadataSave(chatId, async () => undefined);
  const chat = await api.get<Chat>(`/chats/${chatId}`);
  return readGameMetadata(chat.metadata);
}

// Nothing is editable yet, so there is nothing to save.
const saveNothing = async () => undefined;

export function GameDataEditorModal({ open, onClose, chatId }: GameDataEditorModalProps) {
  const { t: localizeUi } = useUiTranslation();
  const metadataQuery = useQuery({
    queryKey: ["state-editor", "game-data", chatId],
    queryFn: () => fetchGameMetadata(chatId),
    enabled: open && !!chatId,
    staleTime: 0,
    gcTime: 0,
  });

  const metadata = metadataQuery.data;
  const sections = useMemo(
    () =>
      metadata
        ? buildGameDataEditorSections(metadata, (sectionId, part) =>
            localizeUi(`ui.stateEditor.gameData.sections.${sectionId}.${part}`),
          )
        : [],
    [localizeUi, metadata],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={localizeUi("ui.stateEditor.gameData.title")}
      width="max-w-4xl"
      mobileFullscreen
      panelClassName="sm:h-[min(85dvh,44rem)]"
      contentClassName="flex flex-col p-0! overflow-hidden!"
    >
      {metadataQuery.isPending ? (
        <div className="flex flex-1 items-center justify-center gap-2 py-16 text-sm text-[var(--muted-foreground)]">
          <Loader2 size="1rem" className="animate-spin" />
          {localizeUi("ui.stateEditor.gameData.loading")}
        </div>
      ) : metadataQuery.isError || !metadata ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center text-sm text-[var(--muted-foreground)]">
          <AlertTriangle size="1.25rem" className="text-[var(--marinara-app-accent-static)]" />
          {localizeUi("ui.stateEditor.gameData.loadFailed")}
          <button
            type="button"
            onClick={() => void metadataQuery.refetch()}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-[var(--secondary)] px-3 text-xs font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] hover:bg-[var(--accent)]"
          >
            <RefreshCw size="0.875rem" />
            {localizeUi("ui.stateEditor.gameData.reload")}
          </button>
        </div>
      ) : sections.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 py-16 text-center text-sm text-[var(--muted-foreground)]">
          {localizeUi("ui.stateEditor.gameData.empty")}
        </div>
      ) : (
        <StateEditor sections={sections} onSave={saveNothing} />
      )}
    </Modal>
  );
}
