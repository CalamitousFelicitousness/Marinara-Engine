import type { ConversationSelfieCtx } from "../prompt-overrides/index.js";
import { CONVERSATION_SELFIE, loadPrompt, renderTemplate } from "../prompt-overrides/index.js";
import type { PromptOverridesStorage } from "../storage/prompt-overrides.storage.js";

export async function resolveConversationSelfieSystemPrompt(input: {
  promptOverridesStorage: PromptOverridesStorage;
  chatPromptTemplate?: string | null;
  appearance: string;
  /** Enabled image-prompt appearance override, empty when the card has none (#7243). */
  imageAppearance?: string;
  charName: string;
  characterImageInstructions?: string;
  personality?: string;
  selfieTagsBlock?: string;
}): Promise<string> {
  const promptContext: ConversationSelfieCtx = {
    appearance: input.appearance,
    imageAppearance: input.imageAppearance?.trim() ?? "",
    charName: input.charName,
    characterImageInstructions: input.characterImageInstructions?.trim() ?? "",
    personality: input.personality?.trim() ?? "",
    selfieTagsBlock: input.selfieTagsBlock ?? "",
  };
  // #7258: custom templates saved before `${imageAppearance}` existed only reference
  // `${appearance}`, which used to carry the override. Keep that meaning for them so
  // their override (e.g. a LoRA trigger) is not silently dropped.
  const templateContext = (template: string): ConversationSelfieCtx =>
    template.includes("${imageAppearance}") || !promptContext.imageAppearance
      ? promptContext
      : { ...promptContext, appearance: promptContext.imageAppearance };
  const chatPromptTemplate = input.chatPromptTemplate?.trim() ?? "";

  if (chatPromptTemplate) {
    return renderTemplate(
      chatPromptTemplate,
      templateContext(chatPromptTemplate),
      CONVERSATION_SELFIE.variables.map((variable) => variable.name),
    );
  }

  return loadPrompt(input.promptOverridesStorage, CONVERSATION_SELFIE, promptContext, templateContext);
}
