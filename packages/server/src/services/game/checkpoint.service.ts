// ──────────────────────────────────────────────
// Service: Game Checkpoints
//
// Auto-save and manual checkpoint creation,
// listing, and loading for game mode.
// ──────────────────────────────────────────────

import { and, eq, ne, desc, inArray } from "../../db/file-query.js";
import type { DB } from "../../db/connection.js";
import { gameCheckpoints, gameStateSnapshots, spatialContextSnapshots } from "../../db/schema/index.js";
import { newId, now } from "../../utils/id-generator.js";
import { logger } from "../../lib/logger.js";

export type CheckpointTrigger =
  | "manual"
  | "session_start"
  | "session_end"
  | "combat_start"
  | "combat_end"
  | "location_change"
  | "auto_interval";

export interface CreateCheckpointInput {
  chatId: string;
  snapshotId: string;
  spatialSnapshotId?: string | null;
  messageId: string;
  label: string;
  triggerType: CheckpointTrigger;
  location?: string | null;
  gameState?: string | null;
  weather?: string | null;
  timeOfDay?: string | null;
  turnNumber?: number | null;
}

export interface CheckpointRow {
  id: string;
  chatId: string;
  snapshotId: string;
  spatialSnapshotId: string | null;
  messageId: string;
  label: string;
  triggerType: string;
  location: string | null;
  gameState: string | null;
  weather: string | null;
  timeOfDay: string | null;
  turnNumber: number | null;
  createdAt: string;
}

export interface StoredCheckpointRow extends CheckpointRow {
  snapshotData: string | null;
  spatialSnapshotData: string | null;
}

/** Auto-checkpoints fire at session start/end and on every combat start/end, and only manual
 *  deletion removed one — so a long campaign accumulated them without bound, each row carrying
 *  full immutable copies of the captured snapshots (and, once #5102 lands, the engine-state
 *  blobs). On the in-memory file store that is permanent heap plus an O(n^2) shard rewrite per
 *  new checkpoint. Cap the auto-checkpoints to the newest few PER TRIGGER TYPE so a campaign
 *  keeps a rewind point of each kind of event without hoarding every one; a manual checkpoint is
 *  the user's explicit save point and is never pruned (#5110). */
export const MAX_AUTO_CHECKPOINTS_PER_TRIGGER = 5;

/** Delete the oldest auto-checkpoints (everything except `manual`) beyond
 *  {@link MAX_AUTO_CHECKPOINTS_PER_TRIGGER} for each trigger type in a chat. `protectId` is the
 *  id of a checkpoint that must survive regardless (the row `create` just inserted), so a
 *  same-millisecond `createdAt` collision can never prune the checkpoint we are about to return. */
export async function pruneAutoCheckpoints(db: DB, chatId: string, protectId?: string): Promise<void> {
  const autoRows = await db
    .select({
      id: gameCheckpoints.id,
      triggerType: gameCheckpoints.triggerType,
      createdAt: gameCheckpoints.createdAt,
    })
    .from(gameCheckpoints)
    .where(and(eq(gameCheckpoints.chatId, chatId), ne(gameCheckpoints.triggerType, "manual")));

  const byTrigger = new Map<string, Array<{ id: string; createdAt: string }>>();
  for (const row of autoRows) {
    const bucket = byTrigger.get(row.triggerType) ?? [];
    bucket.push({ id: row.id, createdAt: row.createdAt });
    byTrigger.set(row.triggerType, bucket);
  }

  const overflowIds: string[] = [];
  for (const bucket of byTrigger.values()) {
    if (bucket.length <= MAX_AUTO_CHECKPOINTS_PER_TRIGGER) continue;
    // Newest first. createdAt is an ISO-8601 string (lexical order == chronological); id is a
    // deterministic tiebreak for the rare same-millisecond collision.
    bucket.sort((a, b) =>
      a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1,
    );
    for (const row of bucket.slice(MAX_AUTO_CHECKPOINTS_PER_TRIGGER)) {
      if (row.id !== protectId) overflowIds.push(row.id);
    }
  }

  if (overflowIds.length > 0) {
    await db.delete(gameCheckpoints).where(inArray(gameCheckpoints.id, overflowIds));
    logger.debug("Pruned %d expired auto-checkpoint(s) for chat %s", overflowIds.length, chatId);
  }
}

