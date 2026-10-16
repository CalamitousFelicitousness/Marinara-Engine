import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  capabilityModelId,
  findKnownModel,
  impliesProxyThinking,
  isClaudeOpus55Model,
  isGeminiArgonModel,
  isXaiConfigurableReasoningModel,
  isZaiMaxReasoningEffortModel,
  resolveProviderReasoningEffort,
  shouldSuppressUnknownModelParameters,
  supportsXhighReasoningEffort,
} from "../../packages/shared/src/constants/model-lists.js";
import { relevantGenerationParameters } from "../../packages/shared/src/constants/generation-parameter-relevance.js";
import { AnthropicProvider } from "../../packages/server/src/services/llm/providers/anthropic.provider.js";
import type { APIProvider } from "../../packages/shared/src/types/connection.js";

// Proxy ids (LinkAPI's public /api/pricing list, October 2026) on their native provider must get the catalog model's
// capabilities, while the request keeps the configured id. Wire-level fixture; no provider calls or credentials.
const requests: Array<Record<string, any>> = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      content: [{ type: "text", text: "Hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const anthropic = new AnthropicProvider(`http://127.0.0.1:${address.port}`, "fixture");

try {
  await test("proxy ids resolve to the catalog model they serve", () => {
    const cases: Array<[APIProvider, string, string]> = [
      ["anthropic", "[次]claude-opus-4-6-thinking", "claude-opus-4-6"],
      ["anthropic", "[SP]claude-opus-4-6", "claude-opus-4-6"],
      ["anthropic", "claude-sonnet-4-6-thinking", "claude-sonnet-4-6"],
      ["anthropic", "claude-opus-4-7-r", "claude-opus-4-7"],
      ["anthropic", "【限时】 claude-opus-4-8", "claude-opus-4-8"],
      ["anthropic", "[次]claude-opus-5-5", "claude-opus-5-5"],
      ["anthropic", "anthropic/claude-opus-4-6", "claude-opus-4-6"],
      ["google", "[次]gemini-2.5-pro", "gemini-2.5-pro"],
      ["google", "gemini-3.1-pro-preview-r", "gemini-3.1-pro-preview"],
      ["xai", "[次]grok-4.7", "grok-4.7"],
      ["deepseek", "[SP]deepseek-v4-pro", "deepseek-v4-pro"],
      ["zai", "[次]glm-5.3", "glm-5.3"],
      ["nanogpt", "claude-opus-4-6:thinking", "claude-opus-4-6"],
      ["custom", "[free]deepseek-v4-pro-nothinking", "deepseek-v4-pro"],
    ];
    for (const [provider, id, expected] of cases) {
      assert.equal(findKnownModel(provider, id)?.id, expected, `${provider} ${id}`);
      assert.equal(shouldSuppressUnknownModelParameters(provider, id), false, `${provider} ${id}`);
    }
  });

  await test("real ids are not over-normalized", () => {
    assert.equal(findKnownModel("cohere", "command-r")?.id, "command-r");
    for (const id of ["claude-opus-4-6x", "claude-opus-4-6-thinking-extra", "[次]", "claude-opus-4-6-turbo"]) {
      assert.equal(findKnownModel("anthropic", id), undefined, id);
      assert.equal(shouldSuppressUnknownModelParameters("anthropic", id), true, id);
    }
    assert.equal(findKnownModel("custom", "claude-opus-5.50"), undefined);
    assert.equal(capabilityModelId(" Anthropic/Claude-Opus-4-6 "), "anthropic/claude-opus-4-6");
    assert.equal(capabilityModelId("[次][SP]claude-opus-4-6"), "claude-opus-4-6");
    for (const id of [
      "claude-opus-4-6-nothinking",
      "claude-opus-4-6-no-thinking",
      "claude-opus-4-6-non-thinking",
      "gemini-2.0-flash-thinking-exp",
      "claude-opus-4-6",
    ]) {
      assert.equal(impliesProxyThinking(id), false, id);
    }
    assert.equal(impliesProxyThinking("[次]claude-opus-4-6-thinking"), true);
  });

  await test("capability predicates read through the channel tag", () => {
    assert.equal(supportsXhighReasoningEffort("[次]claude-opus-4-7-thinking"), true);
    assert.equal(supportsXhighReasoningEffort("[次]claude-opus-4-6"), false);
    assert.equal(isClaudeOpus55Model("[SP]claude-opus-5-5-r"), true);
    assert.equal(isGeminiArgonModel("[次]gemini-4-argon"), true);
    assert.equal(isXaiConfigurableReasoningModel("[次]grok-4.7"), true);
    assert.equal(isZaiMaxReasoningEffortModel("[次]glm-5.3"), true);
    assert.equal(
      resolveProviderReasoningEffort({
        provider: "anthropic",
        model: "[次]claude-opus-4-7-thinking",
        reasoningEffort: "maximum",
      }),
      "max",
    );
    assert.equal(
      resolveProviderReasoningEffort({ provider: "google", model: "[次]gemini-4-argon", reasoningEffort: null }),
      "medium",
    );

    const thinking = relevantGenerationParameters({ provider: "anthropic", model: "[次]claude-opus-4-6-thinking" });
    assert.equal(thinking.has("reasoningEffort"), true);
    assert.equal(thinking.has("temperature"), false);
    const plain = relevantGenerationParameters({
      provider: "anthropic",
      model: "[SP]claude-opus-4-6",
      reasoningEffort: null,
    });
    assert.equal(plain.has("reasoningEffort"), true);
    assert.equal(plain.has("temperature"), true);
  });

  await test("Anthropic sends effort for a proxy id and keeps the configured id", async () => {
    const model = "[次]claude-opus-4-6-thinking";
    const base = {
      model,
      stream: false,
      maxTokens: 100_000,
      temperature: 0.7,
      topK: 32,
      captureReasoning: true,
    } as const;

    await anthropic.chatComplete([{ role: "user", content: "Hi" }], {
      ...base,
      enableThinking: true,
      reasoningEffort: "high",
    });
    let body = requests.at(-1)!;
    assert.equal(body.model, model);
    assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
    assert.equal(body.output_config.effort, "high");
    assert.equal(body.max_tokens, 32_000, "Opus 4.6 output limit applies");
    for (const sampler of ["temperature", "top_k", "top_p"]) assert.equal(sampler in body, false, sampler);

    // Effort off: the proxy still thinks, so sampling and forced tool choice stay out.
    await anthropic.chatComplete([{ role: "user", content: "Hi" }], {
      ...base,
      tools: [
        { type: "function", function: { name: "lookup", description: "Look up", parameters: { type: "object" } } },
      ],
      toolChoice: "required",
    });
    body = requests.at(-1)!;
    assert.equal(body.model, model);
    assert.equal(body.thinking, undefined);
    assert.deepEqual(body.tool_choice, { type: "auto" });
    for (const sampler of ["temperature", "top_k", "top_p"]) assert.equal(sampler in body, false, sampler);

    // A tagged id without a thinking suffix keeps its samplers when effort is off.
    await anthropic.chatComplete([{ role: "user", content: "Hi" }], { ...base, model: "[SP]claude-opus-4-6" });
    body = requests.at(-1)!;
    assert.equal(body.model, "[SP]claude-opus-4-6");
    assert.equal(body.temperature, 0.7);
  });
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
