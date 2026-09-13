import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  GENERATION_PARAMETER_SEND_KEYS,
  customRequestHeadersSchema,
  normalizeThinkingTagPairs,
  type ChatParameterOverride,
  type ChatParameterOverrides,
  type ChatPostProcessing,
  type GenerationParameterBaseline,
  type GenerationParameterSendKey,
  type GenerationParameterSendMap,
  type GenerationParameters,
  type ManagedGenerationParameterDefinition,
  type ParameterTraceLayer,
  type ThinkingTagPair,
} from "@marinara-engine/shared";
import { cn } from "../../lib/utils";
import { ParameterSourceControl, type ParameterSource } from "./ParameterSourceControl";
import { SettingsSwitch } from "../panels/settings/SettingControls";
import { MacroTextarea, type MacroTextareaProps } from "./MacroTextarea";
import { HelpTooltip } from "./HelpTooltip";
import { parseGenerationParameterDraft } from "../../lib/generation-parameter-draft";
import { parseCustomParametersDraft } from "../../lib/generation-custom-parameters";
import { useTranslation as useUiTranslation } from "react-i18next";
import { useCustomGenerationParameters } from "../../hooks/use-custom-generation-parameters";

export type EditableGenerationParameters = Pick<
  GenerationParameters,
  | "temperature"
  | "maxTokens"
  | "topP"
  | "topK"
  | "frequencyPenalty"
  | "presencePenalty"
  | "reasoningEffort"
  | "verbosity"
  | "serviceTier"
  | "strictRoleFormatting"
  | "singleUserMessage"
  | "assistantPrefill"
  | "assistantReasoningPrefill"
  | "customThinkingTags"
  | "customParameters"
  | "customHeaders"
  | "managedCustomParameters"
  | "enabledParameters"
>;

type EditableGenerationParameterOverrides = Partial<EditableGenerationParameters>;

const REASONING_LEVELS = [null, "low", "medium", "high", "xhigh", "maximum"] as const;
const VERBOSITY_LEVELS = [null, "low", "medium", "high"] as const;
const SERVICE_TIERS = [null, "flex", "priority"] as const;
const THINKING_TAG_CONTENT_PLACEHOLDER = "{{thinking}}";
const PARAM_CHOICE_ACTIVE_CLASS = "bg-[var(--primary)]/15 text-[var(--primary)] ring-1 ring-[var(--primary)]/30";
const PARAM_CHOICE_IDLE_CLASS =
  "bg-[var(--secondary)] text-[var(--muted-foreground)] ring-1 ring-[var(--border)] hover:bg-[var(--accent)]";
const PARAM_TEXTAREA_CLASS =
  "mari-chrome-field mt-1 w-full !rounded-md px-3 py-2 pr-8 text-xs leading-relaxed [text-indent:0] placeholder:[text-indent:0]";

const LEGACY_PARAMETER_SEND_DEFAULTS: GenerationParameterSendMap = Object.fromEntries(
  GENERATION_PARAMETER_SEND_KEYS.map((key) => [key, true]),
) as GenerationParameterSendMap;

export const STRICT_CONNECTION_PARAMETER_SEND_DEFAULTS: GenerationParameterSendMap = {
  temperature: false,
  maxTokens: true,
  topP: false,
  topK: false,
  frequencyPenalty: false,
  presencePenalty: false,
  reasoningEffort: true,
  verbosity: false,
};

export const CHAT_PARAMETER_DEFAULTS: EditableGenerationParameters = {
  temperature: 1,
  maxTokens: 4096,
  topP: 1,
  topK: 0,
  frequencyPenalty: 0,
  presencePenalty: 0,
  reasoningEffort: "maximum",
  verbosity: "high",
  serviceTier: null,
  strictRoleFormatting: true,
  singleUserMessage: false,
  assistantPrefill: "",
  assistantReasoningPrefill: "",
  customThinkingTags: [],
  customParameters: {},
  managedCustomParameters: {},
  enabledParameters: LEGACY_PARAMETER_SEND_DEFAULTS,
};

export const ROLEPLAY_PARAMETER_DEFAULTS: EditableGenerationParameters = {
  temperature: 1,
  maxTokens: 8192,
  topP: 1,
  topK: 0,
  frequencyPenalty: 0,
  presencePenalty: 0,
  reasoningEffort: "maximum",
  verbosity: "high",
  serviceTier: null,
  strictRoleFormatting: true,
  singleUserMessage: false,
  assistantPrefill: "",
  assistantReasoningPrefill: "",
  customThinkingTags: [],
  customParameters: {},
  managedCustomParameters: {},
  enabledParameters: LEGACY_PARAMETER_SEND_DEFAULTS,
};

export const CONNECTION_PARAMETER_DEFAULTS: EditableGenerationParameters = {
  ...ROLEPLAY_PARAMETER_DEFAULTS,
  enabledParameters: STRICT_CONNECTION_PARAMETER_SEND_DEFAULTS,
};

