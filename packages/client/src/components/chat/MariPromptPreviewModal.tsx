// #4931: synthetic "Peek Prompt" preview of a Professor Mari character/preset edit. Shows the
// assembled prompt before vs after with the change highlighted (added green, removed red). It is
// assembled on its own (default preset, no persona, no chat history), so it is a labeled preview,
// not a real chat prompt.
import { useTranslation as useUiTranslation } from "react-i18next";
import { Loader2, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { diffWords } from "../../lib/word-diff";
import {
  NEUTRAL_PANEL_CLOSE_BUTTON,
  NEUTRAL_PANEL_CLOSE_ICON_SIZE,
  NEUTRAL_PANEL_HEADER,
  NEUTRAL_PANEL_SCROLL_AREA,
  NEUTRAL_PANEL_SHELL,
  NEUTRAL_PANEL_TITLE,
} from "../ui/neutral-surface-styles";

export type MariPromptRenderSide = { messages: Array<{ role: string; content: string }> } | null;

function sideToText(side: MariPromptRenderSide): string {
  return side ? side.messages.map((message) => message.content).join("\n\n") : "";
}

export function MariPromptPreviewModal({
  title,
  loading,
  error,
  before,
  after,
  onClose,
}: {
  title: string;
  loading: boolean;
  error: boolean;
  before: MariPromptRenderSide;
  after: MariPromptRenderSide;
  onClose: () => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  const segments = diffWords(sideToText(before), sideToText(after));
  const empty = !loading && !error && segments.every((segment) => !segment.value.trim());
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 max-md:pt-[env(safe-area-inset-top)]"
      onClick={onClose}
    >
      <div
        className={cn(NEUTRAL_PANEL_SHELL, "mx-4 flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={cn(NEUTRAL_PANEL_HEADER, "shrink-0 flex items-center justify-between gap-3 px-5 py-3")}>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className={cn(NEUTRAL_PANEL_TITLE, "shrink-0 text-sm")}>{title}</h3>
            <span className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--secondary)]/60 px-2 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wider text-[var(--muted-foreground)]">
              {localizeUi("ui.chat.maripromptpreviewmodal.previewBadge")}
            </span>
          </div>
          <button
            onClick={onClose}
            className={cn(NEUTRAL_PANEL_CLOSE_BUTTON)}
            aria-label={localizeUi("ui.chat.maripromptpreviewmodal.close")}
          >
            <X size={NEUTRAL_PANEL_CLOSE_ICON_SIZE} />
          </button>
        </div>
        <div className={cn(NEUTRAL_PANEL_SCROLL_AREA, "min-h-0 flex-1 overflow-y-auto p-4")}>
          <p className="mb-2 text-[0.6875rem] text-[var(--muted-foreground)]">
            {localizeUi("ui.chat.maripromptpreviewmodal.explainer")}
          </p>
          {loading ? (
            <p className="flex items-center gap-2 text-[0.6875rem] text-[var(--muted-foreground)]">
              <Loader2 size="0.85rem" className="animate-spin" />
              {localizeUi("ui.chat.maripromptpreviewmodal.loading")}
            </p>
          ) : error ? (
            <p className="text-[0.6875rem] italic text-[var(--destructive)]">
              {localizeUi("ui.chat.maripromptpreviewmodal.error")}
            </p>
          ) : empty ? (
            <p className="text-[0.6875rem] italic text-[var(--muted-foreground)]">
              {localizeUi("ui.chat.maripromptpreviewmodal.noPreview")}
            </p>
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded-lg bg-[var(--background)]/70 p-3 font-mono text-[0.6875rem] leading-relaxed text-[var(--foreground)]">
              {segments.map((segment, index) => {
                if (segment.type === "equal") return <span key={index}>{segment.value}</span>;
                if (segment.type === "added") {
                  return (
                    <span key={index} className="rounded bg-emerald-500/25 text-[var(--foreground)]">
                      {segment.value}
                    </span>
                  );
                }
                return (
                  <span key={index} className="rounded bg-[var(--destructive)]/25 text-[var(--foreground)] line-through">
                    {segment.value}
                  </span>
                );
              })}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
