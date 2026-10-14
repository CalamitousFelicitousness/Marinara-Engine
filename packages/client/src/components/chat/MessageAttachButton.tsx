// Message action that appends files to an already-sent message, using the composer's file rules.
import { useRef, useState } from "react";
import { Loader2, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useAppendMessageAttachments } from "../../hooks/use-chats";
import { ApiError } from "../../lib/api-client";
import {
  CHAT_ATTACHMENT_ACCEPT,
  CHAT_ATTACHMENT_MAX_BYTES,
  isSupportedChatAttachment,
  prepareChatAttachment,
} from "../../lib/chat-attachment-files";
import { MESSAGE_ACTION_ICON_SIZE, MessageActionButton } from "./MessageActionButton";

export function MessageAttachButton({
  chatId,
  messageId,
  stopPropagation,
}: {
  chatId: string;
  messageId: string;
  stopPropagation?: boolean;
}) {
  const { t: localizeUi } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const append = useAppendMessageAttachments(chatId);
  const busy = reading || append.isPending;

  const attachFiles = async (files: File[]) => {
    const accepted = files.filter((file) => {
      if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
        toast.error(localizeUi("ui.chat.chatinput.value1IsTooLargeMax20Mb", { value1: file.name }));
        return false;
      }
      if (!isSupportedChatAttachment(file)) {
        toast.error(
          localizeUi("ui.chat.chatinput.value1IsNotSupportedInChatAttachImagesPdfs", {
            value1: file.name || localizeUi("ui.chat.chatinput.thatFile"),
          }),
        );
        return false;
      }
      return true;
    });
    if (accepted.length === 0) return;

    setReading(true);
    const attachments: Array<{ type: string; data: string; filename: string; name: string }> = [];
    try {
      for (const file of accepted) {
        try {
          const prepared = await prepareChatAttachment(file);
          attachments.push({ type: prepared.type, data: prepared.data, filename: prepared.name, name: prepared.name });
        } catch {
          const failedKey = file.type.startsWith("image/")
            ? "ui.chat.chatinput.failedToPrepareValue1"
            : "ui.chat.chatinput.failedToReadValue1";
          toast.error(localizeUi(failedKey, { value1: file.name }));
        }
      }
    } finally {
      setReading(false);
    }
    if (attachments.length === 0) return;

    append.mutate(
      { messageId, attachments },
      {
        onError: (error) =>
          toast.error(
            localizeUi(
              error instanceof ApiError && error.status === 409
                ? "chat.message.attachments.busy"
                : "chat.message.attachments.failed",
            ),
          ),
      },
    );
  };

  return (
    <>
      <MessageActionButton
        icon={
          busy ? (
            <Loader2 size={MESSAGE_ACTION_ICON_SIZE} className="animate-spin" />
          ) : (
            <Paperclip size={MESSAGE_ACTION_ICON_SIZE} />
          )
        }
        onClick={() => inputRef.current?.click()}
        title={localizeUi("chat.message.attachments.add")}
        disabled={busy}
        stopPropagation={stopPropagation}
      />
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={CHAT_ATTACHMENT_ACCEPT}
        className="hidden"
        // A programmatic click still bubbles through React to the message row's tap handlers.
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void attachFiles(files);
        }}
      />
    </>
  );
}
