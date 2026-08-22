import type { ChatMode } from "@marinara-engine/shared";
import { CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { requestChatHelp } from "../../lib/chat-help-events";
import { ChatToolbarButton } from "./ChatToolbarControls";

export function ChatHelpButton({ mode, compact = false }: { mode: ChatMode; compact?: boolean }) {
  const { t } = useTranslation();

  return (
    <ChatToolbarButton
      icon={<CircleHelp size="0.875rem" />}
      title={t("chat.help.button")}
      helpTarget="help"
      size={compact ? "sm" : undefined}
      onClick={() => requestChatHelp(mode)}
    />
  );
}
