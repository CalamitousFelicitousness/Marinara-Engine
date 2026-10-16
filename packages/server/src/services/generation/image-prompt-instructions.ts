import { normalizeImagePromptInstructions } from "@marinara-engine/shared";

function appendPromptingInstructions(prompt: string, instructions: unknown, kind: "image" | "video"): string {
  const normalizedInstructions = normalizeImagePromptInstructions(instructions);
  return normalizedInstructions
    ? `${prompt}\n\n<${kind}_prompting_instructions>\nApply these ${kind}-backend instructions when writing the provider-ready prompt. They are instructions, not text to copy into the prompt:\n${normalizedInstructions}\n</${kind}_prompting_instructions>`
    : prompt;
}

export function appendImagePromptInstructions(prompt: string, instructions: unknown): string {
  return appendPromptingInstructions(prompt, instructions, "image");
}

/** A video connection's instructions for the model that writes its video prompt. */
export function appendVideoPromptInstructions(prompt: string, instructions: unknown): string {
  return appendPromptingInstructions(prompt, instructions, "video");
}

/**
 * A video connection's instructions that decide the whole video prompt: their format, fields, line breaks and shot
 * rules replace any the writer's own prompt names. Used by every chat video writer, so each clip follows them.
 */
export function appendGoverningVideoPromptInstructions(prompt: string, instructions: unknown): string {
  const normalizedInstructions = normalizeImagePromptInstructions(instructions);
  return normalizedInstructions
    ? `${prompt}\n\n<video_prompting_instructions>\nThese video-backend instructions govern the final video prompt. Follow them exactly. Where they set an output format, fields, line breaks or shot rules, use those instead of any format, length or shot limit named above, and keep their line breaks. They are instructions, not text to copy into the prompt:\n${normalizedInstructions}\n</video_prompting_instructions>`
    : prompt;
}

/** The instructions as they would be sent, or "" when there are none. */
export function normalizeVideoPromptInstructionsText(instructions: unknown): string {
  return normalizeImagePromptInstructions(instructions) ?? "";
}

/**
 * The writer's own (editable) system prompt names a format of its own, such as JSON or one continuous shot. When the
 * video connection has instructions, this closing line makes them win at the system level too.
 */
export function withGoverningVideoFormat(systemPrompt: string, instructions: unknown): string {
  return normalizeImagePromptInstructions(instructions)
    ? `${systemPrompt}\n\nThe video prompting instructions in the request decide the output. Return the finished video prompt as plain text in their exact format, fields and line breaks, even where this prompt asks for JSON, a single shot or one paragraph.`
    : systemPrompt;
}
