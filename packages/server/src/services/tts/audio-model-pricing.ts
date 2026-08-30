// Reads one NanoGPT audio model's published rate.
//
// There is no unit field on an audio row. The vendor names the unit by which
// key it fills, and across the 80 published models it fills six of them:
// per_thousand_chars on the speech engines, per_minute on transcription,
// per_second and per_generation split roughly evenly across music and sound
// effects, and per_prompt_char_block with its own block size on one.
//
// A rate of zero means that dimension does not bill, and `minimum` is then the
// entire price:
//
//   Minimax-Music-2.5        { per_second: 0,      minimum: 0.15 }  flat $0.15
//   google/lyria-3-pro/music { per_second: 0,      minimum: 0.08 }  flat $0.08
//   microsoft/vibevoice      { per_generation: 0.15, per_thousand_chars: 0 }  flat $0.15
//   ACE-Step-1.5             { per_second: 0.0004, minimum: 0.05 }  flat below 125s
//   mirelo-ai/sfx1.6         { per_second: 0.01,   minimum: 0.01 }  flat below 1s
//   bytedance/seed-audio-1.0 { per_prompt_char_block: 0.09, prompt_char_block_size: 300 }
//
// Reading the rate alone prints "free" on a model that bills 15 cents a track.

import type { AudioModelPricing, AudioPricingUnit } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";

/** A published rate. Zero is a real rate, and a negative one is not a rate at all. */
function readAmount(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Every key a rate can arrive under. Not a precedence list: see readAudioModelPricing. */
const RATE_KEYS: ReadonlyArray<[string, AudioPricingUnit]> = [
  ["per_thousand_chars", "per_thousand_chars"],
  ["per_second", "per_second"],
  ["per_minute", "per_minute"],
  ["per_generation", "per_generation"],
];

/**
 * The per-thousand-character rate a block price works out to.
 *
 * One model prices a fixed block of characters rather than a thousand of them,
 * which is the same dimension at a different scale, so it converts rather than
 * needing a unit of its own.
 */
function readCharBlockRate(row: Record<string, unknown>): number | null {
  const block = readAmount(row.per_prompt_char_block);
  const size = readAmount(row.prompt_char_block_size);
  if (block === null || size === null || size <= 0) return null;
  return (block / size) * 1000;
}

export function readAudioModelPricing(pricing: unknown): AudioModelPricing | undefined {
  if (!pricing || typeof pricing !== "object" || Array.isArray(pricing)) return undefined;
  const row = pricing as Record<string, unknown>;
  const currency = typeof row.currency === "string" && row.currency.trim() ? row.currency.trim() : "USD";
  const minimum = readAmount(row.minimum);

  const blockRate = readCharBlockRate(row);
  if (blockRate !== null) {
    return { amount: blockRate, unit: "per_thousand_chars", currency, ...(minimum ? { minimum } : {}) };
  }

  // A rate of zero is not a rate. It is how this catalog says a dimension does
  // not bill: vibevoice publishes per_thousand_chars: 0 beside a flat
  // per_generation, and six music models publish per_second: 0 beside the floor
  // that is their entire price. Dropping the zeros leaves exactly one rate or
  // none across all 80 published models, so there is no precedence to decide.
  const rates = RATE_KEYS.map(([key, unit]) => ({ unit, amount: readAmount(row[key]) })).filter(
    (rate): rate is PublishedRate => rate.amount !== null && rate.amount > 0,
  );

  if (!isNonEmpty(rates)) {
    // Nothing bills by quantity, so the floor is the whole price however the
    // vendor spelled it. Calling it per-second here would imply a shorter
    // generation costs less, and for these models it does not.
    return minimum ? { amount: minimum, unit: "per_generation", currency } : undefined;
  }

  if (rates.length > 1) {
    logger.warn("Audio model pricing published %d rates at once: %j", rates.length, rates);
  }
  return { amount: rates[0].amount, unit: rates[0].unit, currency, ...(minimum ? { minimum } : {}) };
}

interface PublishedRate {
  unit: AudioPricingUnit;
  amount: number;
}

function isNonEmpty<T>(values: readonly T[]): values is readonly [T, ...T[]] {
  return values.length > 0;
}
