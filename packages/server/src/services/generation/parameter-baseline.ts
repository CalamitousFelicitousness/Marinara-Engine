import {
  CUSTOM_GENERATION_PARAMETERS_SETTINGS_KEY,
  DEFAULT_GENERATION_PARAMS,
  GENERATION_PARAMETER_SEND_KEYS,
  LOCAL_SIDECAR_CONNECTION_ID,
  parseManagedGenerationParameterDefinitions,
  type GenerationParameterBaseline,
  type ParameterTraceLayer,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { mergeCustomParameters, parseStoredGenerationParameters } from "../../routes/generate/generate-route-utils.js";
import { buildGenerationPromptPresetCandidates } from "../../routes/generate/prompt-preset-selection.js";
import { parsePresetParameters } from "../prompt/assembler.js";
import { createAppSettingsStorage } from "../storage/app-settings.storage.js";
import { createConnectionsStorage } from "../storage/connections.storage.js";
import { createPromptsStorage } from "../storage/prompts.storage.js";
import { storedParameterSources } from "./generation-parameters.js";
import { createLocalSidecarGenerationConnection } from "./local-sidecar-generation-connection.js";
import { resolveModelAccessPolicy } from "./model-access-policy.js";
import {
  defaultGenerationParameterValues,
  presetGenerationParameterValues,
  resolveGenerationParameterRuntime,
  usesPresetAssembly,
} from "./provider-generation-runtime.js";

export interface ParameterBaselineRequest {
  mode: string;
  /** Chat metadata; supplies scene status and game setup parameters. */
  meta: Record<string, unknown>;
  connectionId: string | null;
  chatPromptPresetId: string | null;
}

type StoredParameters = ReturnType<typeof parseStoredGenerationParameters>;
type StoredKey = keyof NonNullable<StoredParameters>;
type BaselineParameters = NonNullable<GenerationParameterBaseline["parameters"]>;
type BaselineManaged = NonNullable<GenerationParameterBaseline["managed"]>;

/** The highest layer that stores any of `keys`, or "default". */
function layerSource(
  layers: Array<[StoredParameters, ParameterTraceLayer]>,
  ...keys: StoredKey[]
): ParameterTraceLayer {
  return layers.find(([params]) => params && keys.some((key) => params[key] !== undefined))?.[1] ?? "default";
}

/** Resolves what the layers below a chat would send, leaving the chat's own values out. */
export function createParameterBaselineResolver(db: DB) {
  const connections = createConnectionsStorage(db);
  const presets = createPromptsStorage(db);
  const appSettings = createAppSettingsStorage(db);

  return async function resolveParameterBaseline(
    request: ParameterBaselineRequest,
  ): Promise<GenerationParameterBaseline> {
    const { mode, meta, connectionId } = request;
    const baseline: GenerationParameterBaseline = {
      connection: { kind: "none", id: null, provider: null, model: null },
      mode,
      scene: meta.sceneStatus === "active",
      suppressModelParameters: false,
      parameters: null,
      fields: null,
      managed: null,
      customParameters: null,
    };
    if (connectionId === "random") {
      return { ...baseline, connection: { kind: "random", id: connectionId, provider: null, model: null } };
    }
    const conn = !connectionId
      ? null
      : connectionId === LOCAL_SIDECAR_CONNECTION_ID
        ? createLocalSidecarGenerationConnection()
        : await connections.getById(connectionId);
    if (!conn) return baseline;

    // Post-processing reads the preset in every mode; sampling values and prompt fields only where it assembles the prompt.
    let presetStored: StoredParameters = null;
    let presetAppliesValues = false;
    let values = defaultGenerationParameterValues();
    for (const candidate of buildGenerationPromptPresetCandidates({
      chatMode: mode,
      chatPromptPresetId: request.chatPromptPresetId,
      connectionPromptPresetId: conn.promptPresetId,
    })) {
      const preset = await presets.getById(candidate.id);
      if (!preset) continue;
      presetStored = parseStoredGenerationParameters(preset.parameters);
      if (usesPresetAssembly(mode)) {
        presetAppliesValues = true;
        values = presetGenerationParameterValues(parsePresetParameters(preset.parameters));
      }
      break;
    }

    const definitions = parseManagedGenerationParameterDefinitions(
      await appSettings.get(CUSTOM_GENERATION_PARAMETERS_SETTINGS_KEY),
    );
    const modelAccessPolicy = resolveModelAccessPolicy({
      provider: conn.provider,
      model: conn.model,
      maxContext: conn.maxContext,
    });
    const runtime = resolveGenerationParameterRuntime({
      connection: conn,
      chatMode: mode,
      isSceneChat: baseline.scene,
      chatParameters: undefined,
      gameSetupParameters: (meta.gameSetupConfig as Record<string, unknown> | undefined)?.generationParameters,
      managedParameterDefinitions: definitions,
      modelAccessPolicy,
      initial: { ...values, effectiveMaxContext: modelAccessPolicy.effectiveMaxContext },
      initialSources: presetAppliesValues ? storedParameterSources(presetStored, "preset") : undefined,
    });

    const valueOf = {
      temperature: runtime.temperature ?? null,
      maxTokens: runtime.maxTokens,
      topP: runtime.topP ?? null,
      topK: runtime.topK,
      frequencyPenalty: runtime.frequencyPenalty,
      presencePenalty: runtime.presencePenalty,
      reasoningEffort: runtime.reasoningEffort,
      verbosity: runtime.verbosity,
    };
    // The live route leaves zero penalties, zero top_k and an empty verbosity out of the request.
    const carriesValue = {
      temperature: runtime.temperature !== undefined,
      maxTokens: true,
      topP: runtime.topP !== undefined,
      topK: runtime.providerTopK !== undefined,
      frequencyPenalty: Boolean(runtime.frequencyPenalty),
      presencePenalty: Boolean(runtime.presencePenalty),
      reasoningEffort: runtime.providerReasoningEffort !== undefined,
      verbosity: Boolean(runtime.verbosity),
    };
    const suppressed = modelAccessPolicy.suppressModelParameters;
    const parameters = {} as BaselineParameters;
    for (const key of GENERATION_PARAMETER_SEND_KEYS) {
      const source = runtime.parameterSources[key] ?? "default";
      const suppressedKey = suppressed && key !== "maxTokens";
      const switchOff = runtime.enabledParameters?.[key] === false;
      const sent = !suppressedKey && !switchOff && carriesValue[key];
      (parameters as Record<string, unknown>)[key] = {
        value: valueOf[key],
        sent,
        source,
        notSentBy: sent
          ? null
          : suppressedKey
            ? "suppressed"
            : switchOff
              ? (runtime.sendSwitchSources[key] ?? "default")
              : source,
      };
    }

    const fieldLayers: Array<[StoredParameters, ParameterTraceLayer]> = [
      [runtime.gameSetupParams, "game mode"],
      [runtime.connectionParams, "connection"],
      ...(presetAppliesValues ? ([[presetStored, "preset"]] as Array<[StoredParameters, ParameterTraceLayer]>) : []),
    ];
    const postProcessingLayers: Array<[StoredParameters, ParameterTraceLayer]> = [
      [runtime.gameSetupParams, "game mode"],
      [runtime.connectionParams, "connection"],
      [presetStored, "preset"],
    ];
    const postProcessing = {
      strictRoleFormatting: DEFAULT_GENERATION_PARAMS.strictRoleFormatting,
      singleUserMessage: DEFAULT_GENERATION_PARAMS.singleUserMessage,
    };
    for (const [params] of [...postProcessingLayers].reverse()) {
      if (typeof params?.strictRoleFormatting === "boolean") {
        postProcessing.strictRoleFormatting = params.strictRoleFormatting;
      }
      if (typeof params?.singleUserMessage === "boolean") postProcessing.singleUserMessage = params.singleUserMessage;
    }

    const managed: BaselineManaged = {};
    for (const definition of definitions) {
      const setupEntry = runtime.gameSetupParams?.managedCustomParameters?.[definition.id];
      const connectionEntry = runtime.connectionParams?.managedCustomParameters?.[definition.id];
      const entry = setupEntry ?? connectionEntry;
      managed[definition.id] = entry
        ? { enabled: entry.enabled, value: entry.value, source: setupEntry ? "game mode" : "connection" }
        : { enabled: false, value: definition.min, source: "default" };
    }

    return {
      ...baseline,
      connection: {
        kind: connectionId === LOCAL_SIDECAR_CONNECTION_ID ? "local_sidecar" : "connection",
        id: connectionId,
        provider: conn.provider,
        model: conn.model,
      },
      suppressModelParameters: suppressed,
      parameters,
      fields: {
        assistantPrefill: { value: runtime.assistantPrefill, source: layerSource(fieldLayers, "assistantPrefill") },
        assistantReasoningPrefill: {
          value: runtime.assistantReasoningPrefill,
          source: layerSource(fieldLayers, "assistantReasoningPrefill"),
        },
        customThinkingTags: {
          value: runtime.customThinkingTags,
          source: layerSource(fieldLayers, "customThinkingTags"),
        },
        postProcessing: {
          value: postProcessing,
          source: layerSource(postProcessingLayers, "strictRoleFormatting", "singleUserMessage"),
        },
        serviceTier: { value: runtime.serviceTier, source: layerSource(fieldLayers, "serviceTier") },
      },
      managed,
      customParameters: mergeCustomParameters(
        mergeCustomParameters(values.customParameters, runtime.connectionParams?.customParameters),
        runtime.gameSetupParams?.customParameters,
      ),
    };
  };
}
