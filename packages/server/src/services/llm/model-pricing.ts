// Reads a provider's published per-model price into one unit.
//
// Two providers publish prices in the model listing and they agree on nothing
// but the field name. NanoGPT states its unit (`unit: "per_million_tokens"`)
// and prices cache reads per thousand tokens in that same object. OpenRouter
// carries no unit at all, prices per token as decimal strings, and writes -1
// where a router model's backend, and so its cost, is not chosen until the
// request runs.
//
// A price is therefore read only where its unit is known: the row declares one,
// or the provider is OpenRouter. A custom endpoint that happens to serve a
// pricing field is left alone rather than scaled by a guess, which also means a
// custom connection pointed at NanoGPT still gets prices, because that unit
// travels with the row rather than with the provider label.

import type { TextModelPricing } from "@marinara-engine/shared";

const PER_MILLION = 1_000_000;
const PER_THOUSAND = 1_000;

/**
 * A published rate, or null where the field is absent or is not one.
 *
 * Zero is a real price and survives; negative is a sentinel and does not.
 */
function readRate(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function readTextModelPricing(provider: string, model: Record<string, unknown>): TextModelPricing | undefined {
  const pricing = model.pricing;
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return undefined;
  const row = pricing as Record<string, unknown>;

  const perMillion = row.unit === "per_million_tokens";
  if (!perMillion && provider !== "openrouter") return undefined;

  const prompt = readRate(row.prompt);
  const completion = readRate(row.completion);
  if (prompt === null || completion === null) return undefined;
  const scale = perMillion ? 1 : PER_MILLION;

  // Each cache field names its own unit, so the scale follows whichever answered
  // rather than the provider.
  const perThousandCache = readRate(row.cacheReadInputPer1kTokens);
  const perTokenCache = readRate(row.input_cache_read);
  const cachedPrompt =
    perThousandCache !== null
      ? perThousandCache * PER_THOUSAND
      : perTokenCache !== null
        ? perTokenCache * PER_MILLION
        : null;

  return {
    prompt: prompt * scale,
    completion: completion * scale,
    ...(cachedPrompt === null ? {} : { cachedPrompt }),
    // OpenRouter omits a currency and quotes USD everywhere it publishes prices.
    currency: typeof row.currency === "string" && row.currency.trim() ? row.currency.trim() : "USD",
  };
}
