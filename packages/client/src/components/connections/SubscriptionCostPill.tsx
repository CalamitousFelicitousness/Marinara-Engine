// ──────────────────────────────────────────────
// NanoGPT subscription cost pill
// ──────────────────────────────────────────────
//
// Rendered beside a model in every list that shows what a model costs against a
// NanoGPT subscription: the connection editor and the shared model picker.
//
// The data comes from the `detailed=true` models call rather than the usage
// endpoint, so showing it costs no extra request. It is still gated behind the
// connection's own **Show subscription usage** toggle: a pay-as-you-go user who
// never enables the meter has no subscription cost to compare against, and the
// pills would be noise.

import { useTranslation as useUiTranslation } from "react-i18next";
import { cn } from "../../lib/utils";

/** The subscription fields a model record may carry. */
export interface SubscriptionCostFields {
  /** True when the account's subscription covers the model; undefined when unknown. */
  subscriptionIncluded?: boolean;
  /** Input tokens charged per token of subscription quota (2 = 2x). */
  inputTokenMultiplier?: number;
}

/**
 * Cost pill for one model.
 *
 * An included model always shows a multiplier (green at 1x) so "covered at the
 * normal rate" stays visually distinct from "no data at all", which shows
 * nothing. Only `included: true` earns a multiplier pill: excluded models report
 * a multiplier of 1, and drawing that as coverage would be false.
 */
export function SubscriptionCostPill({ model }: { model: SubscriptionCostFields }) {
  const { t: localizeUi } = useUiTranslation();
  const multiplier = model.inputTokenMultiplier ?? 1;

  if (model.subscriptionIncluded === true) {
    const boosted = multiplier > 1;
    return (
      <span
        className={cn(
          "rounded-md px-1.5 py-0.5 text-[0.5625rem] font-semibold",
          boosted
            ? "bg-[var(--marinara-editor-accent)]/15 text-[var(--marinara-editor-accent)]"
            : "bg-emerald-400/15 text-emerald-400",
        )}
        title={localizeUi(
          boosted
            ? "ui.connections.connectioneditor.inputTokenMultiplierHint_boosted"
            : "ui.connections.connectioneditor.inputTokenMultiplierHint",
          { multiplier: String(multiplier) },
        )}
      >
        {localizeUi("ui.connections.connectioneditor.multiplierBadge", { multiplier: String(multiplier) })}
      </span>
    );
  }

  if (model.subscriptionIncluded === false) {
    return (
      <span
        className="rounded-md bg-[var(--secondary)] px-1.5 py-0.5 text-[0.5625rem] font-medium text-[var(--muted-foreground)]"
        title={localizeUi("ui.connections.connectioneditor.notInSubscriptionHint")}
      >
        {localizeUi("ui.connections.connectioneditor.paid")}
      </span>
    );
  }

  return null;
}
