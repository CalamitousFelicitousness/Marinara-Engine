// Parameter trace: which settings layer set each sampling parameter, and what the request carried.
// Pins: runtime provenance labels, request-body extraction per provider shape, capture through the
// fallback wrapper, agent trace labels from completeAgentCall, and retry trace merging.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";

import type { AgentContext, AgentParameterTrace } from "@marinara-engine/shared";
import {
  completeAgentCall,
  mergeRetriedAgentTraces,
} from "../../packages/server/src/services/agents/agent-progress.js";
import type { AgentExecConfig } from "../../packages/server/src/services/agents/agent-executor.js";
import {
  buildParameterTrace,
  extractSentParameters,
  storedParameterSources,
  type SentRequestParameters,
} from "../../packages/server/src/services/generation/generation-parameters.js";
import { resolveModelAccessPolicy } from "../../packages/server/src/services/generation/model-access-policy.js";
import { resolveGenerationProviderRuntime } from "../../packages/server/src/services/generation/provider-generation-runtime.js";
import type {
  BaseLLMProvider,
  ChatCompletionResult,
  ChatOptions,
} from "../../packages/server/src/services/llm/base-provider.js";
import { ConnectionFallbackProvider } from "../../packages/server/src/services/llm/connection-fallback-provider.js";
import { OpenAIProvider } from "../../packages/server/src/services/llm/providers/openai.provider.js";

// ── Runtime provenance ──

function resolveRuntime(args: {
  provider?: string;
  model?: string;
  chatMode?: string;
  presetParameters?: { topP?: number; temperature?: number };
  connectionParameters?: unknown;
  chatParameters?: unknown;
}) {
  const provider = args.provider ?? "openai";
  const model = args.model ?? "gpt-4o";
  return resolveGenerationProviderRuntime({
    connectionId: "conn-primary",
    connection: { provider, model, apiKey: "test-key", defaultParameters: args.connectionParameters },
    baseUrl: "http://127.0.0.1:9/v1",
    chatMode: args.chatMode ?? "roleplay",
    isSceneChat: false,
    chatParameters: args.chatParameters,
    managedParameterDefinitions: [],
    modelAccessPolicy: resolveModelAccessPolicy({ provider, model }),
    initialSources: args.presetParameters ? storedParameterSources(args.presetParameters, "preset") : undefined,
    initial: {
      temperature: args.presetParameters?.temperature ?? 1,
      maxTokens: 4096,
      topP: args.presetParameters?.topP ?? 1,
      topK: 0,
      minP: 0,
      frequencyPenalty: 0,
      presencePenalty: 0,
      showThoughts: true,
      reasoningEffort: null,
      verbosity: null,
      serviceTier: null,
      assistantPrefill: "",
      assistantReasoningPrefill: "",
      customThinkingTags: [],
      customParameters: {},
      enabledParameters: undefined,
      stopSequences: [],
      effectiveMaxContext: undefined,
    },
  });
}

