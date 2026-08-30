// NanoGPT audio rows name their unit by which field they fill, and name their
// lane in a category the capability flags do not carry.
//
// Every row below was returned by GET /v1/audio-models on 2026-08-30. The lane
// half exists because `type=tts` returns 63 models of which only 26 are speech,
// and the 37 others omit `text_to_speech` rather than setting it false, so a
// flag check keeps all of them.

import assert from "node:assert/strict";
import { readAudioModelPricing } from "../../../packages/server/src/services/tts/audio-model-pricing.ts";
import { parseNanoGptModelOptions } from "../../../packages/server/src/services/tts/nanogpt-catalog.ts";

// ── Each unit is read from the field that names it ──
{
  const perSecond = readAudioModelPricing({ per_second: 0.00015, minimum: 0, currency: "USD" });
  assert.equal(perSecond?.amount, 0.00015, "a per-second rate keeps its amount");
  assert.equal(perSecond?.unit, "per_second", "and its unit");
  assert.equal("minimum" in (perSecond ?? {}), false, "a zero floor is no floor and is left off");

  const flat = readAudioModelPricing({ per_generation: 0.02266, currency: "USD" });
  assert.equal(flat?.unit, "per_generation", "a flat fee is its own unit, not a rate of zero seconds");
  assert.equal(flat?.amount, 0.02266, "Stable Audio 3 Small SFX bills per generation");

  const perChars = readAudioModelPricing({ per_thousand_chars: 0.03, currency: "USD" });
  assert.equal(perChars?.unit, "per_thousand_chars", "speech engines bill by characters, not seconds");

  const perMinute = readAudioModelPricing({ per_minute: 0.006, currency: "USD" });
  assert.equal(perMinute?.unit, "per_minute", "transcription bills by the minute");
}

// ── A block of characters is the same dimension at another scale ──
{
  // bytedance/seed-audio-1.0 prices 300 characters at a time.
  const block = readAudioModelPricing({
    per_prompt_char_block: 0.09,
    prompt_char_block_size: 300,
    minimum: 0.09,
    currency: "USD",
  });
  assert.ok(Math.abs((block?.amount ?? 0) - 0.3) < 1e-12, "0.09 per 300 characters is 0.30 per thousand");
  assert.equal(block?.unit, "per_thousand_chars", "so it needs no unit of its own");
  assert.equal(block?.minimum, 0.09, "its floor survives the conversion unscaled");
  assert.equal(
    readAudioModelPricing({ per_prompt_char_block: 0.09, prompt_char_block_size: 0 }),
    undefined,
    "a block of no characters is not a rate",
  );
}

// ── A floor is carried, because it is what a short generation actually costs ──
{
  const floored = readAudioModelPricing({ per_second: 0.01, minimum: 0.01, currency: "USD" });
  assert.equal(floored?.minimum, 0.01, "mirelo bills a one-cent floor per sound effect");

  // ACE-Step is the one model where the floor and the rate both matter: at
  // $0.0004 a second it stays flat until 125s, and the default context track is
  // 120s, so shortening one saves nothing.
  const ace = readAudioModelPricing({ per_second: 0.0004, minimum: 0.05, currency: "USD" });
  assert.equal(ace?.amount, 0.0004, "a rate that bills is kept");
  assert.equal(ace?.unit, "per_second", "and keeps the unit it bills in");
  assert.equal(ace?.minimum, 0.05, "beside the floor it never goes below");
}

// ── A zero rate is not a rate ──
{
  // Six music models spell a flat fee as a zero rate plus a floor. Reporting
  // "per second" would imply a shorter track is cheaper, and it is not: the
  // rate is zero and no multiplier applies, so the floor is the whole price.
  const minimax = readAudioModelPricing({ per_second: 0, minimum: 0.15, currency: "USD" });
  assert.equal(minimax?.amount, 0.15, "the floor is the price when nothing bills by quantity");
  assert.equal(minimax?.unit, "per_generation", "and it bills once per generation, not per second");
  assert.equal(minimax?.minimum, undefined, "the floor is the rate now, so it is not also a floor");

  // vibevoice needs no precedence rule: dropping the zero leaves one rate.
  const vibevoice = readAudioModelPricing({ per_generation: 0.15, per_thousand_chars: 0, currency: "USD" });
  assert.equal(vibevoice?.amount, 0.15, "a dimension priced at zero does not bill");
  assert.equal(vibevoice?.unit, "per_generation", "so the one rate that does is the answer");

  // No published row is priced at zero with no floor, but one would be free.
  assert.equal(
    readAudioModelPricing({ per_second: 0, currency: "USD" }),
    undefined,
    "a row that bills by nothing and floors at nothing publishes no price at all",
  );
}

// ── Absent, malformed and negative rows produce nothing ──
{
  assert.equal(readAudioModelPricing(undefined), undefined, "no pricing means no price");
  assert.equal(readAudioModelPricing([0.01]), undefined, "an array is not a pricing record");
  assert.equal(readAudioModelPricing({ currency: "USD" }), undefined, "a currency alone is not a rate");
  assert.equal(readAudioModelPricing({ per_second: -1 }), undefined, "a negative rate is refused");
  assert.equal(readAudioModelPricing({ per_second: "loud" }), undefined, "a non-numeric rate is refused");
}

// ── The lane comes from the category, which is the only field that carries it ──
{
  const parsed = parseNanoGptModelOptions({
    data: [
      {
        id: "Kokoro-82M",
        name: "Kokoro",
        category: "audio_tts",
        capabilities: { text_to_speech: true },
        supported_parameters: { voices: ["af_bella", "am_adam"] },
        pricing: { per_thousand_chars: 0.03, currency: "USD" },
      },
      // Carries no text_to_speech flag at all, which is how every generator row
      // arrives. A check for an explicit false keeps this in the voice dropdown.
      {
        id: "ACE-Step-v1.5-Base",
        name: "ACE-Step",
        category: "audio_music",
        pricing: { per_second: 0.00015, minimum: 0, currency: "USD" },
      },
      { id: "elevenlabs-voice-clone", name: "Clone", category: "voice_clone" },
    ],
  });

  assert.equal(parsed.length, 3, "every row is kept, because the lane sorts them rather than a filter");
  assert.equal(parsed[0]?.lane, "speech", "a speech category is the speech lane");
  assert.equal(parsed[1]?.lane, "music", "music and sound effects share one category and one lane");
  assert.equal(parsed[2]?.lane, "other", "anything else is neither, and never offered as a voice");

  assert.equal(parsed[0]?.pricing?.unit, "per_thousand_chars", "a row's price rides with its lane");
  assert.equal(parsed[1]?.pricing?.amount, 0.00015, "including the generator rows");
  assert.equal(parsed[2]?.pricing, undefined, "a row with no pricing field carries none");
  assert.deepEqual(parsed[0]?.voices, ["af_bella", "am_adam"], "voices still come from supported_parameters");
}

// ── A claim to speak outranks a category that says otherwise ──
{
  const parsed = parseNanoGptModelOptions({
    data: [{ id: "odd", category: "audio_processing", capabilities: { text_to_speech: true } }],
  });
  assert.equal(parsed[0]?.lane, "speech", "a row asserting the capability is speech whatever its category");
}

// ── A row that says it cannot speak is still dropped ──
{
  const parsed = parseNanoGptModelOptions({
    data: [{ id: "whisper", category: "audio_stt", capabilities: { text_to_speech: false } }],
  });
  assert.equal(parsed.length, 0, "an explicit denial is still honored");
}

console.info("NanoGPT audio model pricing regression passed.");
