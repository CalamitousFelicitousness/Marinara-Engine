import {
  DEFAULT_GENERATION_PARAMS,
  chatOverridesAsStoredParameters,
  effectiveChatParameterOverrides,
  isClaudeAdaptiveOnlyNoSamplingModel,
  normalizeThinkingTagPairs,
  resolveManagedGenerationParameters,
  resolveProviderReasoningEffort,
  stripLegacyChatParameters,
  type ChatParameterOverrides,
  type GenerationParameterSendMap,
  type GenerationParameters,
  type ManagedGenerationParameterDefinition,
  type ParameterTraceKey,
  type ParameterTraceLayer,
  type ThinkingTagPair,
} from "@marinara-engine/shared";

import { LOCAL_SIDECAR_CONNECTION_ID } from "@marinara-engine/shared";
import { createLLMProvider } from "../llm/provider-registry.js";
import { getLocalSidecarProvider } from "../llm/local-sidecar.js";
import type { BaseLLMProvider } from "../llm/base-provider.js";
import {
  mergeCustomParameters,
  normalizeServiceTier,
  parseStoredGenerationParameters,
  resolveProviderTopK,
} from "../../routes/generate/generate-route-utils.js";
import { mergeModelContextLimit, resolveStoredModelContextLimit } from "./model-access-policy.js";
import {
  normalizeChatTopP,
  PARAMETER_TRACE_KEYS,
  storedParameterSources,
  supportsAssistantReasoningPrefill,
  type ParameterTraceSources,
  type SendSwitchSources,
  type StoredParameterSources,
} from "./generation-parameters.js";
import { clampGenerationMaxOutputTokens } from "./output-token-limits.js";
import {
  isFallbackConnectionUsable,
  withConnectionFallbackProvider,
  type FallbackConnection,
  type GenerationProviderOrigin,
} from "../llm/connection-fallback-provider.js";
import type { GenerationFallbackNotifier } from "./fallback-notification.js";

type GenerationConnection = {
  provider: string;
  model: string;
  apiKey: string;
  maxContext?: number | null;
  openrouterProvider?: string | null;
  maxTokensOverride?: number | null;
  defaultParameters?: unknown;
  claudeFastMode?: unknown;
  treatAsLocalEndpoint?: unknown;
};

export type GenerationParameterInitial = {
  temperature: number | undefined;
  maxTokens: number;
  topP: number | undefined;
  topK: number;
  minP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  showThoughts: boolean;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "maximum" | null;
  verbosity: "low" | "medium" | "high" | null;
  serviceTier: "flex" | "priority" | null;
  assistantPrefill: string;
  assistantReasoningPrefill: string;
  customThinkingTags: ThinkingTagPair[];
  customParameters: Record<string, unknown>;
  enabledParameters: GenerationParameterSendMap | undefined;
  stopSequences: string[];
  effectiveMaxContext: number | undefined;
};

export type GenerationParameterValues = Omit<GenerationParameterInitial, "effectiveMaxContext">;

export type GenerationParameterRuntimeArgs = {
  connection: Pick<GenerationConnection, "provider" | "model" | "maxTokensOverride" | "defaultParameters">;
  chatMode: string;
  isSceneChat: boolean;
  /** Stored `chatParameters`; sampling values and send switches in it are ignored. */
  chatParameters: unknown;
  /** Stored Connection / Override / Off states. */
  chatParameterOverrides?: unknown;
  /** Game setup's stored parameters, a layer between the connection and game mode in game chats. */
  gameSetupParameters?: unknown;
  managedParameterDefinitions: ManagedGenerationParameterDefinition[];
  modelAccessPolicy: Parameters<typeof mergeModelContextLimit>[0];
  initial: GenerationParameterInitial;
  /** Layers that assigned the `initial` values; unlisted keys are defaults. */
  initialSources?: StoredParameterSources;
};

type GenerationProviderRuntimeArgs = GenerationParameterRuntimeArgs & {
  connectionId: string;
  connection: GenerationConnection;
  baseUrl: string;
  fallbackConnection?: FallbackConnection | null;
  fallbackBaseUrl?: string;
  onFallback?: GenerationFallbackNotifier;
  onProviderUsed?: (origin: GenerationProviderOrigin) => void;
};

type StoredParameters = ReturnType<typeof parseStoredGenerationParameters>;

