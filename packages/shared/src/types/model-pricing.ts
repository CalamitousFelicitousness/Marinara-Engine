// What a model costs to call, as its own vendor states it.
//
// Text and audio need different shapes rather than one. Every text model prices
// the same two token streams, so a single unit works and each provider is
// converted into it on read. Audio has no such agreement: across NanoGPT's 80
// audio models the rate arrives under six different keys and no row carries a
// unit field, so the key name is the unit. A per-generation flat fee and a
// per-second rate cannot be expressed as each other, which is why the unit
// travels with the amount instead of being normalized away.

/** USD per million tokens. A provider publishing another unit is converted on read. */
export interface TextModelPricing {
  prompt: number;
  completion: number;
  /** Reading a cached prompt, where the provider prices that separately. */
  cachedPrompt?: number;
  currency: string;
}

/** The quantity an audio model bills by, named after the field its vendor fills. */
export type AudioPricingUnit = "per_second" | "per_minute" | "per_generation" | "per_thousand_chars";

export interface AudioModelPricing {
  amount: number;
  unit: AudioPricingUnit;
  currency: string;
  /** Floor charged when the rate alone would come to less. */
  minimum?: number;
}

/**
 * Which catalog lane an audio model serves. NanoGPT files sound effects and
 * music under one category and distinguishes them by neither flag nor field, so
 * a caller picks the lane by model id and this only separates speech from the
 * generators.
 */
export type AudioModelLane = "speech" | "music" | "other";
