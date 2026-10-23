import { useTranslation } from "react-i18next";
import { useChat, useUpdateChatMetadata } from "../../hooks/use-chats";
import { useLorebooks } from "../../hooks/use-lorebooks";
import { AgentSettingsToggle } from "./AgentSettingsControls";

export function AgentLorebookAttachment({ chatId, agentType }: { chatId: string; agentType: string }) {
  const { t } = useTranslation();
  const { data: chat } = useChat(chatId);
  const { data: lorebooks = [], isLoading, isError } = useLorebooks();
  const updateMetadata = useUpdateChatMetadata({ serialize: true });
  const attachment = chat?.metadata.agentLorebookAttachments?.[agentType];
  const enabled = attachment?.enabled === true;
  const selectedId = attachment?.lorebookId ?? "";
  const missing = selectedId !== "" && !lorebooks.some((book) => book.id === selectedId);
  const save = (patch: { enabled?: boolean; lorebookId?: string | null }) => {
    updateMetadata.mutate({
      id: chatId,
      agentLorebookAttachments: {
        [agentType]: { enabled, lorebookId: selectedId || null, ...patch },
      },
    });
  };

  return (
    <div data-agent-lorebook-attachment={agentType} className="space-y-2">
      <AgentSettingsToggle
        label={t("chat.agentLorebook.attach")}
        description={t("chat.agentLorebook.description")}
        enabled={enabled}
        onToggle={() => save({ enabled: !enabled })}
      />
      {enabled && (
        <label className="flex min-w-0 flex-col gap-1.5 text-[0.6875rem]">
          <span className="font-medium">{t("chat.agentLorebook.select")}</span>
          <select
            value={selectedId}
            disabled={isLoading || isError || updateMetadata.isPending}
            onChange={(event) => save({ lorebookId: event.target.value || null })}
            className="mari-chrome-field min-h-10 w-full min-w-0 rounded-md px-2.5 py-2 text-base md:text-xs"
          >
            <option value="">{t("chat.agentLorebook.choose")}</option>
            {missing && <option value={selectedId}>{t("chat.agentLorebook.unavailable")}</option>}
            {lorebooks.map((book) => (
              <option key={book.id} value={book.id} disabled={book.enabled === false}>
                {book.name}
              </option>
            ))}
          </select>
          {isError ? (
            <span role="status">{t("chat.agentLorebook.loadError")}</span>
          ) : missing ? (
            <span>{t("chat.agentLorebook.unavailableHint")}</span>
          ) : !isLoading && lorebooks.length === 0 ? (
            <span>{t("chat.agentLorebook.empty")}</span>
          ) : null}
        </label>
      )}
    </div>
  );
}
