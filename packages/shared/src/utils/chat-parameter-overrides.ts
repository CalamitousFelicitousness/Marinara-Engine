import { z } from "zod";
import { generationParametersSchema } from "../schemas/prompt.schema.js";
import type { ParameterTraceLayer } from "../types/chat.js";
import {
  GENERATION_PARAMETER_SEND_KEYS,
  type GenerationParameterSendKey,
  type GenerationParameterSendMap,
  type GenerationParameters,
  type ManagedGenerationParameterValueMap,
} from "../types/prompt.js";
import type { ThinkingTagPair } from "./thinking-tags.js";

/** Top-level chat metadata key holding a chat's per-parameter Connection / Override / Off states. */
export const CHAT_PARAMETER_OVERRIDES_METADATA_KEY = "chatParameterOverrides";

export type ChatParameterOverride<T> = { mode: "override"; value: T } | { mode: "off" };
export type ChatParameterValueOverride<T> = { mode: "override"; value: T };

export interface ChatPostProcessing {
  strictRoleFormatting: boolean;
  singleUserMessage: boolean;
}

/** A missing entry means the chat follows the layers below it. */
export type ChatParameterOverrides = {
  [K in GenerationParameterSendKey]?: ChatParameterOverride<GenerationParameters[K]>;
} & {
  assistantPrefill?: ChatParameterOverride<string>;
  assistantReasoningPrefill?: ChatParameterOverride<string>;
  customThinkingTags?: ChatParameterOverride<ThinkingTagPair[]>;
  postProcessing?: ChatParameterValueOverride<ChatPostProcessing>;
  serviceTier?: ChatParameterValueOverride<GenerationParameters["serviceTier"]>;
  /** Keyed by managed parameter definition id. */
  managed?: Record<string, ChatParameterOverride<number>>;
};

/** Fields with Connection / Override / Off; Post-Processing and Service Tier only have Connection / Override. */
export const CHAT_PARAMETER_OFF_CAPABLE_KEYS = [
  ...GENERATION_PARAMETER_SEND_KEYS,
  "assistantPrefill",
  "assistantReasoningPrefill",
  "customThinkingTags",
] as const;
export type ChatParameterOffCapableKey = (typeof CHAT_PARAMETER_OFF_CAPABLE_KEYS)[number];

const LEGACY_SAMPLER_KEYS: readonly string[] = [...GENERATION_PARAMETER_SEND_KEYS, "minP", "enabledParameters"];
const LEGACY_CONVERTED_KEYS: readonly string[] = [
  "assistantPrefill",
  "assistantReasoningPrefill",
  "customThinkingTags",
  "strictRoleFormatting",
  "singleUserMessage",
  "serviceTier",
  "managedCustomParameters",
];

const shape = generationParametersSchema.shape;
const OFF_CAPABLE_VALUE_SCHEMAS = {
  temperature: shape.temperature.removeDefault(),
  maxTokens: shape.maxTokens.removeDefault(),
  topP: shape.topP.removeDefault(),
  topK: shape.topK.removeDefault(),
  frequencyPenalty: shape.frequencyPenalty.removeDefault(),
  presencePenalty: shape.presencePenalty.removeDefault(),
  reasoningEffort: shape.reasoningEffort.removeDefault(),
  verbosity: shape.verbosity.removeDefault(),
  assistantPrefill: shape.assistantPrefill.removeDefault(),
  assistantReasoningPrefill: shape.assistantReasoningPrefill.removeDefault(),
  customThinkingTags: shape.customThinkingTags.removeDefault(),
} satisfies Record<ChatParameterOffCapableKey, z.ZodTypeAny>;
const postProcessingSchema = z.object({
  strictRoleFormatting: shape.strictRoleFormatting.removeDefault(),
  singleUserMessage: shape.singleUserMessage.removeDefault(),
});
const serviceTierSchema = shape.serviceTier.removeDefault();
const managedValueSchema = z.number().finite();

function isUnsafeKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function parseRecord(raw: unknown): Record<string, unknown> | null {
  let parsed = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function parseOverride<T>(schema: z.ZodType<T>, raw: unknown, allowOff: boolean): ChatParameterOverride<T> | undefined {
  const entry = parseRecord(raw);
  if (!entry || typeof raw === "string") return undefined;
  if (entry.mode === "off") return allowOff ? { mode: "off" } : undefined;
  if (entry.mode !== "override" || !hasOwn(entry, "value")) return undefined;
  const value = schema.safeParse(entry.value);
  return value.success ? { mode: "override", value: value.data } : undefined;
}

/** Parses stored overrides; an invalid entry is dropped on its own and the rest are kept. */
export function parseChatParameterOverrides(raw: unknown): ChatParameterOverrides {
  const source = parseRecord(raw);
  const overrides: ChatParameterOverrides = {};
  if (!source) return overrides;
  for (const key of CHAT_PARAMETER_OFF_CAPABLE_KEYS) {
    const parsed = parseOverride<unknown>(OFF_CAPABLE_VALUE_SCHEMAS[key], source[key], true);
    if (parsed) (overrides as Record<string, unknown>)[key] = parsed;
  }
  const postProcessing = parseOverride(postProcessingSchema, source.postProcessing, false);
  if (postProcessing?.mode === "override") overrides.postProcessing = postProcessing;
  const serviceTier = parseOverride(serviceTierSchema, source.serviceTier, false);
  if (serviceTier?.mode === "override") overrides.serviceTier = serviceTier;
  const managedSource = parseRecord(source.managed);
  if (managedSource && typeof source.managed !== "string") {
    const managed: Record<string, ChatParameterOverride<number>> = {};
    for (const [id, entry] of Object.entries(managedSource)) {
      if (isUnsafeKey(id)) continue;
      const parsed = parseOverride(managedValueSchema, entry, true);
      if (parsed) managed[id] = parsed;
    }
    if (Object.keys(managed).length > 0) overrides.managed = managed;
  }
  return overrides;
}

/** Reads fields an old `chatParameters` blob saved as overrides; saved sampling values and switches yield nothing. */
export function legacyChatParameterOverrides(chatParameters: unknown): ChatParameterOverrides {
  const source = parseRecord(chatParameters);
  const overrides: ChatParameterOverrides = {};
  if (!source) return overrides;
  for (const key of ["assistantPrefill", "assistantReasoningPrefill", "customThinkingTags"] as const) {
    if (!hasOwn(source, key)) continue;
    const value = OFF_CAPABLE_VALUE_SCHEMAS[key].safeParse(source[key]);
    if (value.success) (overrides as Record<string, unknown>)[key] = { mode: "override", value: value.data };
  }
  if (typeof source.strictRoleFormatting === "boolean" || typeof source.singleUserMessage === "boolean") {
    overrides.postProcessing = {
      mode: "override",
      value: {
        strictRoleFormatting: typeof source.strictRoleFormatting === "boolean" ? source.strictRoleFormatting : true,
        singleUserMessage: typeof source.singleUserMessage === "boolean" ? source.singleUserMessage : false,
      },
    };
  }
  if (hasOwn(source, "serviceTier")) {
    const value = serviceTierSchema.safeParse(source.serviceTier);
    if (value.success) overrides.serviceTier = { mode: "override", value: value.data };
  }
  const managedSource = parseRecord(source.managedCustomParameters);
  if (managedSource && typeof source.managedCustomParameters !== "string") {
    const managed: Record<string, ChatParameterOverride<number>> = {};
    for (const [id, entry] of Object.entries(managedSource)) {
      const record = parseRecord(entry);
      if (isUnsafeKey(id) || !record || typeof record.enabled !== "boolean") continue;
      const value = managedValueSchema.safeParse(record.value);
      if (!value.success) continue;
      managed[id] = record.enabled ? { mode: "override", value: value.data } : { mode: "off" };
    }
    if (Object.keys(managed).length > 0) overrides.managed = managed;
  }
  return overrides;
}

/** The chat's overrides: explicit entries win over ones read from an old `chatParameters` blob. */
export function effectiveChatParameterOverrides(
  chatParameters: unknown,
  chatParameterOverrides: unknown,
): ChatParameterOverrides {
  const legacy = legacyChatParameterOverrides(chatParameters);
  const explicit = parseChatParameterOverrides(chatParameterOverrides);
  const managed = legacy.managed || explicit.managed ? { ...legacy.managed, ...explicit.managed } : undefined;
  return { ...legacy, ...explicit, ...(managed ? { managed } : {}) };
}

/** Old `chatParameters` without sampling values and switches; profiles and wizard defaults keep the rest for conversion. */
export function stripChatSamplerParameters(raw: unknown): Record<string, unknown> | null {
  const source = parseRecord(raw);
  if (!source) return null;
  const kept = Object.fromEntries(Object.entries(source).filter(([key]) => !LEGACY_SAMPLER_KEYS.includes(key)));
  return Object.keys(kept).length > 0 ? kept : null;
}

/** `chatParameters` with every field that overrides replace removed; Custom Parameters and unrelated keys stay. */
export function stripLegacyChatParameters(raw: unknown): Record<string, unknown> | null {
  const kept = stripChatSamplerParameters(raw);
  if (!kept) return null;
  for (const key of LEGACY_CONVERTED_KEYS) delete kept[key];
  return Object.keys(kept).length > 0 ? kept : null;
}

/** Stored-parameter shape of the overrides, for the layer merges: Override sends its value, Off sends nothing. */
export function chatOverridesAsStoredParameters(overrides: ChatParameterOverrides): Partial<GenerationParameters> {
  const stored: Partial<GenerationParameters> = {};
  const enabledParameters: GenerationParameterSendMap = {};
  for (const key of GENERATION_PARAMETER_SEND_KEYS) {
    const override = overrides[key];
    if (!override) continue;
    enabledParameters[key] = override.mode === "override";
    if (override.mode === "override") (stored as Record<string, unknown>)[key] = override.value;
  }
  if (Object.keys(enabledParameters).length > 0) stored.enabledParameters = enabledParameters;
  if (overrides.assistantPrefill) {
    stored.assistantPrefill = overrides.assistantPrefill.mode === "override" ? overrides.assistantPrefill.value : "";
  }
  if (overrides.assistantReasoningPrefill) {
    stored.assistantReasoningPrefill =
      overrides.assistantReasoningPrefill.mode === "override" ? overrides.assistantReasoningPrefill.value : "";
  }
  if (overrides.customThinkingTags) {
    stored.customThinkingTags =
      overrides.customThinkingTags.mode === "override" ? overrides.customThinkingTags.value : [];
  }
  if (overrides.postProcessing) {
    stored.strictRoleFormatting = overrides.postProcessing.value.strictRoleFormatting;
    stored.singleUserMessage = overrides.postProcessing.value.singleUserMessage;
  }
  if (overrides.serviceTier) stored.serviceTier = overrides.serviceTier.value;
  if (overrides.managed) {
    const managed: ManagedGenerationParameterValueMap = {};
    for (const [id, override] of Object.entries(overrides.managed)) {
      managed[id] =
        override.mode === "override" ? { enabled: true, value: override.value } : { enabled: false, value: 0 };
    }
    stored.managedCustomParameters = managed;
  }
  return stored;
}

export interface GenerationParameterBaselineEntry<T> {
  value: T;
  sent: boolean;
  source: ParameterTraceLayer;
  /** Why the parameter would not be sent, when `sent` is false. */
  notSentBy: ParameterTraceLayer | "suppressed" | null;
}

export interface GenerationParameterBaselineField<T> {
  value: T;
  source: ParameterTraceLayer;
}

/** What the layers below a chat resolve to, shown in the chat's Connection state. */
export interface GenerationParameterBaseline {
  connection: {
    kind: "connection" | "local_sidecar" | "random" | "none";
    id: string | null;
    provider: string | null;
    model: string | null;
  };
  mode: string;
  scene: boolean;
  suppressModelParameters: boolean;
  /** Null when no single connection applies (random pool or none). */
  parameters:
    | {
        [K in GenerationParameterSendKey]: GenerationParameterBaselineEntry<GenerationParameters[K] | null>;
      }
    | null;
  fields: {
    assistantPrefill: GenerationParameterBaselineField<string>;
    assistantReasoningPrefill: GenerationParameterBaselineField<string>;
    customThinkingTags: GenerationParameterBaselineField<ThinkingTagPair[]>;
    postProcessing: GenerationParameterBaselineField<ChatPostProcessing>;
    serviceTier: GenerationParameterBaselineField<GenerationParameters["serviceTier"]>;
  } | null;
  managed: Record<string, { enabled: boolean; value: number; source: ParameterTraceLayer }> | null;
  customParameters: Record<string, unknown> | null;
}