export type GenerationParameterRuntime = GenerationParameterInitial & {
  connectionParams: StoredParameters;
  gameSetupParams: StoredParameters;
  chatParams: StoredParameters;
  chatOverrideParams: StoredParameters;
  chatOverrides: ChatParameterOverrides;
  resolvedEffort: "low" | "medium" | "high" | "xhigh" | "max" | null;
  providerReasoningEffort: "none" | "low" | "medium" | "high" | "xhigh" | "max" | undefined;
  enableThinking: boolean;
  isClaudeNoSampling: boolean;
  providerTopK: number | undefined;
  parameterSources: ParameterTraceSources;
  sendSwitchSources: SendSwitchSources;
};

export type GenerationProviderRuntime = GenerationParameterRuntime & {
  supportsAssistantReasoningPrefill: boolean;
  primaryProvider: BaseLLMProvider;
  provider: BaseLLMProvider;
};

/** Start values before any preset, connection or chat layer applies. */
export function defaultGenerationParameterValues(): GenerationParameterValues {
  return {
    temperature: 1,
    maxTokens: 4096,
    topP: 1,
    topK: 0,
    minP: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    showThoughts: true,
    reasoningEffort: DEFAULT_GENERATION_PARAMS.reasoningEffort,
    verbosity: null,
    serviceTier: null,
    assistantPrefill: "",
    assistantReasoningPrefill: "",
    customThinkingTags: [],
    customParameters: {},
    enabledParameters: undefined,
    stopSequences: [],
  };
}

/** Values a prompt preset supplies in chat modes that assemble their prompt from the preset. */
export function presetGenerationParameterValues(parameters: GenerationParameters): GenerationParameterValues {
  return {
    temperature: parameters.temperature,
    maxTokens: parameters.maxTokens,
    topP: parameters.topP ?? 1,
    topK: parameters.topK ?? 0,
    minP: parameters.minP ?? 0,
    frequencyPenalty: parameters.frequencyPenalty ?? 0,
    presencePenalty: parameters.presencePenalty ?? 0,
    showThoughts: parameters.showThoughts ?? true,
    reasoningEffort: parameters.reasoningEffort ?? null,
    verbosity: parameters.verbosity ?? null,
    serviceTier: parameters.serviceTier ?? null,
    assistantPrefill: parameters.assistantPrefill ?? "",
    assistantReasoningPrefill: parameters.assistantReasoningPrefill ?? "",
    customThinkingTags: normalizeThinkingTagPairs(parameters.customThinkingTags),
    customParameters: mergeCustomParameters({}, parameters.customParameters),
    enabledParameters: parameters.enabledParameters ? { ...parameters.enabledParameters } : undefined,
    stopSequences: (parameters.stopSequences ?? []).map((value) => value.trim()).filter((value) => value.length > 0),
  };
}

/** Conversation and game chats use their preset for prompt text only, never for parameters. */
export function usesPresetAssembly(chatMode: string): boolean {
  return chatMode !== "conversation" && chatMode !== "game";
}

