import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Agent and package calls send the generation parameters saved on their connection, resolved like the main chat's
// (#7131). Every provider points at a local stub that records the exact request bodies and headers.
const dir = mkdtempSync(join(tmpdir(), "marinara-agent-params-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.CODEX_HOME = dir;
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
process.env.LOG_FILE_LEVEL = "silent";
writeFileSync(
  join(dir, "auth.json"),
  JSON.stringify({
    auth_mode: "chatgpt",
    last_refresh: new Date().toISOString(),
    tokens: { access_token: `test.${Buffer.from(JSON.stringify({ exp: 9_999_999_999 })).toString("base64url")}.sig` },
  }),
);

type Captured = { path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, any> };
const requests: Captured[] = [];
let reply = '{"weather":"rain"}';

const sse = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const path = request.url ?? "";
  requests.push({ path, headers: request.headers, body });
  const content = reply;
  const streaming = body.stream === true || path.includes("alt=sse") || path.endsWith("/responses");
  response.writeHead(200, { "content-type": streaming ? "text/event-stream" : "application/json" });
  if (path.endsWith("/messages")) {
    response.end(
      streaming
        ? [
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 1 } } })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content } })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
          ].join("")
        : JSON.stringify({
            id: "msg",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: content }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
    );
  } else if (path.includes("generateContent")) {
    const candidate = {
      candidates: [{ content: { role: "model", parts: [{ text: content }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    };
    response.end(streaming ? sse([candidate]) : JSON.stringify(candidate));
  } else if (path.endsWith("/responses")) {
    response.end(
      sse([
        { type: "response.output_text.delta", delta: content },
        { type: "response.completed", response: { status: "completed", output: [] } },
      ]),
    );
  } else {
    response.end(
      streaming
        ? `${sse([
            { choices: [{ index: 0, delta: { content }, finish_reason: null }] },
            { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ])}data: [DONE]\n\n`
        : JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
    );
  }
});

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createAgentsStorage } = await import("../../packages/server/src/services/storage/agents.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createAppSettingsStorage } = await import("../../packages/server/src/services/storage/app-settings.storage.js");
const { createCapabilityLanguageModelHost } =
  await import("../../packages/server/src/services/capability-packages/capability-language-model.service.js");
const { executeAgent, executeAgentBatch } = await import("../../packages/server/src/services/agents/agent-executor.js");
const { resolveAgentPipelineAgents } =
  await import("../../packages/server/src/services/generation/agent-resolution.js");
const { OpenAIProvider } = await import("../../packages/server/src/services/llm/providers/openai.provider.js");
const retryRoute = await import("../../packages/server/src/routes/generate/retry-agents-route.js");
const { CUSTOM_GENERATION_PARAMETERS_SETTINGS_KEY } = await import("../../packages/shared/dist/index.js");
type AgentContext = import("../../packages/shared/src/types/agent.js").AgentContext;
type ResolvedAgent = import("../../packages/server/src/services/agents/agent-pipeline.js").ResolvedAgent;
type PipelineArgs = Parameters<typeof resolveAgentPipelineAgents>[0];

const managedParameterDefinitions = [{ id: "top-a", name: "Top A", requestKey: "top_a", min: 0, max: 1 }];
const ALL_SWITCHES_ON = {
  temperature: true,
  maxTokens: true,
  topP: true,
  topK: true,
  frequencyPenalty: true,
  presencePenalty: true,
  reasoningEffort: true,
  verbosity: true,
};
/** A connection with "Use custom defaults" on and every sampler deliberately tuned. */
const tuned = (overrides: Record<string, unknown> = {}) => ({
  temperature: 0.3,
  topP: 0.8,
  topK: 40,
  minP: 0.05,
  frequencyPenalty: 0.4,
  presencePenalty: 0.2,
  reasoningEffort: "high",
  maxTokens: 8192,
  stopSequences: ["\n\nUser:"],
  assistantPrefill: "Sure",
  customParameters: { fixture_param: "yes" },
  customHeaders: { "X-Fixture": "agent" },
  managedCustomParameters: { "top-a": { enabled: true, value: 0.25 } },
  enabledParameters: ALL_SWITCHES_ON,
  ...overrides,
});
const withoutReasoning = (overrides: Record<string, unknown> = {}) => {
  const { reasoningEffort: _unset, ...rest } = tuned(overrides);
  return rest;
};

const context: AgentContext = {
  chatId: "agent-connection-parameters",
  chatMode: "roleplay",
  recentMessages: [],
  characters: [],
  persona: null,
  memory: {},
  writableLorebookIds: null,
  chatSummary: null,
  streaming: false,
};

const agentConfig = (type: string, resultType: string, connectionId: string | null = "agent-connection") => ({
  id: type,
  type,
  name: type,
  phase: "post_processing",
  promptTemplate: `${type} AGENT_FIXTURE prompt`,
  connectionId,
  settings: { resultType, contextSize: 2, maxTokens: 1000 },
  enabled: "true",
});

let base = "";
const resolveAgents = async (args: {
  provider: string;
  model: string;
  defaultParameters: unknown;
  agents: Array<ReturnType<typeof agentConfig>>;
  chat?: Partial<PipelineArgs>;
}) => {
  const connection = {
    id: "agent-connection",
    name: `${args.provider} fixture`,
    provider: args.provider,
    baseUrl: args.provider === "google" ? `${base}/v1beta` : `${base}/v1`,
    apiKey: "fixture-key",
    model: args.model,
    maxContext: 200_000,
    defaultParameters: JSON.stringify(args.defaultParameters),
    maxParallelJobs: 1,
  };
  const { resolvedAgents } = await resolveAgentPipelineAgents({
    connections: {
      getDefaultForAgents: async () => null,
      getFallbackForAgents: async () => null,
      getWithKey: async (id: string) => (id === connection.id ? connection : null),
    },
    configuredAgents: args.agents,
    chatId: "agent-connection-parameters",
    chatEnableAgents: true,
    hasPerChatAgentList: false,
    perChatAgentSet: new Set<string>(),
    agentPromptTemplateSelections: {},
    chatProvider: new OpenAIProvider(`${base}/v1`, "chat-key"),
    chatConnectionId: "chat-connection",
    chatModel: "chat-model",
    chatCustomParameters: {},
    chatSuppressModelParameters: false,
    chatMaxOutputTokens: null,
    chatMaxParallelJobs: 1,
    chatEnableCaching: false,
    chatAnthropicExtendedCacheTtl: false,
    chatCachingAtDepth: 5,
    managedParameterDefinitions,
    resolveBaseUrl: (conn) => conn.baseUrl ?? "",
    ...args.chat,
  } as PipelineArgs);
  return resolvedAgents;
};
const run = async (agent: ResolvedAgent) => {
  const before = requests.length;
  const result = await executeAgent(agent, context, agent.provider, agent.model);
  assert.equal(result.success, true, `${agent.type} should succeed: ${result.error}`);
  assert.equal(requests.length, before + 1, `${agent.type} makes one request`);
  return requests.at(-1)!;
};

let db: Awaited<ReturnType<typeof getDB>> | null = null;
try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // ── OpenAI-compatible (custom endpoint): JSON and text agents send the tuned connection ─────────────────────────
  {
    const [jsonAgent, textAgent] = await resolveAgents({
      provider: "custom",
      model: "fixture-model",
      defaultParameters: tuned(),
      agents: [agentConfig("json-fixture", "game_state_update"), agentConfig("text-fixture", "context_injection")],
    });
    for (const agent of [jsonAgent!, textAgent!]) {
      const { body, headers } = await run(agent);
      assert.equal(body.temperature, 0.3, `${agent.type}: connection temperature`);
      assert.equal(body.top_p, 0.8, `${agent.type}: Top P`);
      assert.equal(body.top_k, 40, `${agent.type}: Top K`);
      assert.equal(body.min_p, 0.05, `${agent.type}: Min P`);
      assert.equal(body.frequency_penalty, 0.4, `${agent.type}: frequency penalty`);
      assert.equal(body.presence_penalty, 0.2, `${agent.type}: presence penalty`);
      assert.equal(body.top_a, 0.25, `${agent.type}: managed custom parameter (Top A)`);
      assert.equal(body.fixture_param, "yes", `${agent.type}: connection custom parameter`);
      assert.equal(headers["x-fixture"], "agent", `${agent.type}: connection custom header`);
      // A generic endpoint only takes a level for models it knows reason, exactly like the main chat. What matters
      // here is that the JSON agent no longer forces "none" over the level the user chose.
      assert.equal("reasoning_effort" in body, false, `${agent.type}: no forced none over the user's level`);
      assert.equal(body.max_tokens, 1000 + 2000, `${agent.type}: its own 1000 tokens plus thinking room`);
      assert.equal("stop" in body, false, `${agent.type}: roleplay stop sequences never reach agents`);
    }
  }

  // ── OpenAI reasoning model: the level is sent and the completion budget leaves room for it ─────────────────────
  {
    const [jsonAgent, textAgent] = await resolveAgents({
      provider: "openai",
      model: "o4-mini",
      defaultParameters: tuned(),
      agents: [agentConfig("openai-json", "game_state_update"), agentConfig("openai-text", "context_injection")],
    });
    for (const agent of [jsonAgent!, textAgent!]) {
      const { body } = await run(agent);
      assert.equal(body.reasoning_effort, "high", `${agent.type}: the user's reasoning level wins`);
      assert.equal(body.max_completion_tokens, 3000, `${agent.type}: reasoning counts inside the completion budget`);
    }
  }

  // ── Default/unset reasoning keeps today's behaviour: JSON agents ask for none, text agents send nothing ─────────
  {
    const [jsonAgent, textAgent] = await resolveAgents({
      provider: "custom",
      model: "fixture-model",
      defaultParameters: withoutReasoning(),
      agents: [agentConfig("json-unset", "game_state_update"), agentConfig("text-unset", "context_injection")],
    });
    const jsonBody = (await run(jsonAgent!)).body;
    assert.equal(jsonBody.reasoning_effort, "none", "JSON agents still turn reasoning off when no level is saved");
    assert.equal(jsonBody.max_tokens, 1000, "no thinking room without a level");
    assert.equal(jsonBody.top_p, 0.8, "the other saved samplers still apply");
    const textBody = (await run(textAgent!)).body;
    assert.equal("reasoning_effort" in textBody, false, "text agents leave reasoning to the provider when unset");
    assert.equal(textBody.max_tokens, 1000);
  }

  // ── Send switches off: nothing behind a switched-off parameter is sent ───────────────────────────────────────────
  {
    const [jsonAgent] = await resolveAgents({
      provider: "custom",
      model: "fixture-model",
      defaultParameters: tuned({
        enabledParameters: {
          temperature: false,
          maxTokens: true,
          topP: false,
          topK: false,
          frequencyPenalty: false,
          presencePenalty: false,
          reasoningEffort: false,
          verbosity: false,
        },
      }),
      agents: [agentConfig("json-switches-off", "game_state_update")],
    });
    const { body } = await run(jsonAgent!);
    for (const field of [
      "temperature",
      "top_p",
      "top_k",
      "frequency_penalty",
      "presence_penalty",
      "reasoning_effort",
    ]) {
      assert.equal(field in body, false, `switched-off ${field} is not sent`);
    }
    assert.equal(body.max_tokens, 1000, "no thinking room when reasoning is switched off");
  }

  // ── OpenRouter: unified reasoning object, Top K never sent ──────────────────────────────────────────────────────
  {
    const [agent] = await resolveAgents({
      provider: "openrouter",
      model: "deepseek/deepseek-r1",
      defaultParameters: tuned({ serviceTier: "flex" }),
      agents: [agentConfig("openrouter-json", "game_state_update")],
    });
    const { body } = await run(agent!);
    assert.deepEqual(body.reasoning?.effort, "high", "OpenRouter gets the user's level");
    assert.equal(body.top_p, 0.8);
    assert.equal(body.frequency_penalty, 0.4);
    assert.equal("top_k" in body, false, "OpenRouter never takes Top K");
    // The provider only sends a tier to openrouter.ai itself, which a local stub cannot be.
    assert.equal(agent!.generation?.serviceTier, "flex", "the saved OpenRouter service tier reaches the agent call");
    assert.equal(body.max_tokens ?? body.max_completion_tokens, 3000, "thinking room on top of the agent's budget");
  }

  // ── Anthropic: thinking turns on with a valid budget below max_tokens; sampling that thinking rejects is dropped ─
  {
    const [legacy] = await resolveAgents({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      defaultParameters: tuned(),
      agents: [agentConfig("anthropic-legacy", "game_state_update")],
    });
    const { body } = await run(legacy!);
    assert.equal(body.thinking?.type, "enabled", "the saved level turns Claude thinking on");
    assert.ok(body.thinking.budget_tokens >= 1024 && body.thinking.budget_tokens < body.max_tokens);
    assert.equal(body.max_tokens, 1000 + body.thinking.budget_tokens, "the answer keeps its own 1000 tokens");
    assert.equal("temperature" in body, false, "thinking rejects temperature");
    assert.equal("top_k" in body, false, "thinking rejects top_k");

    const [adaptive] = await resolveAgents({
      provider: "anthropic",
      model: "claude-opus-4-6",
      defaultParameters: tuned(),
      agents: [agentConfig("anthropic-adaptive", "game_state_update")],
    });
    const adaptiveBody = (await run(adaptive!)).body;
    assert.equal(adaptiveBody.thinking?.type, "adaptive");
    assert.equal(adaptiveBody.output_config?.effort, "high");
    assert.equal(adaptiveBody.max_tokens, 1000 + 2000, "adaptive headroom is added once, by the provider");

    const [unset] = await resolveAgents({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      defaultParameters: withoutReasoning(),
      agents: [agentConfig("anthropic-unset", "game_state_update")],
    });
    const unsetBody = (await run(unset!)).body;
    assert.equal("thinking" in unsetBody, false, "no thinking without a saved level");
    assert.equal(unsetBody.top_k, 40, "Top K still applies when Claude is not thinking");
    assert.equal(unsetBody.max_tokens, 1000);
  }

  // ── Gemini 3: thinking level plus room for it inside maxOutputTokens ────────────────────────────────────────────
  {
    const [agent] = await resolveAgents({
      provider: "google",
      model: "gemini-3-pro-preview",
      defaultParameters: tuned(),
      agents: [agentConfig("gemini-json", "game_state_update")],
    });
    const { body } = await run(agent!);
    const config = body.generationConfig ?? {};
    assert.equal(config.thinkingConfig?.thinkingLevel, "high");
    assert.equal(config.maxOutputTokens, 3000, "Gemini 3 counts thinking inside maxOutputTokens");
    assert.equal(config.topP, 0.8);
    assert.equal(config.topK, 40);
    assert.equal(config.temperature, 0.3);
  }

  // ── Agents on the chat's own connection (Codex): the chat connection's saved level is sent ──────────────────────
  {
    const codex = new OpenAIProvider(base, "codex-token", undefined, null, null, "openai-chatgpt");
    const codexAgents = (defaultParameters: unknown) =>
      resolveAgents({
        provider: "custom",
        model: "unused",
        defaultParameters: {},
        agents: [agentConfig("codex-json", "game_state_update", null)],
        chat: {
          chatProvider: codex,
          chatModel: "gpt-5.5",
          chatConnectionProvider: "openai_chatgpt",
          chatDefaultParameters: defaultParameters,
        } as Partial<PipelineArgs>,
      });
    const [chosen] = await codexAgents({ reasoningEffort: "medium" });
    assert.deepEqual(
      (await run(chosen!)).body.reasoning,
      { effort: "medium" },
      "Codex takes the chat connection level",
    );
    const [codexDefault] = await codexAgents({ reasoningEffort: null });
    assert.equal("reasoning" in (await run(codexDefault!)).body, false, "Codex Default keeps the model's own level");
  }

  // ── Batches: only agents with identical effective parameters share a request ──────────────────────────────────
  {
    reply = JSON.stringify({ "batch-a": { weather: "rain" }, "batch-b": { weather: "sun" } });
    const batchAgents = (reasoningEffort: string, types: string[]) =>
      resolveAgents({
        provider: "openai",
        model: "o4-mini",
        defaultParameters: tuned({ reasoningEffort }),
        agents: types.map((type) => agentConfig(type, "game_state_update")),
      });
    const [a, b] = await batchAgents("high", ["batch-a", "batch-b"]);
    let before = requests.length;
    await executeAgentBatch([a!, b!], context, a!.provider, a!.model);
    assert.equal(requests.length, before + 1, "matching parameters share one request");
    const shared = requests.at(-1)!.body;
    assert.equal(shared.reasoning_effort, "high", "the batch keeps the user's level instead of forcing none");
    assert.equal(shared.max_completion_tokens, 2000 + 4000, "both budgets plus thinking room");

    const [other] = await batchAgents("low", ["batch-b"]);
    before = requests.length;
    await executeAgentBatch([a!, other!], context, a!.provider, a!.model);
    assert.equal(requests.length, before + 2, "different saved parameters split the batch");
    assert.deepEqual(
      requests.slice(before).map((entry) => entry.body.reasoning_effort),
      ["high", "low"],
      "each split request keeps its own parameters",
    );
    reply = '{"weather":"rain"}';
  }

  // ── Retry route: retried agents resolve their connection the same way ─────────────────────────────────────────
  {
    assert.equal(typeof retryRoute.resolveRetryAgents, "function", "the retry resolver is reachable");
    const stored = {
      id: "retry-connection",
      name: "Retry fixture",
      provider: "custom",
      baseUrl: `${base}/v1`,
      apiKey: "fixture-key",
      model: "fixture-model",
      maxContext: 200_000,
      defaultParameters: JSON.stringify(tuned()),
      maxParallelJobs: 1,
    };
    const resolveRetry = (connectionId: string | null) =>
      retryRoute.resolveRetryAgents({
        agentTypes: ["retry-fixture"],
        chat: {
          mode: "roleplay",
          connectionId: "retry-connection",
          metadata: JSON.stringify({ enableAgents: true, activeAgentIds: ["retry-fixture"] }),
        },
        conns: {
          getDefaultForAgents: async () => null,
          getFallbackForAgents: async () => null,
          getWithKey: async (id: string) => (id === stored.id ? stored : null),
          listRandomPool: async () => [],
        } as any,
        agentsStore: { list: async () => [agentConfig("retry-fixture", "game_state_update", connectionId)] } as any,
        allowExternalAgentImports: true,
        managedParameterDefinitions,
      });
    for (const connectionId of ["retry-connection", null]) {
      const { resolvedAgents } = await resolveRetry(connectionId);
      assert.equal(resolvedAgents.length, 1);
      const { body } = await run(resolvedAgents[0]!.resolved as ResolvedAgent);
      const label = connectionId ? "explicit connection" : "chat connection";
      assert.equal("reasoning_effort" in body, false, `retry (${label}) does not force none over the user's level`);
      assert.equal(body.top_p, 0.8, `retry (${label}) sends Top P`);
      assert.equal(body.top_a, 0.25, `retry (${label}) sends managed parameters`);
      assert.equal(body.max_tokens, 3000, `retry (${label}) leaves thinking room`);
    }
  }

  db = await getDB();
  const connections = createConnectionsStorage(db);
  await createAppSettingsStorage(db).set(
    CUSTOM_GENERATION_PARAMETERS_SETTINGS_KEY,
    JSON.stringify(managedParameterDefinitions),
  );

  // ── Capability host: headers, custom/managed parameters and the precedence rule ────────────────────────────────
  {
    const host = createCapabilityLanguageModelHost(db);
    const tunedConnection = await connections.create({
      name: "Package tuned",
      provider: "custom",
      baseUrl: `${base}/v1`,
      model: "fixture-model",
      apiKey: "fixture",
    });
    await connections.updateDefaultParameters(tunedConnection.id, tuned());
    const packageRequest = { temperature: 0.2, maxTokens: 1000, reasoningEffort: "none" as const };
    const tunedModel = await host.resolve(tunedConnection.id);
    await tunedModel.chatComplete([{ role: "user", content: "package" }], packageRequest);
    const tunedCall = requests.at(-1)!;
    assert.equal(tunedCall.headers["x-fixture"], "agent", "package calls carry the connection's custom headers");
    assert.equal(tunedCall.body.fixture_param, "yes", "package calls carry the connection's custom parameters");
    assert.equal(tunedCall.body.top_a, 0.25, "package calls carry managed custom parameters");
    assert.equal(tunedCall.body.temperature, 0.3, "a saved, switched-on temperature wins over the package's");
    assert.equal(tunedCall.body.top_p, 0.8);
    // The saved level replaced the package's none; this endpoint's model takes no level, as in the main chat.
    assert.equal("reasoning_effort" in tunedCall.body, false, "the user's saved level wins over the package's none");
    assert.equal(tunedCall.body.max_tokens, 3000, "the raised level gets thinking room");

    const reasoningConnection = await connections.create({
      name: "Package reasoning",
      provider: "openai",
      baseUrl: `${base}/v1`,
      model: "o4-mini",
      apiKey: "fixture",
    });
    await connections.updateDefaultParameters(reasoningConnection.id, tuned());
    const reasoningModel = await host.resolve(reasoningConnection.id);
    await reasoningModel.chatComplete([{ role: "user", content: "package" }], {
      maxTokens: 1000,
      reasoningEffort: "low",
    });
    const reasoningBody = requests.at(-1)!.body;
    assert.equal(reasoningBody.reasoning_effort, "high", "the user's saved level wins over the package's low");
    assert.equal(reasoningBody.max_completion_tokens, 3000, "the raised level gets thinking room");

    const plainConnection = await connections.create({
      name: "Package plain",
      provider: "custom",
      baseUrl: `${base}/v1`,
      model: "fixture-model",
      apiKey: "fixture",
    });
    const plainModel = await host.resolve(plainConnection.id);
    await plainModel.chatComplete([{ role: "user", content: "package" }], packageRequest);
    const plainBody = requests.at(-1)!.body;
    assert.equal(plainBody.temperature, 0.2, "with nothing saved the package's temperature stands");
    assert.equal(plainBody.reasoning_effort, "none", "with nothing saved the package's explicit none stands");
    assert.equal(plainBody.max_tokens, 1000);

    const switchedOffConnection = await connections.create({
      name: "Package defaults",
      provider: "custom",
      baseUrl: `${base}/v1`,
      model: "fixture-model",
      apiKey: "fixture",
    });
    await connections.updateDefaultParameters(
      switchedOffConnection.id,
      withoutReasoning({
        enabledParameters: { ...ALL_SWITCHES_ON, temperature: false, topP: false },
      }),
    );
    const switchedOffModel = await host.resolve(switchedOffConnection.id);
    await switchedOffModel.chatComplete([{ role: "user", content: "package" }], {
      temperature: 0.2,
      maxTokens: 1000,
      reasoningEffort: "low",
    });
    const switchedOffBody = requests.at(-1)!.body;
    assert.equal(switchedOffBody.temperature, 0.2, "a switched-off connection temperature leaves the package's");
    assert.equal("top_p" in switchedOffBody, false, "a switched-off Top P is not sent");
    assert.equal(switchedOffBody.max_tokens, 1000);

    const unsetReasoningConnection = await connections.create({
      name: "Package unset reasoning",
      provider: "openai",
      baseUrl: `${base}/v1`,
      model: "o4-mini",
      apiKey: "fixture",
    });
    await connections.updateDefaultParameters(unsetReasoningConnection.id, withoutReasoning());
    const unsetReasoningModel = await host.resolve(unsetReasoningConnection.id);
    await unsetReasoningModel.chatComplete([{ role: "user", content: "package" }], {
      maxTokens: 1000,
      reasoningEffort: "low",
    });
    const unsetReasoningBody = requests.at(-1)!.body;
    assert.equal(unsetReasoningBody.reasoning_effort, "low", "with no saved level the package's own level stands");
    assert.equal(unsetReasoningBody.max_completion_tokens, 1000, "and its own budget is left alone");
  }

  // ── Main route: an agent on the chat's connection sends what the main chat sends for that connection ───────────
  {
    const chats = createChatsStorage(db);
    const agents = createAgentsStorage(db);
    const app = Fastify();
    app.decorate("db", db);
    await app.register(generateRoutes, { prefix: "/api/generate" });
    try {
      const chatConnection = await connections.create({
        name: "Chat connection",
        provider: "openrouter",
        baseUrl: `${base}/v1`,
        model: "deepseek/deepseek-r1",
        apiKey: "fixture",
      });
      await connections.updateDefaultParameters(chatConnection.id, tuned());
      const agent = await agents.create({
        type: "chat-connection-fixture",
        name: "Chat connection fixture",
        phase: "pre_generation",
        connectionId: null,
        promptTemplate: "AGENT_FIXTURE chat connection",
        settings: { resultType: "context_injection", maxTokens: 1000 },
      });
      assert.ok(agent);
      const chat = await chats.create({
        name: "Agent parameters",
        mode: "roleplay",
        characterIds: [],
        connectionId: chatConnection.id,
        promptPresetId: null,
      });
      assert.ok(chat);
      await chats.patchMetadata(chat.id, { enableAgents: true, activeAgentIds: [agent.type] });
      await chats.createMessage({ chatId: chat.id, role: "user", content: "Begin." });
      reply = "Agent context.";
      const before = requests.length;
      const response = await app.inject({ method: "POST", url: "/api/generate/", payload: { chatId: chat.id } });
      assert.equal(response.statusCode, 200, response.body);
      const turn = requests.slice(before);
      const isAgent = (entry: Captured) => JSON.stringify(entry.body.messages ?? []).includes("AGENT_FIXTURE");
      const agentBody = turn.find(isAgent)?.body;
      const mainBody = turn.find((entry) => !isAgent(entry))?.body;
      assert.ok(agentBody, "the agent ran on the chat connection");
      assert.ok(mainBody, "the main reply ran");
      for (const field of ["top_p", "frequency_penalty", "presence_penalty", "reasoning", "top_a", "fixture_param"]) {
        assert.notEqual(mainBody[field], undefined, `the main chat sends ${field}`);
        assert.deepEqual(agentBody[field], mainBody[field], `the agent sends the chat connection's ${field}`);
      }
      assert.equal(agentBody.reasoning?.effort, "high");
    } finally {
      await app.close();
    }
  }

  console.log("agent-connection-parameters regression passed");
} finally {
  server.close();
  if (db) await closeDB();
  rmSync(dir, { recursive: true, force: true });
}
