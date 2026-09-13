import {
  legacyChatParameterOverrides,
  parseChatParameterOverrides,
  stripLegacyChatParameters,
  type ChatParameterOverrides,
  type GenerationParameterBaseline,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { logger } from "../../lib/logger.js";
import { createChatsStorage } from "../storage/chats.storage.js";
import { createParameterBaselineResolver } from "./parameter-baseline.js";

const CONVERTED_FIELD_KEYS = [
  "assistantPrefill",
  "assistantReasoningPrefill",
  "customThinkingTags",
  "postProcessing",
  "serviceTier",
] as const;

function parseRecord(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** True when `chatParameters` still holds keys that Connection / Override / Off states replace. */
export function hasLegacyChatParameters(chatParameters: unknown): boolean {
  const record = parseRecord(chatParameters);
  if (!record) return false;
  return Object.keys(record).length !== Object.keys(stripLegacyChatParameters(record) ?? {}).length;
}

/**
 * Converts an old `chatParameters` blob: sampling values and switches are dropped, other saved fields equal to what
 * the layers below would send become Connection, and the rest become overrides. Explicit states are never replaced.
 * A null baseline (random or missing connection) keeps every saved field as an override.
 */
export function buildLegacyChatParameterPatch(
  metadata: Record<string, unknown>,
  baseline: GenerationParameterBaseline | null,
): Record<string, unknown> | null {
  if (!hasLegacyChatParameters(metadata.chatParameters)) return null;
  const legacy = legacyChatParameterOverrides(metadata.chatParameters);
  const explicit = parseChatParameterOverrides(metadata.chatParameterOverrides);
  const overrides: ChatParameterOverrides = { ...explicit };
  for (const key of CONVERTED_FIELD_KEYS) {
    const entry = legacy[key];
    if (!entry || explicit[key]) continue;
    const below = baseline?.fields?.[key];
    if (below && entry.mode === "override" && JSON.stringify(entry.value) === JSON.stringify(below.value)) continue;
    (overrides as Record<string, unknown>)[key] = entry;
  }
  const managed = { ...explicit.managed };
  for (const [id, entry] of Object.entries(legacy.managed ?? {})) {
    if (managed[id]) continue;
    const below = baseline?.managed?.[id];
    const matchesBelow =
      below && (entry.mode === "off" ? !below.enabled : below.enabled && below.value === entry.value);
    if (!matchesBelow) managed[id] = entry;
  }
  if (Object.keys(managed).length > 0) overrides.managed = managed;
  else delete overrides.managed;

  const hasOverrides = Object.keys(overrides).length > 0;
  return {
    chatParameters: stripLegacyChatParameters(metadata.chatParameters),
    ...(hasOverrides || metadata.chatParameterOverrides !== undefined
      ? { chatParameterOverrides: hasOverrides ? overrides : null }
      : {}),
  };
}

/** One-way conversion of per-chat parameters saved before Connection / Override / Off; a rerun finds nothing left. */
export async function migrateLegacyChatParameters(db: DB) {
  const chats = createChatsStorage(db);
  const resolveParameterBaseline = createParameterBaselineResolver(db);
  let updated = 0;
  for (const chat of await chats.list()) {
    const metadata = parseRecord(chat.metadata) ?? {};
    if (!hasLegacyChatParameters(metadata.chatParameters)) continue;
    const baseline = await resolveParameterBaseline({
      mode: chat.mode,
      meta: metadata,
      connectionId: chat.connectionId ?? null,
      chatPromptPresetId: chat.promptPresetId ?? null,
    });
    const patch = buildLegacyChatParameterPatch(metadata, baseline.fields ? baseline : null);
    if (!patch) continue;
    await chats.patchMetadata(chat.id, patch, { touchUpdatedAt: false });
    updated += 1;
  }
  if (updated > 0) logger.info("Converted saved Advanced Parameters for %d existing chats", updated);
}
