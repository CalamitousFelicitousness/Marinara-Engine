// ──────────────────────────────────────────────
// Avatar director: the Game Master line now on screen
// ──────────────────────────────────────────────
// GameNarration publishes the narration segment it shows; the director listens. Only dialogue lines with a
// speaker reach avatars, with the Game Master's per-line expression. Nothing listens unless an avatar stage is
// mounted, so publishing costs one Set lookup.
import type { AvatarGameLine } from "../contract";

type GameLineListener = (chatId: string, line: AvatarGameLine) => void;

interface ShownSegment {
  id: string;
  type: string;
  speaker?: string;
  sprite?: string;
  content: string;
}

const listeners = new Set<GameLineListener>();
let lastShownKey: string | null = null;

/** Called whenever the active narration segment changes; repeats of the same line are ignored. */
export function publishAvatarGameLine(chatId: string | null, segment: ShownSegment | null): void {
  if (!chatId || !segment || segment.type !== "dialogue" || !segment.speaker?.trim()) return;
  const key = `${chatId}\n${segment.id}\n${segment.content}`;
  if (key === lastShownKey) return;
  lastShownKey = key;
  const line: AvatarGameLine = {
    speakerName: segment.speaker.trim(),
    ownerId: null,
    expression: segment.sprite?.trim() || null,
    text: segment.content,
  };
  for (const listener of listeners) listener(chatId, line);
}

export function subscribeAvatarGameLines(listener: GameLineListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
