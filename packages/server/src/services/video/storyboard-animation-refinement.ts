import type { ChatMessage } from "../llm/base-provider.js";
import { compactVideoPromptText } from "./prompt-context.js";
import type { VideoReferenceImage } from "./video-generation.js";

const MAX_REFINEMENT_CHARS = 6_000;

function imageDataUrl(image: VideoReferenceImage): string {
  const base64 = image.base64.replace(/^data:[^,]+,/iu, "");
  return `data:${image.mimeType};base64,${base64}`;
}

function unwrapJsonFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  return fenced?.[1]?.trim() ?? trimmed;
}

export function buildStoryboardAnimationRefinementMessages(args: {
  title: string;
  motionIntent: string;
  illustrationPrompt: string;
  plannerPrompt: string;
  durationSeconds: number;
  aspectRatio: "16:9" | "9:16";
  referenceImage: VideoReferenceImage;
}): ChatMessage[] {
  const systemPrompt = [
    "Refine one storyboard motion beat using the attached generated illustration as the exact first frame at T=0.",
    "Follow the active Storyboard Agent animation preset below for its motion and storytelling priorities. These single-beat output instructions take precedence over any multi-keyframe or JSON output instructions in that preset.",
    `<active_storyboard_animation_preset>\n${compactVideoPromptText(args.plannerPrompt, 8_000)}\n</active_storyboard_animation_preset>`,
    "The image is authoritative for visible subjects, pose, crop, camera angle, object placement, and feasible movement.",
    "Preserve the intended action and emotion, but simplify motion that conflicts with the actual frame.",
    "Describe subject motion, camera motion, continuity, and the ending beat. Do not repeat a static image description or invent unseen characters.",
    "If the motion intent uses | separators for timed segments, return the same number of | separated segments in the same order.",
    "Return only the refined motion beat with no label, Markdown, or commentary.",
  ].join("\n");
  const userPrompt = [
    `<storyboard_title>${compactVideoPromptText(args.title, 300)}</storyboard_title>`,
    `<duration_seconds>${args.durationSeconds}</duration_seconds>`,
    `<aspect_ratio>${args.aspectRatio}</aspect_ratio>`,
    `<motion_intent>\n${compactVideoPromptText(args.motionIntent, 4_000)}\n</motion_intent>`,
    args.illustrationPrompt
      ? `<intended_first_frame_context>\n${compactVideoPromptText(args.illustrationPrompt, 2_000)}\n</intended_first_frame_context>`
      : "",
    "Inspect the attached generated illustration, then refine the motion intent for what is actually visible.",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt, images: [imageDataUrl(args.referenceImage)] },
  ];
}

export function resolveStoryboardAnimationRefinement(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const unwrapped = unwrapJsonFence(value);
  let refined = unwrapped;
  try {
    const parsed = JSON.parse(unwrapped) as unknown;
    if (typeof parsed === "string") {
      refined = parsed;
    } else if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const candidate = record.narrationBeat ?? record.videoPrompt ?? record.prompt;
      refined = typeof candidate === "string" ? candidate : "";
    } else {
      refined = "";
    }
  } catch {
    refined = unwrapped.replace(/^(?:refined\s+)?(?:motion|narration)\s*beat\s*:\s*/iu, "");
  }
  return compactVideoPromptText(refined, Math.min(Math.max(1, maxLength), MAX_REFINEMENT_CHARS));
}

export function redactStoryboardAnimationRefinementMessages(messages: readonly ChatMessage[]) {
  return messages.map((message) => ({
    ...message,
    ...(message.images
      ? {
          images: message.images.map((image) => ({
            mediaType:
              image.startsWith("data:") && image.indexOf(",") > 5
                ? image.slice(5, image.indexOf(",")).split(";")[0]
                : "unknown",
            encodedCharacters: image.length,
          })),
        }
      : {}),
  }));
}
