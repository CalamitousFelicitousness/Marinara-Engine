import { randomUUID } from "node:crypto";
import type {
  AgentContext,
  AgentParameterTrace,
  AgentTaskProgress,
  ParameterTraceLayer,
} from "@marinara-engine/shared";
import type { BaseLLMProvider, ChatMessage, ChatOptions } from "../llm/base-provider.js";
import {
  buildParameterTrace,
  extractSentParameters,
  normalizeAgentMaxTokens,
  traceValuesFromOptions,
  type SentRequestParameters,
  type StoredParameterSources,
} from "../generation/generation-parameters.js";
import type { AgentExecConfig } from "./agent-executor.js";
import { logger } from "../../lib/logger.js";

/** Labels an agent request's parameters the way agent-executor resolves them. */
export function agentParameterSources(
  configs: readonly AgentExecConfig[],
  options: ChatOptions,
): StoredParameterSources {
  const config = configs[0]!;
  const inherited: ParameterTraceLayer = config.connectionId ? "connection" : "chat";
  const sources: StoredParameterSources = { parameters: {}, sendSwitches: {} };
  if (options.temperature !== undefined) {
    sources.parameters.temperature =
      config.type === "beholder" ? "agent rule" : config.temperature !== undefined ? inherited : "default";
  }
  if (options.maxTokens !== undefined) {
    // Batches sum member budgets; connection overrides and model output limits cap single calls.
    sources.parameters.maxTokens =
      configs.length > 1 || options.maxTokens < normalizeAgentMaxTokens(config.settings.maxTokens)
        ? "agent rule"
        : config.settings.maxTokens !== undefined
          ? "agent settings"
          : "default";
  }
  if (options.reasoningEffort !== undefined) sources.parameters.reasoningEffort = "agent rule";
  for (const [key, enabled] of Object.entries(options.enabledParameters ?? {}) as Array<
    [keyof NonNullable<ChatOptions["enabledParameters"]>, boolean]
  >) {
    sources.sendSwitches[key] = config.enabledParameters?.[key] === enabled ? inherited : "agent rule";
  }
  return sources;
}

/** Replaces saved traces that include any re-run agent; a batch trace goes whole. */
export function mergeRetriedAgentTraces(saved: unknown, retried: readonly AgentParameterTrace[]): unknown[] {
  const retriedIds = new Set<unknown>(retried.flatMap((trace) => trace.agents.map((agent) => agent.id)));
  const kept = (Array.isArray(saved) ? saved : []).filter((entry) => {
    const agents = (entry as { agents?: unknown } | null)?.agents;
    return !Array.isArray(agents) || !agents.some((agent) => retriedIds.has((agent as { id?: unknown } | null)?.id));
  });
  return [...kept, ...retried];
}

/** Observe an existing call while forwarding its explicit agent debug setting. */
export async function completeAgentCall(
  context: AgentContext,
  agents: readonly AgentExecConfig[],
  provider: BaseLLMProvider,
  messages: ChatMessage[],
  options: ChatOptions,
) {
  if (context.agentDebug && options.debugMode !== true) options = { ...options, debugMode: true };
  const agentTrace = context.agentTrace;
  if (!agentTrace) return observeAgentCall(context, agents, provider, messages, options);

  const capture: { sent: SentRequestParameters | null } = { sent: null };
  const callerOnRequestBody = options.onRequestBody;
  options = {
    ...options,
    onRequestBody: (body, meta) => {
      capture.sent = extractSentParameters(body, meta);
      callerOnRequestBody?.(body, meta);
    },
  };
  try {
    return await observeAgentCall(context, agents, provider, messages, options);
  } finally {
    // Failed calls still report what they sent; a call that never reached the provider has nothing to show.
    if (capture.sent) {
      const sources = agentParameterSources(agents, options);
      try {
        agentTrace({
          agents: agents.map(({ id, type, name }) => ({ id, type, name })),
          phase: agents.length > 1 ? "batch" : agents[0]!.phase,
          connectionId: agents[0]!.connectionId,
          model: options.model,
          trace: buildParameterTrace({
            values: traceValuesFromOptions(options, false),
            sources: sources.parameters,
            enabledParameters: options.enabledParameters,
            sendSwitchSources: sources.sendSwitches,
            customParameters: options.customParameters,
            sent: capture.sent,
          }),
        });
      } catch (error) {
        logger.warn(error, "Could not record agent parameter trace");
      }
    }
  }
}

async function observeAgentCall(
  context: AgentContext,
  agents: ReadonlyArray<AgentTaskProgress["agents"][number]>,
  provider: BaseLLMProvider,
  messages: ChatMessage[],
  options: ChatOptions,
) {
  if (!context.agentProgress) return provider.chatComplete(messages, options);
  const startedAt = Date.now();
  const progress: AgentTaskProgress = {
    callId: randomUUID(),
    agents: agents.map(({ id, type, name, phase }) => ({ id, type, name, phase })),
    stage: "waiting",
    receivedChunks: 0,
    receivedCharacters: 0,
    elapsedMs: 0,
  };
  let lastEmission = startedAt;
  const emit = () => {
    lastEmission = Date.now();
    progress.elapsedMs = lastEmission - startedAt;
    try {
      context.agentProgress?.({ ...progress });
    } catch (error) {
      logger.warn(error, "Could not send agent progress");
    }
  };
  const receive = (chunk: string) => {
    if (!chunk) return;
    progress.receivedChunks++;
    progress.receivedCharacters += chunk.length;
    progress.stage = "streaming";
    const first = progress.ttftMs === undefined;
    if (first) progress.ttftMs = Date.now() - startedAt;
    // One first-chunk update, then at most four updates/second per call.
    if (first || Date.now() - lastEmission >= 250) emit();
  };
  emit();
  try {
    const result = await provider.chatComplete(messages, {
      ...options,
      ...(options.stream !== false
        ? {
            onToken: async (chunk: string) => {
              receive(chunk);
              await options.onToken?.(chunk);
            },
            onThinking: (chunk: string) => {
              receive(chunk);
              options.onThinking?.(chunk);
            },
          }
        : {}),
    });
    progress.stage =
      result.finishReason === "abort" ? "stopped" : result.finishReason === "error" ? "error" : "received";
    if (result.usage) {
      progress.promptTokens = result.usage.promptTokens;
      progress.completionTokens = result.usage.completionTokens;
    }
    emit();
    return result;
  } catch (error) {
    progress.stage = options.signal?.aborted ? "stopped" : "error";
    emit();
    throw error;
  }
}