export function createCheckpointService(db: DB) {
  return {
    async create(input: CreateCheckpointInput): Promise<string> {
      const capturedGameRows = await db
        .select()
        .from(gameStateSnapshots)
        .where(eq(gameStateSnapshots.id, input.snapshotId))
        .limit(1);
      const capturedGameSnapshot = capturedGameRows[0];
      if (!capturedGameSnapshot || capturedGameSnapshot.chatId !== input.chatId) {
        throw new Error("Checkpoint Game snapshot is missing or belongs to another chat");
      }

      const capturedSpatialRows = input.spatialSnapshotId
        ? await db
            .select()
            .from(spatialContextSnapshots)
            .where(eq(spatialContextSnapshots.id, input.spatialSnapshotId))
            .limit(1)
        : await db
            .select()
            .from(spatialContextSnapshots)
            .where(
              and(
                eq(spatialContextSnapshots.chatId, input.chatId),
                eq(spatialContextSnapshots.messageId, capturedGameSnapshot.messageId),
                eq(spatialContextSnapshots.swipeIndex, capturedGameSnapshot.swipeIndex),
              ),
            )
            .limit(1);
      const capturedSpatialSnapshot = capturedSpatialRows[0] ?? null;
      if (capturedSpatialSnapshot && capturedSpatialSnapshot.chatId !== input.chatId) {
        throw new Error("Checkpoint Spatial Context snapshot belongs to another chat");
      }

      const id = newId();
      await db.insert(gameCheckpoints).values({
        id,
        chatId: input.chatId,
        snapshotId: input.snapshotId,
        spatialSnapshotId: capturedSpatialSnapshot?.id ?? null,
        snapshotData: JSON.stringify(capturedGameSnapshot),
        spatialSnapshotData: capturedSpatialSnapshot ? JSON.stringify(capturedSpatialSnapshot) : null,
        messageId: input.messageId,
        label: input.label,
        triggerType: input.triggerType,
        location: input.location ?? null,
        gameState: input.gameState ?? null,
        weather: input.weather ?? null,
        timeOfDay: input.timeOfDay ?? null,
        turnNumber: input.turnNumber ?? null,
        createdAt: now(),
      });
      // A manual save never grows an auto bucket, so only an auto checkpoint can push a bucket
      // over the cap; skip the scan on manual creates.
      if (input.triggerType !== "manual") {
        await pruneAutoCheckpoints(db, input.chatId, id);
      }
      return id;
    },

    async listForChat(chatId: string): Promise<CheckpointRow[]> {
      // Project only the list columns so the (potentially large) captured snapshot blobs are
      // never copied out of the store just to be stripped again — the list never needs them.
      const rows = await db
        .select({
          id: gameCheckpoints.id,
          chatId: gameCheckpoints.chatId,
          snapshotId: gameCheckpoints.snapshotId,
          spatialSnapshotId: gameCheckpoints.spatialSnapshotId,
          messageId: gameCheckpoints.messageId,
          label: gameCheckpoints.label,
          triggerType: gameCheckpoints.triggerType,
          location: gameCheckpoints.location,
          gameState: gameCheckpoints.gameState,
          weather: gameCheckpoints.weather,
          timeOfDay: gameCheckpoints.timeOfDay,
          turnNumber: gameCheckpoints.turnNumber,
          createdAt: gameCheckpoints.createdAt,
        })
        .from(gameCheckpoints)
        .where(eq(gameCheckpoints.chatId, chatId))
        .orderBy(desc(gameCheckpoints.createdAt));
      return rows as CheckpointRow[];
    },

    async getById(id: string): Promise<StoredCheckpointRow | null> {
      const rows = await db.select().from(gameCheckpoints).where(eq(gameCheckpoints.id, id)).limit(1);
      return (rows[0] as StoredCheckpointRow) ?? null;
    },

    async deleteForChat(chatId: string): Promise<void> {
      await db.delete(gameCheckpoints).where(eq(gameCheckpoints.chatId, chatId));
    },

    async deleteById(id: string): Promise<void> {
      await db.delete(gameCheckpoints).where(eq(gameCheckpoints.id, id));
    },
  };
}