function normalizeEnabledParameters(source: unknown): GenerationParameterSendMap | undefined {
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const record = source as Record<string, unknown>;
  const result: GenerationParameterSendMap = {};
  for (const key of GENERATION_PARAMETER_SEND_KEYS) {
    if (typeof record[key] === "boolean") result[key] = record[key] as boolean;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeEnabledParameters(
  defaults: GenerationParameterSendMap | undefined,
  overrides: GenerationParameterSendMap | undefined,
): GenerationParameterSendMap | undefined {
  if (!defaults && !overrides) return undefined;
  return { ...(defaults ?? {}), ...(overrides ?? {}) };
}

export function parseEditableGenerationParameters(raw: unknown): EditableGenerationParameterOverrides | null {
  let parsed = raw;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") return null;

  const source = parsed as Record<string, unknown>;
  const next: EditableGenerationParameterOverrides = {};

  if (typeof source.temperature === "number") next.temperature = source.temperature;
  if (typeof source.maxTokens === "number") next.maxTokens = source.maxTokens;
  if (typeof source.topP === "number") next.topP = source.topP;
  if (typeof source.topK === "number") next.topK = source.topK;
  if (typeof source.frequencyPenalty === "number") next.frequencyPenalty = source.frequencyPenalty;
  if (typeof source.presencePenalty === "number") next.presencePenalty = source.presencePenalty;
  if (
    source.reasoningEffort === null ||
    source.reasoningEffort === "low" ||
    source.reasoningEffort === "medium" ||
    source.reasoningEffort === "high" ||
    source.reasoningEffort === "xhigh" ||
    source.reasoningEffort === "maximum"
  ) {
    next.reasoningEffort = source.reasoningEffort;
  }
  if (
    source.verbosity === null ||
    source.verbosity === "low" ||
    source.verbosity === "medium" ||
    source.verbosity === "high"
  ) {
    next.verbosity = source.verbosity;
  }
  if (source.serviceTier === null || source.serviceTier === "flex" || source.serviceTier === "priority") {
    next.serviceTier = source.serviceTier;
  }
  if (typeof source.strictRoleFormatting === "boolean") next.strictRoleFormatting = source.strictRoleFormatting;
  if (typeof source.singleUserMessage === "boolean") next.singleUserMessage = source.singleUserMessage;
  if (source.customHeaders !== undefined) {
    const headers = customRequestHeadersSchema.safeParse(source.customHeaders);
    if (headers.success) next.customHeaders = headers.data;
  }
  if (typeof source.assistantPrefill === "string") {
    next.assistantPrefill = source.assistantPrefill;
  }
  if (typeof source.assistantReasoningPrefill === "string") {
    next.assistantReasoningPrefill = source.assistantReasoningPrefill;
  }
  if (Array.isArray(source.customThinkingTags)) {
    next.customThinkingTags = normalizeThinkingTagPairs(source.customThinkingTags);
  }
  if (
    source.customParameters &&
    typeof source.customParameters === "object" &&
    !Array.isArray(source.customParameters) &&
    Object.keys(source.customParameters).length > 0
  ) {
    next.customParameters = source.customParameters as Record<string, unknown>;
  }
  if (
    source.managedCustomParameters &&
    typeof source.managedCustomParameters === "object" &&
    !Array.isArray(source.managedCustomParameters)
  ) {
    const managedValues = Object.fromEntries(
      Object.entries(source.managedCustomParameters as Record<string, unknown>).flatMap(([id, candidate]) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
        const record = candidate as Record<string, unknown>;
        if (typeof record.enabled !== "boolean" || typeof record.value !== "number" || !Number.isFinite(record.value)) {
          return [];
        }
        return [[id, { enabled: record.enabled, value: record.value }]];
      }),
    );
    if (Object.keys(managedValues).length > 0) next.managedCustomParameters = managedValues;
  }
  const enabledParameters = normalizeEnabledParameters(source.enabledParameters);
  if (enabledParameters) next.enabledParameters = enabledParameters;

  return Object.keys(next).length > 0 ? next : null;
}

export function getEditableGenerationParameters(
  defaults: EditableGenerationParameters,
  overrides: unknown,
): EditableGenerationParameters {
  const parsed = parseEditableGenerationParameters(overrides) ?? {};
  return {
    ...defaults,
    ...parsed,
    enabledParameters: mergeEnabledParameters(defaults.enabledParameters, parsed.enabledParameters),
  };
}

export function GenerationParametersFields({
  value,
  onChange,
  showServiceTier = false,
  showCustomHeaders = false,
  enabledParametersFallback = LEGACY_PARAMETER_SEND_DEFAULTS,
}: {
  value: EditableGenerationParameters;
  onChange: (next: EditableGenerationParameters) => void;
  showServiceTier?: boolean;
  showCustomHeaders?: boolean;
  enabledParametersFallback?: GenerationParameterSendMap;
}) {
  const { t: localizeUi } = useUiTranslation();
  const { data: managedDefinitions = [] } = useCustomGenerationParameters();
  const set = <K extends keyof EditableGenerationParameters>(key: K, nextValue: EditableGenerationParameters[K]) => {
    onChange({ ...value, [key]: nextValue });
  };
  const setSend = (key: GenerationParameterSendKey, enabled: boolean) => {
    onChange({
      ...value,
      enabledParameters: { ...enabledParametersFallback, ...(value.enabledParameters ?? {}), [key]: enabled },
    });
  };
  const isSendEnabled = (key: GenerationParameterSendKey) =>
    (value.enabledParameters ?? enabledParametersFallback)[key] !== false;
  const setManagedParameter = (
    definition: ManagedGenerationParameterDefinition,
    patch: Partial<{ enabled: boolean; value: number }>,
  ) => {
    const current = value.managedCustomParameters[definition.id] ?? {
      enabled: false,
      value: definition.min,
    };
    set("managedCustomParameters", {
      ...value.managedCustomParameters,
      [definition.id]: { ...current, ...patch },
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <ParamInput
          label={localizeUi("ui.ui.generationparametersfields.temperature")}
          help={localizeUi("ui.ui.generationparametersfields.controlsRandomnessLowerValuesMakeOutputMoreFocusedAnd")}
          value={value.temperature}
          onChange={(nextValue) => set("temperature", nextValue)}
          sendEnabled={isSendEnabled("temperature")}
          onSendChange={(enabled) => setSend("temperature", enabled)}
          min={0}
          max={2}
          step={0.05}
        />
        <ParamInput
          label={localizeUi("ui.agents.agenteditor.maxOutputTokens")}
          help={localizeUi("ui.ui.generationparametersfields.theMaximumNumberOfTokensTheModelCanGenerate")}
          value={value.maxTokens}
          onChange={(nextValue) => set("maxTokens", nextValue)}
          sendEnabled={isSendEnabled("maxTokens")}
          onSendChange={(enabled) => setSend("maxTokens", enabled)}
          min={1}
          step={256}
        />
        <ParamInput
          label={localizeUi("ui.ui.generationparametersfields.topP")}
          help={localizeUi(
            "ui.ui.generationparametersfields.nucleusSamplingOnlyConsidersTokensWhoseCumulativeProbabilityReaches",
          )}
          value={value.topP}
          onChange={(nextValue) => set("topP", nextValue)}
          sendEnabled={isSendEnabled("topP")}
          onSendChange={(enabled) => setSend("topP", enabled)}
          min={0}
          max={1}
          step={0.05}
        />
        <ParamInput
          label={localizeUi("ui.ui.generationparametersfields.topK")}
          help={localizeUi("ui.ui.generationparametersfields.limitsTheModelToOnlyConsiderTheTopK")}
          value={value.topK}
          onChange={(nextValue) => set("topK", nextValue)}
          sendEnabled={isSendEnabled("topK")}
          onSendChange={(enabled) => setSend("topK", enabled)}
          min={0}
          max={500}
          step={1}
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <ParamInput
          label={localizeUi("ui.ui.generationparametersfields.frequency")}
          help={localizeUi("ui.ui.generationparametersfields.penalizesTokensBasedOnHowOftenTheyVeAlready")}
          value={value.frequencyPenalty}
          onChange={(nextValue) => set("frequencyPenalty", nextValue)}
          sendEnabled={isSendEnabled("frequencyPenalty")}
          onSendChange={(enabled) => setSend("frequencyPenalty", enabled)}
          min={-2}
          max={2}
          step={0.05}
        />
        <ParamInput
          label={localizeUi("ui.ui.generationparametersfields.presence")}
          help={localizeUi("ui.ui.generationparametersfields.penalizesTokensThatHaveAppearedAtAllRegardlessOf")}
          value={value.presencePenalty}
          onChange={(nextValue) => set("presencePenalty", nextValue)}
          sendEnabled={isSendEnabled("presencePenalty")}
          onSendChange={(enabled) => setSend("presencePenalty", enabled)}
          min={-2}
          max={2}
          step={0.05}
        />
      </div>
      {managedDefinitions.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {managedDefinitions.map((definition) => {
            const stored = value.managedCustomParameters[definition.id];
            return (
              <ParamInput
                key={definition.id}
                label={definition.name}
                help={definition.tooltip}
                value={stored?.value ?? definition.min}
                onChange={(nextValue) => setManagedParameter(definition, { value: nextValue })}
                sendEnabled={stored?.enabled === true}
                onSendChange={(enabled) => setManagedParameter(definition, { enabled })}
                min={definition.min}
                max={definition.max}
                step={Math.max(0.001, Math.min(1, (definition.max - definition.min) / 100))}
              />
            );
          })}
        </div>
      )}
      <div className="space-y-2">
        <div className="text-[0.625rem] font-medium text-[var(--muted-foreground)]">
          <span className="inline-flex items-center gap-1">
            {localizeUi("settings.generation.postProcessing.label")}
            <HelpTooltip text={localizeUi("settings.generation.postProcessing.help")} size="0.625rem" />
          </span>
          <select
            aria-label={localizeUi("settings.generation.postProcessing.label")}
            className="mari-chrome-field mt-1 w-full rounded-md px-3 py-2 text-xs"
            value={value.singleUserMessage ? "single" : value.strictRoleFormatting ? "apply" : "none"}
            onChange={(event) =>
              onChange({
                ...value,
                strictRoleFormatting: event.target.value === "apply",
                singleUserMessage: event.target.value === "single",
              })
            }
          >
            <option value="apply">{localizeUi("settings.generation.postProcessing.apply")}</option>
            <option value="none">{localizeUi("settings.generation.postProcessing.none")}</option>
            <option value="single">{localizeUi("settings.generation.postProcessing.single")}</option>
          </select>
        </div>
        <div>
          <span className="inline-flex items-center gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
            {localizeUi("ui.ui.generationparametersfields.assistantPrefill")}
            <HelpTooltip
              text={localizeUi("ui.ui.generationparametersfields.optionalAssistantRoleTextAppendedAfterTheFinalUser")}
              size="0.625rem"
            />
          </span>
          <DraftMacroTextarea
            value={value.assistantPrefill ?? ""}
            onCommit={(nextValue) => set("assistantPrefill", nextValue)}
            rows={3}
            title={localizeUi("ui.ui.generationparametersfields.assistantPrefill")}
            className={PARAM_TEXTAREA_CLASS}
            placeholder={localizeUi("ui.ui.generationparametersfields.thinking", {
              value1: "<",
              value2: ">",
            }).trimStart()}
          />
        </div>
        <div>
          <span className="inline-flex items-center gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
            {localizeUi("ui.ui.generationparametersfields.assistantReasoningPrefill")}
            <HelpTooltip
              text={localizeUi("ui.ui.generationparametersfields.optionalReasoningContentOnTheFinalAssistantMessage")}
              size="0.625rem"
            />
          </span>
          <DraftMacroTextarea
            value={value.assistantReasoningPrefill ?? ""}
            onCommit={(nextValue) => set("assistantReasoningPrefill", nextValue)}
            rows={3}
            title={localizeUi("ui.ui.generationparametersfields.assistantReasoningPrefill")}
            className={PARAM_TEXTAREA_CLASS}
            placeholder={localizeUi("generationParameters.assistantReasoningPrefill.placeholder")}
          />
        </div>
        <ThinkingTagsInput
          value={value.customThinkingTags}
          onChange={(nextValue) => set("customThinkingTags", nextValue)}
        />
        <CustomParametersInput
          value={value.customParameters}
          onChange={(nextValue) => set("customParameters", nextValue)}
        />
        {showCustomHeaders && (
          <CustomParametersInput
            headers
            value={value.customHeaders ?? {}}
            onChange={(nextValue) => set("customHeaders", nextValue as Record<string, string>)}
          />
        )}
        {showServiceTier && (
          <div>
            <span className="inline-flex items-center gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
              {localizeUi("settings.generation.serviceTier.label")}
              <HelpTooltip text={localizeUi("settings.generation.serviceTier.help")} size="0.625rem" />
            </span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {SERVICE_TIERS.map((tier) => (
                <button
                  key={tier ?? "default"}
                  type="button"
                  onClick={() => set("serviceTier", tier)}
                  aria-pressed={value.serviceTier === tier}
                  className={cn(
                    "rounded-md px-2 py-1 text-[0.625rem] font-medium transition-all",
                    value.serviceTier === tier ? PARAM_CHOICE_ACTIVE_CLASS : PARAM_CHOICE_IDLE_CLASS,
                  )}
                >
                  {tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : localizeUi("ui.noodle.noodlehome.default")}
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <ParameterHeader
            label={localizeUi("ui.ui.generationparametersfields.reasoningEffort")}
            help={localizeUi("ui.ui.generationparametersfields.howMuchReasoningWorkTheProviderShouldSpendBefore")}
            sendEnabled={isSendEnabled("reasoningEffort")}
            onSendChange={(enabled) => setSend("reasoningEffort", enabled)}
          />
          <div className="mt-1 flex flex-wrap gap-1.5">
            {REASONING_LEVELS.map((level) => (
              <button
                key={level ?? "none"}
                type="button"
                onClick={() => set("reasoningEffort", level)}
                aria-pressed={value.reasoningEffort === level}
                className={cn(
                  "rounded-md px-2 py-1 text-[0.625rem] font-medium transition-all",
                  value.reasoningEffort === level ? PARAM_CHOICE_ACTIVE_CLASS : PARAM_CHOICE_IDLE_CLASS,
                )}
              >
                {level
                  ? level.charAt(0).toUpperCase() + level.slice(1)
                  : localizeUi("ui.ui.generationparametersfields.reasoningOff")}
              </button>
            ))}
          </div>
        </div>
        <div>
          <ParameterHeader
            label={localizeUi("ui.ui.generationparametersfields.verbosity")}
            help={localizeUi("ui.ui.generationparametersfields.controlsHowLongAndDetailedResponsesShouldBeLow")}
            sendEnabled={isSendEnabled("verbosity")}
            onSendChange={(enabled) => setSend("verbosity", enabled)}
          />
          <div className="mt-1 flex flex-wrap gap-1.5">
            {VERBOSITY_LEVELS.map((level) => (
              <button
                key={level ?? "none"}
                type="button"
                onClick={() => set("verbosity", level)}
                aria-pressed={value.verbosity === level}
                className={cn(
                  "rounded-md px-2 py-1 text-[0.625rem] font-medium transition-all",
                  value.verbosity === level ? PARAM_CHOICE_ACTIVE_CLASS : PARAM_CHOICE_IDLE_CLASS,
                )}
              >
                {level
                  ? level.charAt(0).toUpperCase() + level.slice(1)
                  : localizeUi("ui.game.gamesurfacecomponent.none")}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface ChatParameterSources {
  overrides: ChatParameterOverrides;
  baseline: GenerationParameterBaseline | undefined;
  baselineLoading: boolean;
  onOverridesChange: (next: ChatParameterOverrides) => void;
}

const BASELINE_SOURCE_KEYS: Record<ParameterTraceLayer, string> = {
  default: "ui.ui.generationparametersfields.baselineAppDefault",
  preset: "ui.ui.generationparametersfields.baselineFromPreset",
  connection: "ui.ui.generationparametersfields.baselineFromConnection",
  chat: "ui.ui.generationparametersfields.baselineFromConnection",
  scene: "ui.ui.generationparametersfields.baselineScene",
  "game mode": "ui.ui.generationparametersfields.baselineGameMode",
  "model rule": "ui.ui.generationparametersfields.baselineModelRule",
  "agent rule": "ui.ui.generationparametersfields.baselineFromConnection",
  "agent settings": "ui.ui.generationparametersfields.baselineFromConnection",
};

type ChatNumberKey = "temperature" | "maxTokens" | "topP" | "topK" | "frequencyPenalty" | "presencePenalty";

/** What a locked field shows; a note is placeholder text, never a value. */
type LockedDisplay = { text: string; struck: boolean; note: boolean };

/** Where a layer below the chat would send `text`, `null` when nothing would be sent, `undefined` when unknown. */
type BelowChat = { text: string; source: ParameterTraceLayer } | null | undefined;

function sourceOf(override: { mode: "override" | "off" } | undefined): ParameterSource {
  return override?.mode ?? "connection";
}

function LockedParameterField({
  label,
  display,
  multiline = false,
}: {
  label: string;
  display: LockedDisplay;
  multiline?: boolean;
}) {
  const className = cn(
    multiline
      ? PARAM_TEXTAREA_CLASS
      : "mari-chrome-field mari-chrome-field--compact mt-0.5 w-full !rounded-md px-2.5 py-1.5 text-xs",
    display.note && "italic",
    display.struck && "line-through",
  );
  const text = display.note ? { value: "", placeholder: display.text } : { value: display.text };
  return multiline ? (
    <textarea disabled aria-label={label} title={display.text} rows={3} className={className} {...text} />
  ) : (
    <input type="text" disabled aria-label={label} title={display.text} className={className} {...text} />
  );
}

function FieldLabel({ label, help }: { label: string; help?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
      {label}
      {help && <HelpTooltip text={help} size="0.625rem" />}
    </span>
  );
}

/**
 * A chat's Advanced Parameters: each field follows the layers below the chat (Connection), sets its own value
 * (Override), or sends nothing (Off). Locked fields show the value those layers would send and where it comes from.
 */
export function ChatGenerationParametersFields({
  value,
  onChange,
  sources,
  showServiceTier = false,
}: {
  /** Start values for fields switched to Override, and the chat's own Custom Parameters. */
  value: EditableGenerationParameters;
  onChange: (next: EditableGenerationParameters) => void;
  sources: ChatParameterSources;
  showServiceTier?: boolean;
}) {
  const { t: localizeUi } = useUiTranslation();
  const { data: managedDefinitions = [] } = useCustomGenerationParameters();
  const { overrides, baseline, baselineLoading, onOverridesChange } = sources;

  const setOverride = (key: keyof ChatParameterOverrides, next: unknown) => {
    const updated = { ...overrides } as Record<string, unknown>;
    if (next === undefined) delete updated[key];
    else updated[key] = next;
    onOverridesChange(updated as ChatParameterOverrides);
  };
  const setManaged = (id: string, next: ChatParameterOverride<number> | undefined) => {
    const managed = { ...overrides.managed };
    if (next === undefined) delete managed[id];
    else managed[id] = next;
    setOverride("managed", Object.keys(managed).length > 0 ? managed : undefined);
  };

  const unavailableNote = () =>
    localizeUi(
      baselineLoading
        ? "ui.ui.generationparametersfields.baselineLoading"
        : baseline?.connection.kind === "random"
          ? "ui.ui.generationparametersfields.baselineRandomPool"
          : "ui.ui.generationparametersfields.baselineNoConnection",
    );
  const note = (text: string): LockedDisplay => ({ text, struck: false, note: true });
  const notSentByConnection = localizeUi("ui.ui.generationparametersfields.baselineNotSentByConnection");
  // Off strikes through only a value that would really be sent; with nothing to withhold it says so instead.
  const lockedDisplay = (source: ParameterSource, below: BelowChat, notSentText: string): LockedDisplay => {
    if (below === undefined) return note(unavailableNote());
    if (source === "off") {
      return below
        ? { text: below.text, struck: true, note: false }
        : note(localizeUi("ui.ui.generationparametersfields.baselineNotSentInChat"));
    }
    return below
      ? { text: localizeUi(BASELINE_SOURCE_KEYS[below.source], { value: below.text }), struck: false, note: false }
      : note(notSentText);
  };
  const sendKeyBelow = (key: GenerationParameterSendKey): BelowChat => {
    const entry = baseline?.parameters?.[key];
    if (!entry) return undefined;
    return entry.sent && entry.value !== null ? { text: String(entry.value), source: entry.source } : null;
  };
  const sendKeyNotSent = (key: GenerationParameterSendKey) => {
    const notSentBy = baseline?.parameters?.[key]?.notSentBy;
    return notSentBy === "suppressed" || notSentBy === "model rule"
      ? localizeUi("ui.ui.generationparametersfields.baselineNotSentForModel")
      : notSentByConnection;
  };

  const numberRows: Array<{
    key: ChatNumberKey;
    label: string;
    help: string;
    min: number;
    max?: number;
    step: number;
  }> = [
    {
      key: "temperature",
      label: localizeUi("ui.ui.generationparametersfields.temperature"),
      help: localizeUi("ui.ui.generationparametersfields.controlsRandomnessLowerValuesMakeOutputMoreFocusedAnd"),
      min: 0,
      max: 2,
      step: 0.05,
    },
    {
      key: "maxTokens",
      label: localizeUi("ui.agents.agenteditor.maxOutputTokens"),
      help: localizeUi("ui.ui.generationparametersfields.theMaximumNumberOfTokensTheModelCanGenerate"),
      min: 1,
      step: 256,
    },
    {
      key: "topP",
      label: localizeUi("ui.ui.generationparametersfields.topP"),
      help: localizeUi(
        "ui.ui.generationparametersfields.nucleusSamplingOnlyConsidersTokensWhoseCumulativeProbabilityReaches",
      ),
      min: 0,
      max: 1,
      step: 0.05,
    },
    {
      key: "topK",
      label: localizeUi("ui.ui.generationparametersfields.topK"),
      help: localizeUi("ui.ui.generationparametersfields.limitsTheModelToOnlyConsiderTheTopK"),
      min: 0,
      max: 500,
      step: 1,
    },
    {
      key: "frequencyPenalty",
      label: localizeUi("ui.ui.generationparametersfields.frequency"),
      help: localizeUi("ui.ui.generationparametersfields.penalizesTokensBasedOnHowOftenTheyVeAlready"),
      min: -2,
      max: 2,
      step: 0.05,
    },
    {
      key: "presencePenalty",
      label: localizeUi("ui.ui.generationparametersfields.presence"),
      help: localizeUi("ui.ui.generationparametersfields.penalizesTokensThatHaveAppearedAtAllRegardlessOf"),
      min: -2,
      max: 2,
      step: 0.05,
    },
  ];

  const renderChoiceRow = <K extends "reasoningEffort" | "verbosity">(
    key: K,
    label: string,
    help: string,
    levels: ReadonlyArray<EditableGenerationParameters[K]>,
    levelLabel: (level: EditableGenerationParameters[K]) => string,
  ) => {
    const override = overrides[key] as ChatParameterOverride<EditableGenerationParameters[K]> | undefined;
    const source = sourceOf(override);
    const entry = baseline?.parameters?.[key];
    const selected = override?.mode === "override" ? override.value : entry?.sent ? entry.value : undefined;
    const locked = override?.mode !== "override";
    return (
      <div>
        <ParameterHeader label={label} help={help} />
        <ParameterSourceControl
          label={label}
          value={source}
          onChange={(next) =>
            setOverride(
              key,
              next === "connection"
                ? undefined
                : next === "off"
                  ? { mode: "off" }
                  : { mode: "override", value: entry ? entry.value : value[key] },
            )
          }
        />
        <div className={cn("mt-1 flex flex-wrap gap-1.5", locked && "opacity-50")}>
          {levels.map((level) => {
            const pressed = selected !== undefined && selected === level;
            return (
              <button
                key={level ?? "none"}
                type="button"
                disabled={locked}
                onClick={() => setOverride(key, { mode: "override", value: level })}
                aria-pressed={pressed}
                className={cn(
                  "rounded-md px-2 py-1 text-[0.625rem] font-medium transition-all disabled:cursor-not-allowed",
                  pressed ? PARAM_CHOICE_ACTIVE_CLASS : PARAM_CHOICE_IDLE_CLASS,
                  pressed && source === "off" && "line-through",
                )}
              >
                {levelLabel(level)}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const renderPrefillRow = (
    key: "assistantPrefill" | "assistantReasoningPrefill",
    label: string,
    help: string,
    placeholder: string,
  ) => {
    const override = overrides[key];
    const source = sourceOf(override);
    const field = baseline?.fields?.[key];
    const below: BelowChat = baseline?.fields
      ? field?.value
        ? { text: field.value, source: field.source }
        : null
      : undefined;
    return (
      <div>
        <FieldLabel label={label} help={help} />
        <ParameterSourceControl
          label={label}
          value={source}
          onChange={(next) =>
            setOverride(
              key,
              next === "connection"
                ? undefined
                : next === "off"
                  ? { mode: "off" }
                  : { mode: "override", value: field?.value ?? value[key] ?? "" },
            )
          }
        />
        {override?.mode === "override" ? (
          <DraftMacroTextarea
            value={override.value}
            onCommit={(nextValue) => setOverride(key, { mode: "override", value: nextValue })}
            rows={3}
            title={label}
            className={PARAM_TEXTAREA_CLASS}
            placeholder={placeholder}
          />
        ) : (
          <LockedParameterField multiline label={label} display={lockedDisplay(source, below, notSentByConnection)} />
        )}
      </div>
    );
  };

  const postProcessingLabel = localizeUi("settings.generation.postProcessing.label");
  const postProcessingOverride = overrides.postProcessing;
  const postProcessingBelow = baseline?.fields?.postProcessing;
  const postProcessingOption = (settings: ChatPostProcessing) =>
    settings.singleUserMessage ? "single" : settings.strictRoleFormatting ? "apply" : "none";

  const tagsLabel = localizeUi("ui.ui.thinkingtagsinput.thinkingTags");
  const tagsOverride = overrides.customThinkingTags;
  const tagsSource = sourceOf(tagsOverride);
  const tagsField = baseline?.fields?.customThinkingTags;
  const tagsBelow: BelowChat = baseline?.fields
    ? tagsField && tagsField.value.length > 0
      ? { text: stringifyThinkingTags(tagsField.value), source: tagsField.source }
      : null
    : undefined;
  const tagsControl = (
    <ParameterSourceControl
      label={tagsLabel}
      value={tagsSource}
      onChange={(next) =>
        setOverride(
          "customThinkingTags",
          next === "connection"
            ? undefined
            : next === "off"
              ? { mode: "off" }
              : { mode: "override", value: tagsField?.value ?? value.customThinkingTags },
        )
      }
    />
  );

  const tierOverride = overrides.serviceTier;
  const tierField = baseline?.fields?.serviceTier;
  const selectedTier = tierOverride ? tierOverride.value : tierField ? tierField.value : undefined;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {numberRows.map((row) => {
          const override = overrides[row.key] as ChatParameterOverride<number> | undefined;
          const source = sourceOf(override);
          const baselineValue = baseline?.parameters?.[row.key]?.value;
          return (
            <div key={row.key}>
              <ParameterHeader label={row.label} help={row.help} />
              <ParameterSourceControl
                label={row.label}
                value={source}
                onChange={(next) =>
                  setOverride(
                    row.key,
                    next === "connection"
                      ? undefined
                      : next === "off"
                        ? { mode: "off" }
                        : {
                            mode: "override",
                            value: typeof baselineValue === "number" ? baselineValue : value[row.key],
                          },
                  )
                }
              />
              {override?.mode === "override" ? (
                <ParamNumberField
                  label={row.label}
                  value={override.value}
                  onChange={(nextValue) => setOverride(row.key, { mode: "override", value: nextValue })}
                  min={row.min}
                  max={row.max}
                  step={row.step}
                />
              ) : (
                <LockedParameterField
                  label={row.label}
                  display={lockedDisplay(source, sendKeyBelow(row.key), sendKeyNotSent(row.key))}
                />
              )}
            </div>
          );
        })}
      </div>
      {managedDefinitions.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {managedDefinitions.map((definition) => {
            const override = overrides.managed?.[definition.id];
            const source = sourceOf(override);
            const entry = baseline?.managed?.[definition.id];
            const below: BelowChat = baseline?.managed
              ? entry?.enabled
                ? { text: String(entry.value), source: entry.source }
                : null
              : undefined;
            return (
              <div key={definition.id}>
                <ParameterHeader label={definition.name} help={definition.tooltip} />
                <ParameterSourceControl
                  label={definition.name}
                  value={source}
                  onChange={(next) =>
                    setManaged(
                      definition.id,
                      next === "connection"
                        ? undefined
                        : next === "off"
                          ? { mode: "off" }
                          : { mode: "override", value: entry?.value ?? definition.min },
                    )
                  }
                />
                {override?.mode === "override" ? (
                  <ParamNumberField
                    label={definition.name}
                    value={override.value}
                    onChange={(nextValue) => setManaged(definition.id, { mode: "override", value: nextValue })}
                    min={definition.min}
                    max={definition.max}
                    step={Math.max(0.001, Math.min(1, (definition.max - definition.min) / 100))}
                  />
                ) : (
                  <LockedParameterField
                    label={definition.name}
                    display={lockedDisplay(source, below, notSentByConnection)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="space-y-2">
        <div>
          <FieldLabel label={postProcessingLabel} help={localizeUi("settings.generation.postProcessing.help")} />
          <ParameterSourceControl
            label={postProcessingLabel}
            value={sourceOf(postProcessingOverride)}
            allowOff={false}
            onChange={(next) =>
              setOverride(
                "postProcessing",
                next === "override"
                  ? {
                      mode: "override",
                      value: postProcessingBelow?.value ?? {
                        strictRoleFormatting: value.strictRoleFormatting,
                        singleUserMessage: value.singleUserMessage,
                      },
                    }
                  : undefined,
              )
            }
          />
          {postProcessingOverride ? (
            <select
              aria-label={postProcessingLabel}
              className="mari-chrome-field mt-1 w-full rounded-md px-3 py-2 text-xs"
              value={postProcessingOption(postProcessingOverride.value)}
              onChange={(event) =>
                setOverride("postProcessing", {
                  mode: "override",
                  value: {
                    strictRoleFormatting: event.target.value === "apply",
                    singleUserMessage: event.target.value === "single",
                  },
                })
              }
            >
              <option value="apply">{localizeUi("settings.generation.postProcessing.apply")}</option>
              <option value="none">{localizeUi("settings.generation.postProcessing.none")}</option>
              <option value="single">{localizeUi("settings.generation.postProcessing.single")}</option>
            </select>
          ) : (
            <select
              aria-label={postProcessingLabel}
              disabled
              className="mari-chrome-field mt-1 w-full rounded-md px-3 py-2 text-xs"
              value="locked"
            >
              <option value="locked">
                {postProcessingBelow
                  ? localizeUi(BASELINE_SOURCE_KEYS[postProcessingBelow.source], {
                      value: localizeUi(
                        `settings.generation.postProcessing.${postProcessingOption(postProcessingBelow.value)}`,
                      ),
                    })
                  : unavailableNote()}
              </option>
            </select>
          )}
        </div>
        {renderPrefillRow(
          "assistantPrefill",
          localizeUi("ui.ui.generationparametersfields.assistantPrefill"),
          localizeUi("ui.ui.generationparametersfields.optionalAssistantRoleTextAppendedAfterTheFinalUser"),
          localizeUi("ui.ui.generationparametersfields.thinking", { value1: "<", value2: ">" }).trimStart(),
        )}
        {renderPrefillRow(
          "assistantReasoningPrefill",
          localizeUi("ui.ui.generationparametersfields.assistantReasoningPrefill"),
          localizeUi("ui.ui.generationparametersfields.optionalReasoningContentOnTheFinalAssistantMessage"),
          localizeUi("generationParameters.assistantReasoningPrefill.placeholder"),
        )}
        {tagsOverride?.mode === "override" ? (
          <ThinkingTagsInput
            value={tagsOverride.value}
            onChange={(nextValue) => setOverride("customThinkingTags", { mode: "override", value: nextValue })}
            sourceControl={tagsControl}
          />
        ) : (
          <div>
            <FieldLabel
              label={tagsLabel}
              help={localizeUi("ui.ui.thinkingtagsinput.thinkingMarksTheHiddenReasoningSlotAndWillBe")}
            />
            {tagsControl}
            <LockedParameterField
              multiline
              label={tagsLabel}
              display={lockedDisplay(tagsSource, tagsBelow, notSentByConnection)}
            />
          </div>
        )}
        {baseline?.customParameters && Object.keys(baseline.customParameters).length > 0 && (
          <div>
            <FieldLabel label={localizeUi("ui.ui.generationparametersfields.connectionCustomParameters")} />
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--secondary)] px-2.5 py-1.5 text-[0.625rem] text-[var(--muted-foreground)]">
              {stringifyCustomParameters(baseline.customParameters)}
            </pre>
          </div>
        )}
        <CustomParametersInput
          value={value.customParameters}
          onChange={(nextValue) => onChange({ ...value, customParameters: nextValue })}
        />
        {showServiceTier && (
          <div>
            <FieldLabel
              label={localizeUi("settings.generation.serviceTier.label")}
              help={localizeUi("settings.generation.serviceTier.help")}
            />
            <ParameterSourceControl
              label={localizeUi("settings.generation.serviceTier.label")}
              value={sourceOf(tierOverride)}
              allowOff={false}
              onChange={(next) =>
                setOverride(
                  "serviceTier",
                  next === "override" ? { mode: "override", value: tierField?.value ?? value.serviceTier } : undefined,
                )
              }
            />
            <div className={cn("mt-1 flex flex-wrap gap-1.5", !tierOverride && "opacity-50")}>
              {SERVICE_TIERS.map((tier) => (
                <button
                  key={tier ?? "default"}
                  type="button"
                  disabled={!tierOverride}
                  onClick={() => setOverride("serviceTier", { mode: "override", value: tier })}
                  aria-pressed={selectedTier === tier}
                  className={cn(
                    "rounded-md px-2 py-1 text-[0.625rem] font-medium transition-all disabled:cursor-not-allowed",
                    selectedTier === tier ? PARAM_CHOICE_ACTIVE_CLASS : PARAM_CHOICE_IDLE_CLASS,
                  )}
                >
                  {tier ? tier.charAt(0).toUpperCase() + tier.slice(1) : localizeUi("ui.noodle.noodlehome.default")}
                </button>
              ))}
            </div>
          </div>
        )}
        {renderChoiceRow(
          "reasoningEffort",
          localizeUi("ui.ui.generationparametersfields.reasoningEffort"),
          localizeUi("ui.ui.generationparametersfields.howMuchReasoningWorkTheProviderShouldSpendBefore"),
          REASONING_LEVELS,
          (level) =>
            level
              ? level.charAt(0).toUpperCase() + level.slice(1)
              : localizeUi("ui.ui.generationparametersfields.reasoningOff"),
        )}
        {renderChoiceRow(
          "verbosity",
          localizeUi("ui.ui.generationparametersfields.verbosity"),
          localizeUi("ui.ui.generationparametersfields.controlsHowLongAndDetailedResponsesShouldBeLow"),
          VERBOSITY_LEVELS,
          (level) =>
            level ? level.charAt(0).toUpperCase() + level.slice(1) : localizeUi("ui.game.gamesurfacecomponent.none"),
        )}
      </div>
    </div>
  );
}

function DraftMacroTextarea({
  value,
  onCommit,
  onFocus,
  onBlur,
  onExpandedClose,
  ...props
}: Omit<MacroTextareaProps, "value" | "onChange"> & {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const draftRef = useRef(draft);
  const valueRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  draftRef.current = draft;
  valueRef.current = value;
  onCommitRef.current = onCommit;

  useEffect(() => {
    if (!focused) setDraft(value);
  }, [focused, value]);

  const commit = () => {
    if (draftRef.current !== valueRef.current) onCommitRef.current(draftRef.current);
  };

  useEffect(
    () => () => {
      if (draftRef.current !== valueRef.current) onCommitRef.current(draftRef.current);
    },
    [],
  );

  return (
    <MacroTextarea
      {...props}
      value={draft}
      onChange={setDraft}
      onFocus={() => {
        setFocused(true);
        onFocus?.();
      }}
      onBlur={() => {
        commit();
        setFocused(false);
        onBlur?.();
      }}
      onExpandedClose={() => {
        commit();
        onExpandedClose?.();
      }}
    />
  );
}

function ThinkingTagsInput({
  value,
  onChange,
  sourceControl,
}: {
  value: ThinkingTagPair[];
  onChange: (next: ThinkingTagPair[]) => void;
  /** Rendered between the label and the field in a chat's Advanced Parameters. */
  sourceControl?: ReactNode;
}) {
  const { t: localizeUi } = useUiTranslation();
  const serialized = stringifyThinkingTags(value);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setDraft(serialized);
      setError(null);
    }
  }, [focused, serialized]);

  const commit = () => {
    const parsed = parseThinkingTagsDraft(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onChange(parsed.value);
    setDraft(stringifyThinkingTags(parsed.value));
  };

  return (
    <div>
      <span className="inline-flex items-center gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
        {localizeUi("ui.ui.thinkingtagsinput.thinkingTags")}
        <HelpTooltip
          text={localizeUi("ui.ui.thinkingtagsinput.thinkingMarksTheHiddenReasoningSlotAndWillBe")}
          size="0.625rem"
        />
      </span>
      {sourceControl}
      <MacroTextarea
        value={draft}
        onFocus={() => setFocused(true)}
        onChange={(nextValue) => {
          setDraft(nextValue);
          setError(null);
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onExpandedClose={commit}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        rows={2}
        spellCheck={false}
        title={localizeUi("ui.ui.thinkingtagsinput.thinkingTags")}
        ariaLabel={localizeUi("ui.ui.thinkingtagsinput.thinkingTags")}
        className={PARAM_TEXTAREA_CLASS}
        placeholder={
          focused
            ? ""
            : localizeUi("ui.ui.thinkingtagsinput.thinkingValue1Thinking", { value1: THINKING_TAG_CONTENT_PLACEHOLDER })
        }
      />
      {error ? (
        <p className="mt-1 text-[0.5625rem] text-amber-500">{error}</p>
      ) : (
        <p className="mt-1 text-[0.5625rem] text-[var(--muted-foreground)]/70">
          {localizeUi("ui.ui.thinkingtagsinput.oneWrapperPerLine")} {THINKING_TAG_CONTENT_PLACEHOLDER}{" "}
          {localizeUi("ui.ui.thinkingtagsinput.willBeReplacedByAnyContentBetweenTheSpecified")}
        </p>
      )}
    </div>
  );
}

function stringifyThinkingTags(value: ThinkingTagPair[] | null | undefined): string {
  const normalized = normalizeThinkingTagPairs(value);
  return normalized.map((pair) => `${pair.open}${THINKING_TAG_CONTENT_PLACEHOLDER}${pair.close}`).join("\n");
}

function parseThinkingTagsDraft(draft: string): { ok: true; value: ThinkingTagPair[] } | { ok: false; error: string } {
  const lines = draft
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { ok: true, value: [] };

  const pairs: ThinkingTagPair[] = [];
  for (const line of lines) {
    const separatorIndex = line.indexOf(THINKING_TAG_CONTENT_PLACEHOLDER);
    if (separatorIndex < 0) {
      return { ok: false, error: `Use ${THINKING_TAG_CONTENT_PLACEHOLDER} between opening and closing tags.` };
    }
    if (line.indexOf(THINKING_TAG_CONTENT_PLACEHOLDER, separatorIndex + THINKING_TAG_CONTENT_PLACEHOLDER.length) >= 0) {
      return { ok: false, error: `Use ${THINKING_TAG_CONTENT_PLACEHOLDER} only once per line.` };
    }
    const open = line.slice(0, separatorIndex).trim();
    const close = line.slice(separatorIndex + THINKING_TAG_CONTENT_PLACEHOLDER.length).trim();
    if (!open || !close) {
      return {
        ok: false,
        error: `Both opening and closing tags are required around ${THINKING_TAG_CONTENT_PLACEHOLDER}.`,
      };
    }
    pairs.push({ open, close });
  }

  return { ok: true, value: normalizeThinkingTagPairs(pairs) };
}

function CustomParametersInput({
  value,
  onChange,
  headers = false,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  headers?: boolean;
}) {
  const { t: localizeUi } = useUiTranslation();
  const serialized = stringifyCustomParameters(value);
  const [draft, setDraft] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const label = localizeUi(
    headers ? "settings.connection.customHeaders.label" : "ui.ui.customparametersinput.customParameters",
  );

  useEffect(() => {
    if (!focused && error === null) {
      setDraft(serialized);
    }
  }, [error, focused, serialized]);

  const commit = () => {
    const parsed = parseCustomParametersDraft(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (headers && !customRequestHeadersSchema.safeParse(parsed.value).success) {
      setError(localizeUi("settings.connection.customHeaders.invalid"));
      return;
    }
    setError(null);
    onChange(parsed.value);
    setDraft(stringifyCustomParameters(parsed.value));
  };

  return (
    <div>
      <span className="inline-flex items-center gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
        {label}
        <HelpTooltip
          text={localizeUi(
            headers
              ? "settings.connection.customHeaders.help"
              : "ui.ui.customparametersinput.optionalRawJsonObjectMergedIntoTheProviderRequest",
          )}
          size="0.625rem"
        />
      </span>
      <MacroTextarea
        value={draft}
        onFocus={() => setFocused(true)}
        onChange={(nextValue) => {
          setDraft(nextValue);
          setError(null);
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onExpandedClose={commit}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        rows={3}
        spellCheck={false}
        ariaInvalid={Boolean(error)}
        title={label}
        ariaLabel={label}
        className={PARAM_TEXTAREA_CLASS}
        placeholder={
          focused
            ? ""
            : localizeUi(
                headers
                  ? "settings.connection.customHeaders.example"
                  : "ui.ui.customparametersinput.reasoningEffortHigh",
              )
        }
      />
      {error ? (
        <p className="mt-1 text-[0.5625rem] text-amber-500">{error}</p>
      ) : (
        <p className="mt-1 text-[0.5625rem] text-[var(--muted-foreground)]/70">
          {localizeUi(
            headers
              ? "settings.connection.customHeaders.help"
              : "ui.ui.customparametersinput.acceptsStringsNumbersBooleansNullArraysAndNestedObjects",
          )}
        </p>
      )}
    </div>
  );
}

function stringifyCustomParameters(value: Record<string, unknown> | null | undefined): string {
  if (!value || Object.keys(value).length === 0) return "";
  return JSON.stringify(value, null, 2);
}

function ParamInput({
  label,
  value,
  onChange,
  sendEnabled,
  onSendChange,
  min,
  max,
  step,
  help,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  sendEnabled: boolean;
  onSendChange: (enabled: boolean) => void;
  min: number;
  max?: number;
  step: number;
  help?: string;
}) {
  return (
    <div>
      <ParameterHeader label={label} help={help} sendEnabled={sendEnabled} onSendChange={onSendChange} />
      <ParamNumberField label={label} value={value} onChange={onChange} min={min} max={max} step={step} />
    </div>
  );
}

function ParamNumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  min: number;
  max?: number;
  step: number;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(String(value));
    setError(null);
  }, [value]);

  const commit = () => {
    const nextValue = parseGenerationParameterDraft(draft);
    if (nextValue !== null && nextValue >= min && (max === undefined || nextValue <= max)) {
      onChange(nextValue);
      setDraft(String(nextValue));
      setError(null);
      return;
    }
    setError(
      max === undefined
        ? `Enter a value of ${min.toLocaleString()} or higher.`
        : `Enter a value from ${min.toLocaleString()} to ${max.toLocaleString()}.`,
    );
    setDraft(String(value));
  };

  return (
    <>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        min={min}
        {...(max === undefined ? {} : { max })}
        step={step}
        className="mari-chrome-field mari-chrome-field--compact mt-0.5 w-full !rounded-md px-2.5 py-1.5 text-xs"
      />
      {error && <p className="mt-1 text-[0.5625rem] text-amber-500">{error}</p>}
    </>
  );
}

function ParameterHeader({
  label,
  help,
  sendEnabled,
  onSendChange,
}: {
  label: string;
  help?: string;
  /** Omitted where a ParameterSourceControl decides whether the parameter is sent. */
  sendEnabled?: boolean;
  onSendChange?: (enabled: boolean) => void;
}) {
  const { t: localizeUi } = useUiTranslation();
  return (
    <div className="flex min-w-0 items-center justify-between gap-2">
      <span className="inline-flex min-w-0 items-center gap-1 text-[0.625rem] font-medium text-[var(--muted-foreground)]">
        <span className="truncate">{label}</span>
        {help && <HelpTooltip text={help} size="0.625rem" />}
      </span>
      {onSendChange && (
        <SettingsSwitch
          ariaLabel={`Send ${label} parameter`}
          checked={sendEnabled === true}
          onChange={onSendChange}
          labelPosition="start"
          className="!gap-0 !rounded-md !p-0 hover:!bg-transparent"
          title={
            sendEnabled
              ? localizeUi("ui.ui.parameterheader.thisParameterIsSentToTheModel")
              : localizeUi("ui.ui.parameterheader.thisParameterIsNotSentToTheModel")
          }
        />
      )}
    </div>
  );
}
