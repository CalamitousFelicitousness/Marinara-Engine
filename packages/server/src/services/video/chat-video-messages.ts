import type { GeneratedSceneVideo, MessageAttachment } from "@marinara-engine/shared";

export interface ChatVideoAnchor {
  messageId: string;
  swipeIndex: number;
}

/**
 * The message a generated video belongs under: the newest reply (on its shown swipe), where the user is,
 * whichever reply its picture came from. Null when the chat has no reply yet; the video then lives only
 * in the gallery.
 */
export function resolveChatVideoAnchor(
  messages: ReadonlyArray<{ id: string; role?: string | null; activeSwipeIndex?: number | null }>,
): ChatVideoAnchor | null {
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
