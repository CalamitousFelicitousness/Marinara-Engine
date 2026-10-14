import type { MessageAttachment } from "../types/chat.js";

/** A short, stable key for one attachment: its type and content (data URL, else url, else gallery id), FNV-1a. */
export function messageAttachmentKey(attachment: Partial<MessageAttachment>): string {
  const text = `${attachment.type}\n${attachment.data ?? attachment.url ?? attachment.galleryId ?? ""}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
