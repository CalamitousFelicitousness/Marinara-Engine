// ──────────────────────────────────────────────
// Prompt Service — Public exports
// ──────────────────────────────────────────────
export {
  assemblePrompt,
  appendFallbackChatSummaryToSystemPrompt,
  type AssemblerInput,
  type AssemblerOutput,
} from "./assembler.js";
export {
  buildPresetVariables,
  loadPresetVariables,
  resolveChoiceVariableValue,
  type BuildPresetVariablesInput,
  type ChoiceOptionValue,
  type LoadPresetVariablesInput,
  type PresetChoiceBlockReader,
  type PresetVariableChoices,
} from "./preset-variables.js";
export { wrapContent, wrapGroup } from "./format-engine.js";
export { expandMarker, type MarkerContext, type ExpandedMarker } from "./marker-expander.js";
export {
  buildChatMacroContext,
  buildChatMacroContextForPreset,
  buildPromptMacroContext,
  cloneMacroContextForPreview,
  resolveMacrosForPreview,
  normalizeChatMacroVariables,
  collectCharacterAdvancedPromptEntries,
  collectCharacterDepthPromptEntries,
  collectCharacterPostHistoryEntries,
  resolvePromptMessageMacros,
  scopePromptMacroContextToCharacter,
  resolveCharacterAdvancedPromptIds,
  resolvePromptIdleDuration,
  resolvePromptLastGenerationType,
  resolveMacrosWithVariableSnapshot,
  setLorebookEntryCounts,
  resolveCharacterMacroData,
  type CharacterMacroData,
  type MacroResolutionTransaction,
  type PromptMacroActivityMessage,
  type PromptMacroMessage,
  type BuildChatMacroContextInput,
  type ChatMacroContextSource,
  type PromptDepthEntry,
} from "./macro-context.js";
export { mergeAdjacentMessages, squashLeadingSystemMessages } from "./merger.js";
