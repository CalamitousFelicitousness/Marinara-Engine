// A published model price becomes one unit, or nothing at all.
//
// The rows below were returned by the live listings on 2026-08-30. The two
// providers that publish prices disagree on the unit, the value type and the
// cache field, and only one of them says so, which is the whole reason this
// reader exists. Guessing the unit is how a per-token rate renders as a
// per-million one and understates a model by six orders of magnitude.

import assert from "node:assert/strict";
import { readTextModelPricing } from "../../packages/server/src/services/llm/model-pricing.ts";

// ── NanoGPT states its unit, so the numbers pass through ──
{
  const priced = readTextModelPricing("nanogpt", {
    id: "z-ai/glm-5.3-flash",
    pricing: {
      prompt: 0.075,
      completion: 0.25,
      cacheReadInputPer1kTokens: 1.5e-5,
      currency: "USD",
      unit: "per_million_tokens",
    },
  });
  assert.equal(priced?.prompt, 0.075, "a declared per-million price is already in the target unit");
  assert.equal(priced?.completion, 0.25, "so is the completion side");
  assert.equal(priced?.currency, "USD", "the stated currency is kept");
  // Priced per thousand beside per-million siblings in the same object.
  assert.ok(
    Math.abs((priced?.cachedPrompt ?? 0) - 0.015) < 1e-12,
    "a cache read priced per thousand tokens is scaled to per million",
  );
}

// ── OpenRouter states nothing, so the provider names the unit ──
{
  const priced = readTextModelPricing("openrouter", {
    id: "tencent/hy4-preview",
    pricing: { prompt: "0.000000834", completion: "0.000002501", input_cache_read: "0.000000042" },
  });
  assert.ok(Math.abs((priced?.prompt ?? 0) - 0.834) < 1e-9, "a per-token string becomes a per-million number");
  assert.ok(Math.abs((priced?.completion ?? 0) - 2.501) < 1e-9, "and so does the completion side");
  assert.ok(Math.abs((priced?.cachedPrompt ?? 0) - 0.042) < 1e-9, "OpenRouter prices cache reads per token");
  assert.equal(priced?.currency, "USD", "a listing that names no currency is read as the one it quotes in");
}

// ── -1 is a sentinel, not a price ──
{
  // OpenRouter writes it on router models, whose backend and cost are chosen
  // per request. Scaled it would read as minus one million dollars per million.
  const routed = readTextModelPricing("openrouter", {
    id: "openrouter/auto-beta",
    pricing: { prompt: "-1", completion: "-1" },
  });
  assert.equal(routed, undefined, "a negative rate is refused rather than rendered");
}

// ── zero is a price ──
{
  const free = readTextModelPricing("openrouter", { id: "free/model", pricing: { prompt: "0", completion: "0" } });
  assert.equal(free?.prompt, 0, "a free model is priced, not priceless");
  assert.equal(free?.completion, 0, "both sides of a free model survive");
}

// ── an unknown unit is left alone ──
{
  const custom = readTextModelPricing("custom", { id: "x", pricing: { prompt: 3, completion: 6 } });
  assert.equal(custom, undefined, "a provider that declares no unit is never scaled by a guess");

  // The unit travels with the row, so a custom connection pointed at NanoGPT
  // still prices, which is what makes the rule about units and not vendors.
  const proxied = readTextModelPricing("custom", {
    id: "x",
    pricing: { prompt: 1, completion: 2, unit: "per_million_tokens", currency: "USD" },
  });
  assert.equal(proxied?.prompt, 1, "a declared unit is honored whatever the provider is called");
}

// ── absent, malformed and partial rows produce nothing ──
{
  assert.equal(readTextModelPricing("openrouter", { id: "x" }), undefined, "no pricing field means no price");
  assert.equal(
    readTextModelPricing("openrouter", { id: "x", pricing: [1, 2] }),
    undefined,
    "an array is not a pricing record",
  );
  assert.equal(
    readTextModelPricing("openrouter", { id: "x", pricing: { prompt: "0.001" } }),
    undefined,
    "half a price is not a price",
  );
  assert.equal(
    readTextModelPricing("openrouter", { id: "x", pricing: { prompt: "free", completion: "0" } }),
    undefined,
    "a non-numeric rate is refused",
  );
  const uncached = readTextModelPricing("openrouter", { id: "x", pricing: { prompt: "0.000001", completion: "0.000002" } });
  assert.equal("cachedPrompt" in (uncached ?? {}), false, "an unpriced cache read leaves the field off entirely");
}

console.info("Model pricing regression passed.");
