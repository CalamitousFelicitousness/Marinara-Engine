import { useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  BookOpen,
  ChartColumn,
  Check,
  Download,
  Eye,
  FileText,
  Hash,
  Maximize2,
  MessageSquare,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  chatKeys,
  useChatGroup,
  useDeleteChat,
  useDeleteChatGroup,
  useExportChat,
  useUpdateChatMetadata,
} from "../../hooks/use-chats";
import { showConfirmDialog, showPromptDialog } from "../../lib/app-dialogs";
import { getChatDisplayName } from "../../lib/chat-display";
import { openChatStats } from "../../lib/chat-insights";
import { orderBranches } from "../../lib/chat-branch-preview";
import { api } from "../../lib/api-client";
import { useChatStore } from "../../stores/chat.store";
import { useUIStore } from "../../stores/ui.store";
import { cn } from "../../lib/utils";
import { ChatBranchTail } from "./ChatBranchTail";
import { useTranslation as useUiTranslation } from "react-i18next";

type BranchRow = {
  id: string;
  name: string;
  createdAt?: string | null;
  updatedAt: string;
  lastMessageAt?: string | null;
};

interface ChatBranchesPanelProps {
  activeChatId: string;
  activeChatName?: string | null;
  groupId?: string | null;
}

/** Switch, rename, export, import and delete a chat's branches (the Chat Branches drawer). */
export function ChatBranchesPanel({ activeChatId, activeChatName, groupId }: ChatBranchesPanelProps) {
  const { t: localizeUi } = useUiTranslation();
  const { data: groupChats } = useChatGroup(groupId ?? null);
  const setActiveChatId = useChatStore((s) => s.setActiveChatId);
  const openModal = useUIStore((s) => s.openModal);
  const exportChat = useExportChat();
  const deleteChat = useDeleteChat();
  const deleteChatGroup = useDeleteChatGroup();
  const updateMetadata = useUpdateChatMetadata();
  const qc = useQueryClient();
  const [isImporting, setIsImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  const branches = useMemo(() => orderBranches(groupChats ?? [], activeChatId), [activeChatId, groupChats]);

  const displayBranches = useMemo<BranchRow[]>(() => {
    if (branches.length > 0) return branches;
    if (!activeChatId) return [];
    return [
      {
        id: activeChatId,
        name: activeChatName || localizeUi("chat.branches.current"),
        updatedAt: new Date().toISOString(),
      },
    ];
  }, [activeChatId, activeChatName, branches, localizeUi]);

  const handleImportChat = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    event.target.value = "";

    setIsImporting(true);
    try {
      const formData = new FormData();
      formData.append("chatId", activeChatId);
      formData.append("file", file);
      const data = await api.upload<{
        success?: boolean;
        error?: string;
        messagesImported?: number;
        groupId?: string;
        chatId?: string;
      }>("/import/st-chat-into-group", formData);
      if (data.success === false || data.error) {
        toast.error(
          data.error
            ? localizeUi("chat.branches.importFailedWithReason", { reason: data.error })
            : localizeUi("chat.branches.importFailed"),
        );
        return;
      }
      toast.success(
        localizeUi("chat.branches.importedMessages", {
          count: data.messagesImported ?? 0,
        }),
      );
      qc.invalidateQueries({ queryKey: chatKeys.list() });
      await qc.invalidateQueries({ queryKey: chatKeys.detail(activeChatId) });
      const newGroupId = data.groupId ?? groupId;
      if (newGroupId) {
        await qc.invalidateQueries({ queryKey: chatKeys.group(newGroupId) });
      }
      if (data.chatId) setActiveChatId(data.chatId);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? localizeUi("chat.branches.importFailedWithReason", { reason: err.message })
          : localizeUi("chat.branches.importFailed"),
      );
    } finally {
      setIsImporting(false);
    }
  };

  const openBranchBrowser = (branchId: string, startInPreview: boolean) => {
    openModal("chat-branch-browser", { groupId: groupId ?? null, initialBranchId: branchId, startInPreview });
  };

  const handleRenameBranch = async (branch: BranchRow) => {
    const nextName = await showPromptDialog({
      title: localizeUi("ui.chat.chatbranchselector.renameBranch"),
      message: localizeUi("ui.chat.chatbranchselector.setADisplayNameForThisChatBranch"),
      defaultValue: getChatDisplayName(branch),
      placeholder: localizeUi("chat.branches.namePlaceholder"),
      confirmLabel: localizeUi("ui.chat.chatbranchselector.rename"),
    });
    if (nextName === null) return;
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === getChatDisplayName(branch)) return;
    await updateMetadata.mutateAsync({ id: branch.id, branchName: trimmed });
  };

  const handleDeleteBranch = async (branchId: string) => {
    if (
      !(await showConfirmDialog({
        title: localizeUi("ui.chat.chatbranchselector.deleteBranch"),
        message: localizeUi("ui.chat.chatbranchselector.deleteThisBranchMessagesWillBeLost"),
        confirmLabel: localizeUi("lorebook.editor.batch.delete"),
        tone: "destructive",
      }))
    ) {
      return;
    }
    const deletingActiveBranch = branchId === activeChatId;
    const nextActiveChatId = deletingActiveBranch
      ? (displayBranches.find((branch) => branch.id !== branchId)?.id ?? null)
      : null;
    try {
      await deleteChat.mutateAsync({ id: branchId, groupId: groupId ?? null, force: true });
      if (deletingActiveBranch) setActiveChatId(nextActiveChatId);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? localizeUi("chat.branches.deleteFailedWithReason", { reason: err.message })
          : localizeUi("chat.branches.deleteFailed"),
      );
    }
  };

  return (
    <div data-chat-branches className="space-y-2">
      <div>
        <input ref={importInputRef} type="file" accept=".jsonl" onChange={handleImportChat} className="hidden" />
        <div className="grid grid-cols-3 gap-1.5">
          <button
            type="button"
            onClick={() => exportChat.mutate({ chatId: activeChatId, format: "jsonl" })}
            disabled={exportChat.isPending}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-[var(--secondary)] px-2 py-2 text-[0.6875rem] font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:opacity-50"
          >
            <Upload size="0.75rem" />
            {localizeUi("ui.chat.chatbranchselector.jsonl")}
          </button>
          <button
            type="button"
            onClick={() => exportChat.mutate({ chatId: activeChatId, format: "text" })}
            disabled={exportChat.isPending}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-[var(--secondary)] px-2 py-2 text-[0.6875rem] font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:opacity-50"
          >
            <FileText size="0.75rem" />
            {localizeUi("ui.chat.chatbranchselector.text")}
          </button>
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            disabled={isImporting}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-[var(--secondary)] px-2 py-2 text-[0.6875rem] font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:opacity-50"
          >
            <Download size="0.75rem" />
            {isImporting ? "..." : localizeUi("ui.chat.chatbranchselector.import")}
          </button>
          <button
            type="button"
            onClick={() => exportChat.mutate({ chatId: activeChatId, format: "markdown" })}
            disabled={exportChat.isPending}
            title={localizeUi("chatInsights.export.markdownTitle")}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-[var(--secondary)] px-2 py-2 text-[0.6875rem] font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:opacity-50"
          >
            <Hash size="0.75rem" />
            {localizeUi("chatInsights.export.markdown")}
          </button>
          <button
            type="button"
            onClick={() => exportChat.mutate({ chatId: activeChatId, format: "html" })}
            disabled={exportChat.isPending}
            title={localizeUi("chatInsights.export.htmlTitle")}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-[var(--secondary)] px-2 py-2 text-[0.6875rem] font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:opacity-50"
          >
            <BookOpen size="0.75rem" />
            {localizeUi("chatInsights.export.html")}
          </button>
          <button
            type="button"
            onClick={() => openChatStats(activeChatId)}
            title={localizeUi("chatInsights.stats.open")}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-[var(--secondary)] px-2 py-2 text-[0.6875rem] font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] disabled:opacity-50"
          >
            <ChartColumn size="0.75rem" />
            {localizeUi("chatInsights.stats.button")}
          </button>
        </div>
      </div>

      <button
        type="button"
        onClick={() => openBranchBrowser(activeChatId, false)}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--secondary)] px-2 py-2 text-[0.6875rem] font-medium text-[var(--foreground)] ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)]"
      >
        <Maximize2 size="0.75rem" />
        {localizeUi("chat.branches.openBrowser")}
      </button>

      <div>
        {displayBranches.map((branch) => {
          const isActive = branch.id === activeChatId;

          return (
            <div
              key={branch.id}
              className={cn(
                "flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left transition-colors",
                isActive ? "bg-[var(--accent)]/70 text-[var(--foreground)]" : "hover:bg-[var(--accent)]/45",
              )}
            >
              <button
                type="button"
                onClick={() => setActiveChatId(branch.id)}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <div
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
                    isActive
                      ? "bg-[var(--foreground)]/15 text-[var(--foreground)]"
                      : "bg-[var(--secondary)] text-[var(--muted-foreground)]",
                  )}
                >
                  {isActive ? <Check size="0.75rem" /> : <MessageSquare size="0.75rem" />}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.8125rem] font-medium">{getChatDisplayName(branch)}</div>
                  <ChatBranchTail chatId={branch.id} updatedAt={branch.updatedAt} />
                </div>
              </button>

              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => openBranchBrowser(branch.id, true)}
                  className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                  title={localizeUi("chat.branches.preview")}
                  aria-label={localizeUi("chat.branches.previewLabel", {
                    name: getChatDisplayName(branch),
                  })}
                >
                  <Eye size="0.75rem" />
                </button>
                <button
                  type="button"
                  onClick={() => void handleRenameBranch(branch)}
                  className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                  title={localizeUi("ui.chat.chatbranchselector.renameBranch_09bac0c")}
                  aria-label={localizeUi("chat.branches.renameLabel", {
                    name: getChatDisplayName(branch),
                  })}
                >
                  <Pencil size="0.75rem" />
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeleteBranch(branch.id)}
                  disabled={deleteChat.isPending}
                  className="rounded-lg p-1.5 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-50"
                  title={localizeUi("ui.chat.chatbranchselector.deleteBranch_5478e60")}
                  aria-label={localizeUi("chat.branches.deleteLabel", {
                    name: getChatDisplayName(branch),
                  })}
                >
                  <Trash2 size="0.75rem" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {groupId && displayBranches.length > 1 && (
        <div>
          <button
            type="button"
            onClick={async () => {
              if (
                !(await showConfirmDialog({
                  title: localizeUi("ui.chat.chatbranchselector.deleteAllBranches"),
                  message: localizeUi("chat.branches.deleteAllConfirmation", {
                    count: displayBranches.length,
                  }),
                  confirmLabel: localizeUi("ui.characters.spritestab.deleteAll"),
                  tone: "destructive",
                }))
              ) {
                return;
              }
              deleteChatGroup.mutate({ groupId, force: true });
              setActiveChatId(null);
            }}
            disabled={deleteChatGroup.isPending}
            className="mari-chrome-control mari-chrome-control--primary w-full px-3 py-2 text-[0.6875rem] disabled:opacity-50"
          >
            <Trash2 size="0.75rem" />
            {localizeUi("ui.chat.chatbranchselector.deleteAllBranches")}
          </button>
        </div>
      )}
    </div>
  );
}