/** Resolves every parameter layer for a generation without building its provider. */
export function resolveGenerationParameterRuntime(args: GenerationParameterRuntimeArgs): GenerationParameterRuntime {
  const isGame = args.chatMode === "game";
  const connectionParams = parseStoredGenerationParameters(args.connection.defaultParameters);
  const gameSetupParams = isGame ? parseStoredGenerationParameters(args.gameSetupParameters) : null;
  const chatParams = parseStoredGenerationParameters(stripLegacyChatParameters(args.chatParameters));
  const chatOverrides = effectiveChatParameterOverrides(args.chatParameters, args.chatParameterOverrides);
  const chatOverrideParams = parseStoredGenerationParameters(chatOverridesAsStoredParameters(chatOverrides));
  const runtime = { ...args.initial };
  const parameterSources: ParameterTraceSources = { ...args.initialSources?.parameters };
  const sendSwitchSources: SendSwitchSources = { ...args.initialSources?.sendSwitches };
  const labelLayer = (layer: ParameterTraceLayer, keys: readonly ParameterTraceKey[]) => {
    for (const key of keys) parameterSources[key] = layer;
  };
  const labelStoredLayer = (params: StoredParameters, layer: ParameterTraceLayer) => {
    const labels = storedParameterSources(params, layer);
    Object.assign(parameterSources, labels.parameters);
    Object.assign(sendSwitchSources, labels.sendSwitches);
  };

  const applyParameterOverrides = (params: StoredParameters) => {
    if (!params) return;
    if (typeof params.temperature === "number") runtime.temperature = params.temperature;
    if (typeof params.maxTokens === "number") runtime.maxTokens = params.maxTokens;
    runtime.topP = normalizeChatTopP(params.topP) ?? runtime.topP;
    if (typeof params.topK === "number") runtime.topK = params.topK;
    if (typeof params.minP === "number") runtime.minP = params.minP;
    if (typeof params.frequencyPenalty === "number") runtime.frequencyPenalty = params.frequencyPenalty;
    if (typeof params.presencePenalty === "number") runtime.presencePenalty = params.presencePenalty;
    if (typeof params.showThoughts === "boolean") runtime.showThoughts = params.showThoughts;
    if (params.reasoningEffort !== undefined) runtime.reasoningEffort = params.reasoningEffort;
    if (params.verbosity !== undefined) runtime.verbosity = params.verbosity;
    if (params.serviceTier !== undefined) runtime.serviceTier = normalizeServiceTier(params.serviceTier);
    if (typeof params.assistantPrefill === "string") runtime.assistantPrefill = params.assistantPrefill;
    if (typeof params.assistantReasoningPrefill === "string") {
      runtime.assistantReasoningPrefill = params.assistantReasoningPrefill;
    }
    if (params.customThinkingTags !== undefined) {
      runtime.customThinkingTags = normalizeThinkingTagPairs(params.customThinkingTags);
    }
    runtime.customParameters = mergeCustomParameters(runtime.customParameters, params.customParameters);
    if (params.enabledParameters) {
      runtime.enabledParameters = { ...(runtime.enabledParameters ?? {}), ...params.enabledParameters };
    }
    if (Array.isArray(params.stopSequences)) {
      runtime.stopSequences = params.stopSequences.map((value) => value.trim()).filter((value) => value.length > 0);
    }

    runtime.effectiveMaxContext = mergeModelContextLimit(
      args.modelAccessPolicy,
      runtime.effectiveMaxContext,
      resolveStoredModelContextLimit(args.modelAccessPolicy, params),
    );
  };

  const isLocalGemma = (args.connection.model ?? "").toLowerCase().includes("gemma");
  applyParameterOverrides(connectionParams);
  labelStoredLayer(connectionParams, "connection");
  applyParameterOverrides(gameSetupParams);
  labelStoredLayer(gameSetupParams, "game mode");
  applyParameterOverrides(chatParams);
  labelStoredLayer(chatParams, "chat");

  if (args.isSceneChat) {
    runtime.maxTokens = 8192;
    runtime.reasoningEffort = "maximum";
    runtime.verbosity = "high";
    labelLayer("scene", ["maxTokens", "reasoningEffort", "verbosity"]);
  }

  if (isGame && !isLocalGemma) {
    runtime.temperature = 1;
    runtime.maxTokens = 16_384;
    runtime.topP = 1;
    runtime.topK = 0;
    runtime.minP = 0;
    runtime.frequencyPenalty = 0;
    runtime.presencePenalty = 0;
    runtime.reasoningEffort = "maximum";
    runtime.verbosity = null;
    labelLayer("game mode", PARAMETER_TRACE_KEYS);
  }

  // Scene and game values keep leftover connection values away from structured output; a chat's Override or Off wins.
  applyParameterOverrides(chatOverrideParams);
  labelStoredLayer(chatOverrideParams, "chat");
  runtime.customParameters = mergeCustomParameters(
    runtime.customParameters,
    resolveManagedGenerationParameters(
      args.managedParameterDefinitions,
      connectionParams?.managedCustomParameters,
      gameSetupParams?.managedCustomParameters,
      chatOverrideParams?.managedCustomParameters,
    ),
  );

  if (isGame) {
    const maxTokensOverridden = chatOverrides.maxTokens?.mode === "override";
    const maxTokensBeforeFloor = runtime.maxTokens;
    runtime.maxTokens = clampGenerationMaxOutputTokens({
      provider: args.connection.provider,
      model: args.connection.model,
      maxTokens: maxTokensOverridden ? runtime.maxTokens : Math.max(runtime.maxTokens, 16_384),
      maxTokensOverride: args.connection.maxTokensOverride,
    });
    if (runtime.maxTokens !== maxTokensBeforeFloor) {
      labelLayer(maxTokensOverridden ? "model rule" : "game mode", ["maxTokens"]);
    }
  }

  const modelLower = (args.connection.model ?? "").toLowerCase();
  const providerLower = (args.connection.provider ?? "").toLowerCase();
  const resolvedEffort = resolveProviderReasoningEffort({
    provider: providerLower,
    model: modelLower,
    reasoningEffort: runtime.reasoningEffort,
  });

  if (resolvedEffort && !runtime.showThoughts) {
    runtime.showThoughts = true;
  }

  const enableThinking = !!resolvedEffort;
  const providerReasoningEffort =
    runtime.enabledParameters?.reasoningEffort === false
      ? undefined
      : runtime.reasoningEffort === null
        ? "none"
        : (resolvedEffort ?? undefined);
  const isClaudeNoSampling = isClaudeAdaptiveOnlyNoSamplingModel(modelLower);
  if (isClaudeNoSampling) {
    runtime.temperature = undefined;
    runtime.topP = undefined;
    runtime.topK = 0;
    runtime.frequencyPenalty = 0;
    runtime.presencePenalty = 0;
    labelLayer("model rule", ["temperature", "topP", "topK", "frequencyPenalty", "presencePenalty"]);
  }

  const isClaudeTemperatureOnly =
    !isClaudeNoSampling &&
    (/claude-(opus|sonnet)-4-[56]/.test(modelLower) || /claude-(opus|sonnet)-4\.[56]/.test(modelLower));
  if (isClaudeTemperatureOnly) {
    runtime.topP = undefined;
    runtime.topK = 0;
    runtime.frequencyPenalty = 0;
    runtime.presencePenalty = 0;
    labelLayer("model rule", ["topP", "topK", "frequencyPenalty", "presencePenalty"]);
  }

  return {
    ...runtime,
    connectionParams,
    gameSetupParams,
    chatParams,
    chatOverrideParams,
    chatOverrides,
    resolvedEffort,
    providerReasoningEffort,
    enableThinking,
    isClaudeNoSampling,
    providerTopK: resolveProviderTopK(runtime.topK),
    parameterSources,
    sendSwitchSources,
  };
}

