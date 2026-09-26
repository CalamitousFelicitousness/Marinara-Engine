import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  DEFAULT_GENERATION_PARAMS,
  GENERATION_PARAMETER_SEND_KEYS,
  CUSTOM_GENERATION_PARAMETERS_SETTINGS_KEY,
  parseManagedGenerationParameterDefinitions,
  type ParameterTraceLayer,
} from "@marinara-engine/shared";
import { createConnectionsStorage } from "../../services/storage/connections.storage.js";
import { createChatsStorage } from "../../services/storage/chats.storage.js";
import { createPromptsStorage } from "../../services/storage/prompts.storage.js";
import { createAppSettingsStorage } from "../../services/storage/app-settings.storage.js";
import { parsePresetParameters } from "../../services/prompt/assembler.js";
import {
  defaultGenerationParameterValues,
  presetGenerationParameterValues,
  resolveGenerationParameterRuntime,
  usesPresetAssembly,
} from "../../services/generation/provider-generation-runtime.js";
import { storedParameterSources } from "../../services/generation/generation-parameters.js";
import {
  resolveModelAccessPolicy,
  mergeModelContextLimit,
  resolveStoredModelContextLimit,
} from "../../services/generation/model-access-policy.js";
import { sentOutputBudget } from "../../services/generation/empty-response-reason.js";
import { buildGenerationPromptPresetCandidates } from "./prompt-preset-selection.js";
import { parseExtra, parseStoredGenerationParameters } from "./generate-route-utils.js";

const previewSchema = z.object({ connectionId: z.string().min(1), chatId: z.string().min(1).optional() });

type StoredParameters = ReturnType<typeof parseStoredGenerationParameters>;

/** Client label keys (`generationParameters.source.*`) for each trace layer. */
const SOURCE_LABELS: Record<ParameterTraceLayer, string> = {
  default: "defaults",
  preset: "preset",
  connection: "connection",
  chat: "chat",
  scene: "scene",
  "game mode": "game",
  "model rule": "provider",
  "agent rule": "provider",
  "agent settings": "provider",
};

