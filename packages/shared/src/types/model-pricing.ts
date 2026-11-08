// What an audio model costs to call, as its vendor states it.
//
// Audio has no unit field: across NanoGPT's 80 audio models the rate arrives under six
// different keys, so the key name is the unit. A per-generation flat fee and a per-second
// rate cannot be expressed as each other, so the unit travels with the amount.

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