export function resolveGenerationProviderRuntime(args: GenerationProviderRuntimeArgs): GenerationProviderRuntime {
  const parameters = resolveGenerationParameterRuntime(args);
  const primaryProvider =
    args.connectionId === LOCAL_SIDECAR_CONNECTION_ID
      ? getLocalSidecarProvider()
      : createLLMProvider(
          args.connection.provider,
          args.baseUrl,
          args.connection.apiKey,
          args.connection.maxContext,
          args.connection.openrouterProvider,
          args.connection.maxTokensOverride,
          args.connection.claudeFastMode === "true",
          args.connection.treatAsLocalEndpoint === "true",
          args.connection.defaultParameters,
        );
  const primarySupportsAssistantReasoningPrefill = supportsAssistantReasoningPrefill(args.connection.provider);
  const hasUsableFallback = isFallbackConnectionUsable(
    args.fallbackConnection,
    args.connectionId,
    args.fallbackBaseUrl ?? "",
  );
  const fallbackSupportsAssistantReasoningPrefill = Boolean(
    hasUsableFallback && args.fallbackConnection && supportsAssistantReasoningPrefill(args.fallbackConnection.provider),
  );
  const provider = withConnectionFallbackProvider({
    primary: primaryProvider,
    primaryConnectionId: args.connectionId,
    fallbackConnection: args.fallbackConnection,
    fallbackBaseUrl: args.fallbackBaseUrl ?? "",
    category: "main",
    onFallback: args.onFallback,
    onProviderUsed: args.onProviderUsed,
    primarySupportsAssistantReasoningPrefill,
    fallbackSupportsAssistantReasoningPrefill,
  });

  return {
    ...parameters,
    supportsAssistantReasoningPrefill:
      primarySupportsAssistantReasoningPrefill || fallbackSupportsAssistantReasoningPrefill,
    primaryProvider,
    provider,
  };
}