{
  const presetOnly = resolveRuntime({ presetParameters: { topP: 0.95 } });
  assert.equal(presetOnly.topP, 0.95);
  assert.equal(presetOnly.parameterSources.topP, "preset");
  assert.equal(presetOnly.parameterSources.temperature, undefined, "unassigned keys stay defaults");

  // A connection default saved with top_p 1 silently replaces the preset's 0.95.
  const connectionWins = resolveRuntime({ presetParameters: { topP: 0.95 }, connectionParameters: { topP: 1 } });
  assert.equal(connectionWins.topP, 1);
  assert.equal(connectionWins.parameterSources.topP, "connection");

  const chatWins = resolveRuntime({
    presetParameters: { topP: 0.95 },
    connectionParameters: JSON.stringify({ topP: 1 }),
    chatParameters: { topP: 0.9 },
  });
  assert.equal(chatWins.topP, 0.9);
  assert.equal(chatWins.parameterSources.topP, "chat");

  const game = resolveRuntime({ chatMode: "game", chatParameters: { topP: 0.9 } });
  assert.equal(game.topP, 1);
  assert.equal(game.parameterSources.topP, "game mode");
  assert.equal(game.parameterSources.temperature, "game mode");

  const gemma = resolveRuntime({
    provider: "custom",
    model: "gemma-3-27b",
    chatMode: "game",
    chatParameters: { topP: 0.9 },
  });
  assert.equal(gemma.topP, 0.9);
  assert.equal(gemma.parameterSources.topP, "chat");
  assert.equal(gemma.parameterSources.maxTokens, "game mode");

  const claude = resolveRuntime({ provider: "anthropic", model: "claude-opus-4-6", chatParameters: { topP: 0.9 } });
  assert.equal(claude.topP, undefined);
  assert.equal(claude.parameterSources.topP, "model rule");

  const switchOff = resolveRuntime({
    connectionParameters: { enabledParameters: { topP: true, temperature: true } },
    chatParameters: { enabledParameters: { topP: false } },
  });
  assert.equal(switchOff.sendSwitchSources.topP, "chat");
  assert.equal(switchOff.sendSwitchSources.temperature, "connection");
  const trace = buildParameterTrace({
    values: { topP: switchOff.topP, temperature: switchOff.temperature },
    sources: switchOff.parameterSources,
    enabledParameters: switchOff.enabledParameters,
    sendSwitchSources: switchOff.sendSwitchSources,
    customParameters: { top_p: 0.5, generationConfig: { seed: 7, stopSequences: ["x"] }, dropped: undefined },
    sent: null,
  });
  const topPEntry = trace.entries.find((entry) => entry.key === "topP");
  assert.deepEqual(topPEntry?.sendSwitch, { enabled: false, setBy: "chat" });
  assert.equal(topPEntry?.sent, null);
  assert.equal(trace.observable, false);
  assert.deepEqual(
    trace.customParameterPaths,
    ["top_p", "generationConfig.seed", "generationConfig.stopSequences"],
    "nested Custom Parameters report leaf paths, so one Gemini field does not claim every generationConfig sampler",
  );
  assert.equal(
    trace.entries.find((entry) => entry.key === "minP"),
    undefined,
    "unlisted keys without a sent value are omitted",
  );
}

// ── Request-body extraction ──

{
  const openAiChat = extractSentParameters({
    model: "gpt-4o",
    messages: [],
    temperature: 0.8,
    top_p: 0.95,
    max_completion_tokens: 512,
    reasoning_effort: "low",
    verbosity: "low",
  });
  assert.deepEqual(openAiChat.parameters.topP, { path: "top_p", value: 0.95 });
  assert.deepEqual(openAiChat.parameters.maxTokens, { path: "max_completion_tokens", value: 512 });
  assert.equal(openAiChat.parameters.minP, undefined);
  assert.equal(openAiChat.fallback, null);

  const responses = extractSentParameters({
    max_output_tokens: 1024,
    reasoning: { effort: "high" },
    text: { verbosity: "medium" },
  });
  assert.deepEqual(responses.parameters.reasoningEffort, { path: "reasoning.effort", value: "high" });
  assert.deepEqual(responses.parameters.verbosity, { path: "text.verbosity", value: "medium" });

  const anthropicAdaptive = extractSentParameters({
    max_tokens: 2048,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
  });
  assert.deepEqual(anthropicAdaptive.parameters.reasoningEffort, { path: "output_config.effort", value: "high" });
  assert.equal(anthropicAdaptive.parameters.temperature, undefined);

  const gemini25 = extractSentParameters({
    generationConfig: {
      maxOutputTokens: 4096,
      temperature: 1,
      topP: 0.95,
      topK: 40,
      thinkingConfig: { thinkingBudget: 1024 },
    },
  });
  assert.deepEqual(gemini25.parameters.topK, { path: "generationConfig.topK", value: 40 });
  assert.deepEqual(gemini25.parameters.reasoningEffort, {
    path: "generationConfig.thinkingConfig",
    value: { thinkingBudget: 1024 },
  });

  const gemini3 = extractSentParameters(
    { generationConfig: { topP: 1, thinkingConfig: { thinkingLevel: "high" } } },
    { fallback: { provider: "google", model: "gemini-3-pro" } },
  );
  assert.deepEqual(gemini3.parameters.topP, { path: "generationConfig.topP", value: 1 });
  assert.deepEqual(gemini3.fallback, { provider: "google", model: "gemini-3-pro" });
}

