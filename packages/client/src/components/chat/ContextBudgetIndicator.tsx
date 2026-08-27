import type { CSSProperties } from "react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { formatCompactTokenCount, type ProfessorMariContextBudget } from "../../lib/professor-mari-context-budget";

export function ContextBudgetIndicator({ budget }: { budget: ProfessorMariContextBudget }) {
  const { t: localizeUi } = useUiTranslation();
  const used = formatCompactTokenCount(budget.usedTokens);
  const maximum = formatCompactTokenCount(budget.maxTokens);
  const ariaLabel = localizeUi("ui.chat.contextBudget.aria", { used, maximum });
  const progressStyle = { "--context-budget": `${budget.percentage}%` } as CSSProperties;

  return (
    <div
      data-component="ContextBudget"
      className="mb-2 space-y-1 px-0.5 text-[0.6875rem] text-[var(--muted-foreground)]"
    >
      <div className="flex items-center justify-between gap-3">
        <span>{localizeUi("ui.chat.contextBudget.label")}</span>
        <span className="tabular-nums text-foreground/80">
          {localizeUi("ui.chat.contextBudget.value", { used, maximum })}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuemin={0}
        aria-valuemax={budget.maxTokens}
        aria-valuenow={Math.min(budget.usedTokens, budget.maxTokens)}
        className="h-1 overflow-hidden rounded-full bg-[var(--muted)]/55"
      >
        <div
          className="h-full w-[var(--context-budget)] rounded-full bg-[var(--primary)] transition-[width] duration-200"
          style={progressStyle}
        />
      </div>
    </div>
  );
}