/** Read saved settings using the same layer resolver as generation, without assembling a prompt or calling a model. */
export async function registerParameterPreviewRoute(app: FastifyInstance) {
  app.post("/parameters", async (request, reply) => {
    const input = previewSchema.parse(request.body);
    const connection = await createConnectionsStorage(app.db).getById(input.connectionId);
    if (!connection) return reply.status(404).send({ error: "Connection not found" });
    const chat = input.chatId ? await createChatsStorage(app.db).getById(input.chatId) : null;
    if (input.chatId && !chat) return reply.status(404).send({ error: "Chat not found" });
    const metadata = (parseExtra(chat?.metadata) ?? {}) as Record<string, unknown>;
    const chatMode = chat?.mode ?? "roleplay";
    const presets = createPromptsStorage(app.db);
    let preset: Awaited<ReturnType<typeof presets.getById>> = null;
    for (const candidate of buildGenerationPromptPresetCandidates({
      chatMode,
      chatPromptPresetId: chat?.promptPresetId,
      connectionPromptPresetId: connection.promptPresetId,
    })) {
      preset = await presets.getById(candidate.id);
      if (preset) break;
    }
    // Conversation and Game chats read their preset for prompt text only, as generation does.
    const presetApplies = !!preset && usesPresetAssembly(chatMode);
    const presetParams = preset ? parsePresetParameters(preset.parameters) : { ...DEFAULT_GENERATION_PARAMS };
    const storedPresetParams: StoredParameters = presetApplies
      ? parseStoredGenerationParameters(preset?.parameters)
      : null;
    const policy = resolveModelAccessPolicy(connection);
    const definitions = parseManagedGenerationParameterDefinitions(
      await createAppSettingsStorage(app.db).get(CUSTOM_GENERATION_PARAMETERS_SETTINGS_KEY),
    );
    const runtime = resolveGenerationParameterRuntime({
      connection,
      chatMode,
      isSceneChat: metadata.sceneStatus === "active",
      chatParameters: metadata.chatParameters,
      chatParameterOverrides: metadata.chatParameterOverrides,
      gameSetupParameters: (metadata.gameSetupConfig as Record<string, unknown> | undefined)?.generationParameters,
      managedParameterDefinitions: definitions,
      modelAccessPolicy: policy,
      initialSources: presetApplies ? storedParameterSources(storedPresetParams, "preset") : undefined,
      initial: {
        ...(presetApplies ? presetGenerationParameterValues(presetParams) : defaultGenerationParameterValues()),
        effectiveMaxContext: mergeModelContextLimit(
          policy,
          policy.effectiveMaxContext,
          presetApplies ? resolveStoredModelContextLimit(policy, presetParams) : undefined,
        ),
      },
    });
    const cappedOutput = sentOutputBudget(runtime.maxTokens, connection.maxTokensOverride);
    const values: Record<string, unknown> = {
      ...Object.fromEntries(
        [
          ...GENERATION_PARAMETER_SEND_KEYS,
          "serviceTier",
          "assistantPrefill",
          "assistantReasoningPrefill",
          "customThinkingTags",
          "customParameters",
        ].map((key) => [key, runtime[key as keyof typeof runtime]]),
      ),
      maxTokens: cappedOutput,
      reasoningEffort: runtime.providerReasoningEffort,
    };

    // Fields outside the sampling trace take the highest stored layer that sets them.
    const fieldLayers: Array<[StoredParameters, ParameterTraceLayer]> = [
      [runtime.chatOverrideParams, "chat"],
      [runtime.chatParams, "chat"],
      [runtime.gameSetupParams, "game mode"],
      [runtime.connectionParams, "connection"],
      [storedPresetParams, "preset"],
    ];
    const postProcessing = {
      strictRoleFormatting: DEFAULT_GENERATION_PARAMS.strictRoleFormatting,
      singleUserMessage: DEFAULT_GENERATION_PARAMS.singleUserMessage,
    };
    for (const [params] of [...fieldLayers].reverse()) {
      if (typeof params?.strictRoleFormatting === "boolean") {
        postProcessing.strictRoleFormatting = params.strictRoleFormatting;
      }
      if (typeof params?.singleUserMessage === "boolean") postProcessing.singleUserMessage = params.singleUserMessage;
    }
    values.strictRoleFormatting = postProcessing.strictRoleFormatting;
    values.singleUserMessage = postProcessing.singleUserMessage;
    const fieldSource = (key: string): string => {
      const layer = fieldLayers.find(
        ([params]) => params && (params as Record<string, unknown>)[key] !== undefined,
      )?.[1];
      return SOURCE_LABELS[layer ?? "default"];
    };
    const sourceOf = (key: string): string => {
      if (key === "maxTokens" && cappedOutput !== runtime.maxTokens) return "outputCap";
      const layer = runtime.parameterSources[key as keyof typeof runtime.parameterSources];
      return layer ? SOURCE_LABELS[layer] : fieldSource(key);
    };

    const keys = [
      ...GENERATION_PARAMETER_SEND_KEYS,
      "serviceTier",
      "strictRoleFormatting",
      "singleUserMessage",
      "assistantPrefill",
      "assistantReasoningPrefill",
      "customThinkingTags",
      "customParameters",
    ];
    return {
      chatName: chat?.name ?? null,
      inheritedParameters: {
        ...presetParams,
        ...runtime.connectionParams,
        enabledParameters: {
          ...Object.fromEntries(GENERATION_PARAMETER_SEND_KEYS.map((key) => [key, true])),
          ...presetParams.enabledParameters,
          ...runtime.connectionParams?.enabledParameters,
        },
      },
      parameters: Object.fromEntries(
        keys.map((key) => {
          const sendKey = key as (typeof GENERATION_PARAMETER_SEND_KEYS)[number];
          const isSendKey = GENERATION_PARAMETER_SEND_KEYS.includes(sendKey);
          const disabled = runtime.enabledParameters?.[sendKey] === false;
          const suppressed = policy.suppressModelParameters && isSendKey;
          const switchLayer = isSendKey ? runtime.sendSwitchSources[sendKey] : undefined;
          return [
            key,
            {
              value: values[key] ?? null,
              source: suppressed ? "provider" : disabled ? SOURCE_LABELS[switchLayer ?? "default"] : sourceOf(key),
              enabled: !disabled && !suppressed && (values[key] !== undefined || key === "reasoningEffort"),
            },
          ];
        }),
      ),
    };
  });
}
