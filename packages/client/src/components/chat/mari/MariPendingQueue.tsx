// Messages waiting their turn while Professor Mari works, above her composer. Built from the same MariRow as
// her connection and reference lists. No run going, or a later send that began first, means a message is held: it
// needs your Send (or your ×).
import type { MariPendingMessageSummary } from "@marinara-engine/shared";
import { Clock, PauseCircle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MariRow } from "../mari-primitives";

export function MariPendingQueue({
  messages,
  running,
  onRemove,
  onSend,
}: {
  messages: MariPendingMessageSummary[];
  running: boolean;
  onRemove: (id: string) => void;
  onSend: (message: MariPendingMessageSummary) => void;
}) {
  const { t } = useTranslation();
  if (messages.length === 0) return null;
  return (
    <div className="mari-pending-queue mari-list" role="list" aria-label={t("mari.queue.label")}>
      {messages.map((message) => {
        const waiting = running && !message.held;
        const status = t(waiting ? "mari.queue.waiting" : "mari.queue.held");
        return (
          <MariRow
            key={message.id}
            role="listitem"
            slot={waiting ? <Clock aria-hidden="true" /> : <PauseCircle aria-hidden="true" />}
            title={message.text}
            hint={message.text}
            fact={
              message.attachments.length > 0
                ? `${status} · ${t("mari.queue.attached", { count: message.attachments.length })}`
                : status
            }
            trail={
              <span className="mari-pending-queue__actions">
                {running ? null : (
                  <button type="button" className="mari-pending-queue__send" onClick={() => onSend(message)}>
                    {t("mari.queue.send")}
                  </button>
                )}
                <button
                  type="button"
                  className="mari-pending-queue__remove"
                  onClick={() => onRemove(message.id)}
                  aria-label={t("mari.queue.remove")}
                  title={t("mari.queue.remove")}
                >
                  <X size="0.875rem" aria-hidden="true" />
                </button>
              </span>
            }
          />
        );
      })}
    </div>
  );
}
