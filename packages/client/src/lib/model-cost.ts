// Formats a published audio price for a list.

import type { AudioModelPricing, AudioPricingUnit } from "@marinara-engine/shared";
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

/** "$0.01 per second", with the floor appended where one applies. */
export function formatAudioRate(pricing: AudioModelPricing, localizeUi: TFunction): string {
  const rate = `${money(pricing.amount, pricing.currency)} ${localizeUi(AUDIO_UNIT_KEYS[pricing.unit])}`;
  if (!pricing.minimum) return rate;
  return `${rate}, ${localizeUi("ui.connections.modelcost.minimum", {
    amount: money(pricing.minimum, pricing.currency),
  })}`;
}