// ── Wire capture, direct and through the fallback wrapper ──

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function collectOutput(provider: BaseLLMProvider, options: ChatOptions): Promise<string> {
  let output = "";
  for await (const chunk of provider.chat([{ role: "user", content: "test" }], options)) output += chunk;
  return output;
}

const received: Array<{ url: string; body: Record<string, unknown> }> = [];
const server = createServer(async (request, response) => {
  const body = await readJsonBody(request);
  received.push({ url: request.url ?? "", body });
  if (request.url?.startsWith("/primary")) {
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "primary rejected" } }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const direct: SentRequestParameters[] = [];
  await collectOutput(new OpenAIProvider(`${base}/direct/v1`, "test-key"), {
    model: "gpt-4o",
    stream: false,
    temperature: 0.7,
    topP: 0.95,
    maxTokens: 300,
    onRequestBody: (body, meta) => {
      direct.push(extractSentParameters(body, meta));
    },
  });
  assert.equal(direct.length, 1);
  assert.deepEqual(direct[0], extractSentParameters(received.at(-1)!.body));
  assert.equal(direct[0]!.parameters.topP?.value, 0.95);

  const fallbackConnection = {
    id: "conn-fallback",
    provider: "openai",
    baseUrl: `${base}/fallback/v1`,
    apiKey: "test-key",
    model: "gpt-4o-mini",
    defaultParameters: JSON.stringify({ topP: 0.5 }),
  };
  const withFallback = new ConnectionFallbackProvider(
    new OpenAIProvider(`${base}/primary/v1`, "test-key"),
    new OpenAIProvider(`${base}/fallback/v1`, "test-key"),
    fallbackConnection,
    "main",
    async () => undefined,
  );
  const chain: SentRequestParameters[] = [];
  await collectOutput(withFallback, {
    model: "gpt-4o",
    stream: false,
    topP: 0.95,
    onRequestBody: (body, meta) => {
      chain.push(extractSentParameters(body, meta));
    },
  });
  assert.equal(chain.length, 2, "primary and fallback each report their request");
  assert.equal(chain[0]!.fallback, null);
  assert.deepEqual(chain[1]!.fallback, { provider: "openai", model: "gpt-4o-mini" });
  assert.equal(chain[1]!.parameters.topP?.value, 0.5, "the fallback's stored top_p replaces the resolved one");
  assert.ok(received.at(-1)!.url.startsWith("/fallback"));
  assert.deepEqual(chain[1]!.parameters, extractSentParameters(received.at(-1)!.body).parameters);
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

// ── Agent traces ──

function agentConfig(overrides: Partial<AgentExecConfig>): AgentExecConfig {
  return {
    id: "agent-1",
    type: "prose-guardian",
    name: "Prose Guardian",
    phase: "post_processing",
    promptTemplate: "",
    connectionId: null,
    settings: {},
    isCustomAgent: false,
    ...overrides,
  };
}

function stubProvider(outcome: "complete" | "throw"): BaseLLMProvider {
  return {
    maxTokensOverrideValue: null,
    async chatComplete(_messages: unknown, options: ChatOptions): Promise<ChatCompletionResult> {
      options.onRequestBody?.({
        model: options.model,
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        top_p: 1,
      });
      if (outcome === "throw") throw new Error("provider failed");
      return { content: "{}", toolCalls: [], finishReason: "stop" } as unknown as ChatCompletionResult;
    },
  } as unknown as BaseLLMProvider;
}

function entry(trace: AgentParameterTrace | undefined, key: string) {
  return trace?.trace.entries.find((candidate) => candidate.key === key);
}

{
  const traces: AgentParameterTrace[] = [];
  const callerBodies: unknown[] = [];
  const context = {
    agentTrace: (trace: AgentParameterTrace) => {
      traces.push(trace);
    },
  } as unknown as AgentContext;

  await completeAgentCall(
    context,
    [
      agentConfig({
        connectionId: "conn-agents",
        temperature: 0.4,
        settings: { maxTokens: 2000 },
        enabledParameters: { temperature: true },
      }),
    ],
    stubProvider("complete"),
    [],
    {
      model: "agent-model",
      temperature: 0.4,
      maxTokens: 2000,
      enabledParameters: { temperature: true },
      onRequestBody: (body) => {
        callerBodies.push(body);
      },
    },
  );
  assert.equal(callerBodies.length, 1, "the caller's own body callback still runs");
  assert.equal(traces[0]?.connectionId, "conn-agents");
  assert.equal(traces[0]?.phase, "post_processing");
  assert.equal(entry(traces[0], "temperature")?.setBy, "connection");
  assert.deepEqual(entry(traces[0], "temperature")?.sendSwitch, { enabled: true, setBy: "connection" });
  assert.equal(entry(traces[0], "maxTokens")?.setBy, "agent settings");
  assert.deepEqual(entry(traces[0], "topP")?.sent, { path: "top_p", value: 1 }, "provider-added samplers still appear");
  assert.equal(entry(traces[0], "topP")?.value, null);

  const withProgress = { ...context, agentProgress: () => undefined } as AgentContext;
  await completeAgentCall(withProgress, [agentConfig({ type: "beholder" })], stubProvider("complete"), [], {
    model: "agent-model",
    temperature: 0,
    maxTokens: 4096,
  });
  assert.equal(entry(traces[1], "temperature")?.setBy, "agent rule");
  assert.equal(entry(traces[1], "maxTokens")?.setBy, "default");

  await completeAgentCall(
    context,
    [agentConfig({ temperature: 0.9, settings: { maxTokens: 8000 } })],
    stubProvider("complete"),
    [],
    {
      model: "agent-model",
      temperature: 0.9,
      maxTokens: 4096,
    },
  );
  assert.equal(entry(traces[2], "temperature")?.setBy, "chat");
  assert.equal(entry(traces[2], "maxTokens")?.setBy, "agent rule", "a capped budget is not the configured one");
  assert.equal(traces[2]?.connectionId, null);

  await completeAgentCall(
    context,
    [agentConfig({ id: "agent-2", name: "World State" }), agentConfig({ id: "agent-3", name: "Expressions" })],
    stubProvider("complete"),
    [],
    { model: "agent-model", maxTokens: 3000, reasoningEffort: "none", enabledParameters: { reasoningEffort: true } },
  );
  assert.equal(traces[3]?.phase, "batch");
  assert.deepEqual(
    traces[3]?.agents.map((agent) => agent.id),
    ["agent-2", "agent-3"],
  );
  assert.equal(entry(traces[3], "maxTokens")?.setBy, "agent rule");
  assert.equal(entry(traces[3], "reasoningEffort")?.setBy, "agent rule");
  assert.deepEqual(entry(traces[3], "reasoningEffort")?.sendSwitch, { enabled: true, setBy: "agent rule" });

  await assert.rejects(
    completeAgentCall(context, [agentConfig({ id: "agent-4" })], stubProvider("throw"), [], { model: "agent-model" }),
    /provider failed/,
  );
  assert.deepEqual(
    traces[4]?.agents.map((agent) => agent.id),
    ["agent-4"],
    "a failed call still reports what it sent",
  );

  const merged = mergeRetriedAgentTraces(
    [traces[0], traces[3]],
    [traces[4]!, { ...traces[0]!, agents: [{ id: "agent-3", type: "t", name: "n" }] }],
  );
  assert.equal(merged.length, 3, "the batch containing a re-run agent is replaced, the rest kept");
  assert.equal(merged[0], traces[0]);
  assert.deepEqual(mergeRetriedAgentTraces("not an array", [traces[4]!]), [traces[4]]);
}

console.log("parameter-trace regression passed.");
