// ──────────────────────────────────────────────
// Author's Notes assembly
// ──────────────────────────────────────────────
//
// Single source for which author's notes are active and where they land.
// Consumers: generate.routes, generate/dry-run-route, generate/retry-agents-route.
// Each previously re-derived the note and hardcoded depth 4.
//
import { normalizeAuthorNoteDepth, type AuthorNotePreset } from "@marinara-engine/shared";

/** One resolved note, ready to position in the prompt. */
export interface AuthorNoteEntry {
  /** Preset id. null = chat-local note. */
  presetId: string | null;
  /** Preset name. null = chat-local note. */
  name: string | null;
  /** Macro-resolved, trimmed. Never empty; empty notes are dropped upstream. */
  content: string;
  /** 0 = after the latest message. */
  depth: number;
}

/** Fields read off the chat row. Loosely typed: callers hold raw rows. */
interface AuthorNoteChatMeta {
  authorNotes?: unknown;
  authorNotesDepth?: unknown;
  activeAuthorNotePresetIds?: unknown;
}

function readActivePresetIds(chatMeta: AuthorNoteChatMeta): string[] {
  const raw = chatMeta.activeAuthorNotePresetIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Chat-local note, or null when empty.
 *
 * `resolve` is caller-supplied: generation paths defer character macros
 * mid-stream, the agent path resolves eagerly without trimming.
 */
function collectChatLocalNote(
  chatMeta: AuthorNoteChatMeta,
  resolve: (raw: string) => string,
): AuthorNoteEntry | null {
  const raw = typeof chatMeta.authorNotes === "string" ? chatMeta.authorNotes.trim() : "";
  if (!raw) return null;
  const content = resolve(raw).trim();
  if (!content) return null;
  return {
    presetId: null,
    name: null,
    content,
    depth: normalizeAuthorNoteDepth(chatMeta.authorNotesDepth),
  };
}

/**
 * Active presets, in library order.
 *
 * Unresolvable ids are skipped, not an error: deleting a preset leaves stale ids
 * on every chat that had it on. Cleaning those would rewrite every chat row.
 */
function collectActivePresets(
  chatMeta: AuthorNoteChatMeta,
  presets: AuthorNotePreset[],
  resolve: (raw: string) => string,
): AuthorNoteEntry[] {
  const activeIds = new Set(readActivePresetIds(chatMeta));
  if (activeIds.size === 0) return [];
  const entries: AuthorNoteEntry[] = [];
  // Iterate the library, not the id list: user ordering wins over chat-row order.
  for (const preset of presets) {
    if (!activeIds.has(preset.id)) continue;
    const raw = typeof preset.content === "string" ? preset.content.trim() : "";
    if (!raw) continue;
    const content = resolve(raw).trim();
    if (!content) continue;
    entries.push({
      presetId: preset.id,
      name: preset.name,
      content,
      depth: normalizeAuthorNoteDepth(preset.depth),
    });
  }
  return entries;
}

/**
 * Final prompt order: presets in library order, chat-local note last.
 *
 * injectAtDepth breaks same-depth ties by array position, so this order is what
 * the model reads. Chat-local goes last to win a same-depth contradiction by
 * recency. Preset order is user-controlled in the panel.
 */
export function orderAuthorNoteEntries(
  chatLocal: AuthorNoteEntry | null,
  presets: AuthorNoteEntry[],
): AuthorNoteEntry[] {
  return chatLocal ? [...presets, chatLocal] : [...presets];
}

/** All active notes for a chat, in final prompt order. */
export function collectAuthorNoteEntries(
  chatMeta: AuthorNoteChatMeta,
  presets: AuthorNotePreset[],
  resolve: (raw: string) => string,
): AuthorNoteEntry[] {
  return orderAuthorNoteEntries(
    collectChatLocalNote(chatMeta, resolve),
    collectActivePresets(chatMeta, presets, resolve),
  );
}

/** Shape for injectAtDepth. */
export function toAuthorNoteDepthEntries(
  entries: AuthorNoteEntry[],
): Array<{ content: string; role: "system"; depth: number }> {
  return entries.map((entry) => ({ content: entry.content, role: "system" as const, depth: entry.depth }));
}

/**
 * Flatten to the single string agents get as the `authorNotes` context source.
 * Depth does not apply there; joined in prompt order.
 */
export function toAuthorNotesContextText(entries: AuthorNoteEntry[]): string | null {
  if (entries.length === 0) return null;
  return entries.map((entry) => entry.content).join("\n\n") || null;
}
