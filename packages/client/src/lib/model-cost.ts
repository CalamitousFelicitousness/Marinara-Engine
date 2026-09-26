// Turns a published price into something readable in a list.
//
// Two rules the callers depend on. A model a subscription covers shows its
// coverage rather than a rate, because the rate is a number that account will
// never pay. And a rate of zero reads as free rather than as "$0", which scans
// as a missing value.

import type { AudioModelPricing, AudioPricingUnit, TextModelPricing } from "@marinara-engine/shared";
import type { TFunction } from "i18next";

/**
 * Significant digits rather than fixed decimals, because these prices span four
 * orders of magnitude: an audio rate can be $0.00015 a second while a text model
 * is $150 a million tokens, and either rounds to nothing under the other's rule.
 */
function money(amount: number, currency: string, digits = 2): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumSignificantDigits: digits,
    }).format(amount);
  } catch {
    // An unrecognized currency code would otherwise throw inside a render.
    return `${amount} ${currency}`;
  }
}

const AUDIO_UNIT_KEYS: Record<AudioPricingUnit, string> = {
  per_second: "ui.connections.modelcost.perSecond",
  per_minute: "ui.connections.modelcost.perMinute",
  per_generation: "ui.connections.modelcost.perGeneration",
  per_thousand_chars: "ui.connections.modelcost.perThousandChars",
};

/** "$0.08 in / $0.25 out", or free. Per million tokens, which the caller labels. */
export function formatTokenPrice(pricing: TextModelPricing, localizeUi: TFunction, digits = 2): string {
  if (pricing.prompt === 0 && pricing.completion === 0) return localizeUi("ui.connections.modelcost.free");
  return localizeUi("ui.connections.modelcost.inOut", {
    input: money(pricing.prompt, pricing.currency, digits),
    output: money(pricing.completion, pricing.currency, digits),
  });
}

/** "$0.01 per second", with the floor appended where one applies. */
export function formatAudioRate(pricing: AudioModelPricing, localizeUi: TFunction): string {
  const rate = `${money(pricing.amount, pricing.currency)} ${localizeUi(AUDIO_UNIT_KEYS[pricing.unit])}`;
  if (!pricing.minimum) return rate;
  return `${rate}, ${localizeUi("ui.connections.modelcost.minimum", {
    amount: money(pricing.minimum, pricing.currency),
  })}`;
}

/** The fields of a subscription usage reading that coverage depends on. */
export interface SubscriptionCoverageReading {
  active: boolean;
  weeklyInputTokens: { remaining: number | null } | null;
  dailyInputTokens: { remaining: number | null } | null;
}

/**
 * Whether a plan covers this model right now.
 *
 * Coverage alone is not enough: with overage off, an exhausted allowance means
 * the request is refused rather than billed, so a model that is covered on paper
 * bills nothing and does nothing. The price is the honest thing to show then.
 * A null counter is "not reported", never an empty allowance.
 */
export function isCoveredBySubscription(
  usage: SubscriptionCoverageReading | null | undefined,
  subscriptionIncluded: boolean | undefined,
): boolean {
  if (!usage?.active || subscriptionIncluded !== true) return false;
  const remaining = usage.weeklyInputTokens?.remaining ?? usage.dailyInputTokens?.remaining ?? null;
  return remaining === null || remaining > 0;
}
