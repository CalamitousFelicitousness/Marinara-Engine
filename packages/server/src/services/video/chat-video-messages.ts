import type { GeneratedSceneVideo, MessageAttachment } from "@marinara-engine/shared";
import { extraReferencesGalleryImage } from "./prompt-context.js";

export interface ChatVideoAnchor {
  messageId: string;
  swipeIndex: number;
}

/**
 * The message a generated video belongs under: the message (and swipe) that shows its source
 * gallery image, or else the latest assistant message. Null when the chat has no such message,
 * in which case the video lives only in the gallery.
 */
export function resolveChatVideoAnchor(
  messages: ReadonlyArray<{ id: string; role?: string | null; extra?: unknown; activeSwipeIndex?: number | null }>,
  swipes: ReadonlyArray<{ messageId: string; index: number; extra?: unknown }>,
  galleryImageId?: string | null,
): ChatVideoAnchor | null {
  const imageId = galleryImageId?.trim();
  if (imageId) {
    // A swipe on screen wins over a hidden one that shows the same picture, so the clip is seen.
    const matches = swipes.filter(
      (row) =>
        extraReferencesGalleryImage(row.extra, imageId) && messages.some((message) => message.id === row.messageId),
    );
    const swipe =
      matches.find((row) =>
        messages.some((message) => message.id === row.messageId && (message.activeSwipeIndex ?? 0) === row.index),
      ) ?? matches[0];
    if (swipe) return { messageId: swipe.messageId, swipeIndex: swipe.index };
    const message = messages.find((row) => extraReferencesGalleryImage(row.extra, imageId));
    if (message) return { messageId: message.id, swipeIndex: message.activeSwipeIndex ?? 0 };
  }
  const latest = [...messages].reverse().find((message) => message.role === "assistant");
  return latest ? { messageId: latest.id, swipeIndex: latest.activeSwipeIndex ?? 0 } : null;
}

export function buildChatVideoAttachment(video: GeneratedSceneVideo, characterName?: string): MessageAttachment {
  return {
    type: "video",
    url: video.url,
    filename: video.filePath.split(/[\\/]/).pop() ?? "video.mp4",
    prompt: video.prompt,
    videoId: video.id,
    durationSeconds: video.durationSeconds,
    aspectRatio: video.aspectRatio,
    ...(characterName ? { characterName } : {}),
  };
}

/** Put the video on its swipe, and on the message too while that swipe is still the one shown. */
export async function attachVideoToMessage(
  chats: {
    appendSwipeAttachment(messageId: string, swipeIndex: number, attachment: Record<string, unknown>): Promise<unknown>;
    appendMessageAttachmentForActiveSwipe(
      messageId: string,
      swipeIndex: number,
      attachment: Record<string, unknown>,
    ): Promise<unknown>;
  },
  anchor: ChatVideoAnchor,
  attachment: MessageAttachment,
): Promise<void> {
  const record = attachment as unknown as Record<string, unknown>;
  await chats.appendSwipeAttachment(anchor.messageId, anchor.swipeIndex, record);
  await chats.appendMessageAttachmentForActiveSwipe(anchor.messageId, anchor.swipeIndex, record);
}
