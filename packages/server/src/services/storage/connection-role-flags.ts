// ──────────────────────────────────────────────
// Storage: Connection Role Flags
// ──────────────────────────────────────────────
// One exclusivity sweep for every "this connection is the default (or fallback)
// for X" flag pair. Two rules hold for all of them:
//   - a flag is unique within its category, so granting it clears every other
//     holder that competes there;
//   - default and fallback are opposite answers to one question, so a row that
//     takes one side releases the other.
//
// Category comes from the provider. The media categories compete by provider
// equality; every language provider competes as a single pool, which is why
// that branch inspects rows instead of naming a provider.
//
// The audio purpose pairs (sfx, music) only ever compete inside the audio
// category. The agents pair is category-polymorphic: it is the language agent
// default, the image default, the video default, and the base audio default.

import { and, eq, ne } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { apiConnections } from "../../db/schema/index.js";

export type ConnectionDefaultCategory = "image_generation" | "video_generation" | "audio" | "language";

export function defaultCategoryForProvider(provider: string): ConnectionDefaultCategory {
  if (provider === "image_generation") return "image_generation";
  if (provider === "video_generation") return "video_generation";
  if (provider === "audio") return "audio";
  return "language";
}

export type RoleFlagField =
  | "defaultForAgents"
  | "fallbackForAgents"
  | "defaultForSfx"
  | "fallbackForSfx"
  | "defaultForMusic"
  | "fallbackForMusic";

export interface RoleFlagPair {
  defaultField: RoleFlagField;
  fallbackField: RoleFlagField;
}

/** Language agents, image generation, video generation, and the base audio lane. */
export const AGENTS_ROLE_PAIR: RoleFlagPair = { defaultField: "defaultForAgents", fallbackField: "fallbackForAgents" };
/** Game sound effects. Audio connections only. */
export const SFX_ROLE_PAIR: RoleFlagPair = { defaultField: "defaultForSfx", fallbackField: "fallbackForSfx" };
/** Game music. Audio connections only. */
export const MUSIC_ROLE_PAIR: RoleFlagPair = { defaultField: "defaultForMusic", fallbackField: "fallbackForMusic" };

/** Audio purposes that own a flag pair; speech uses the base agents pair. */
export const AUDIO_PURPOSE_ROLE_PAIRS = { sfx: SFX_ROLE_PAIR, music: MUSIC_ROLE_PAIR } as const;

/** create() and update() both run this inside a transaction, whose handle is a full DB. */
type RoleFlagTx = Pick<DB, "select" | "update">;

export interface EnforceRoleFlagExclusivityArgs {
  pair: RoleFlagPair;
  side: "default" | "fallback";
  category: ConnectionDefaultCategory;
  /**
   * Row to leave flagged. null clears every holder, which is right when the
   * caller is granting the flag and writes it back in the same transaction.
   * A row id keeps that row's flag, which is what a provider change needs: the
   * row carries its flag into the new category and evicts the incumbent there.
   */
  exceptId: string | null;
}

/**
 * Clears `side`'s flag on the competing rows and returns the same-row patch that
 * releases the opposite side. The caller merges that patch into the values it is
 * already writing, so the pair stays mutually exclusive on one row.
 */
export async function enforceRoleFlagExclusivity(
  tx: RoleFlagTx,
  { pair, side, category, exceptId }: EnforceRoleFlagExclusivityArgs,
): Promise<Partial<Record<RoleFlagField, "false">>> {
  const flagField = side === "default" ? pair.defaultField : pair.fallbackField;
  const oppositeField = side === "default" ? pair.fallbackField : pair.defaultField;
  const flagColumn = apiConnections[flagField];

  if (category === "language") {
    const holders = await tx.select().from(apiConnections).where(eq(flagColumn, "true"));
    for (const row of holders) {
      if (defaultCategoryForProvider(row.provider) !== "language") continue;
      if (exceptId !== null && row.id === exceptId) continue;
      await tx
        .update(apiConnections)
        .set({ [flagField]: "false" })
        .where(eq(apiConnections.id, row.id));
    }
  } else {
    await tx
      .update(apiConnections)
      .set({ [flagField]: "false" })
      .where(
        exceptId === null
          ? and(eq(flagColumn, "true"), eq(apiConnections.provider, category))
          : and(eq(flagColumn, "true"), eq(apiConnections.provider, category), ne(apiConnections.id, exceptId)),
      );
  }

  return { [oppositeField]: "false" };
}
