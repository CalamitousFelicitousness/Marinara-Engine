// Hand-made battlefields (worldgen W9g): the board painted for where a fight starts.
import {
  gameWorldFromMetadata,
  lastGamePlace,
  readWorldLedger,
  worldAddedPlace,
  worldBattlefieldHere,
  worldPlaceByName,
  worldPlaceInForce,
  worldPresent,
} from "@marinara-engine/shared";
import type { DB } from "../../db/connection.js";
import { resolveOwnerSpatialProjection } from "../spatial-context/projection.js";
import { gameRepliesBefore } from "./game-market.service.js";

/**
 * The board painted by hand for where a fight starts: at the place in force as a turn reads it (the
 * map's location when it is a world place, else the place last said, else where the world starts the
 * party), one of its boards or of the nearest place it is inside, the fight's seed picking among several.
 * A place the story added is inside the world's place it was added to. Null for a game without a world
 * or where none applies: the fight's board is generated.
 */
export async function gameBattlefieldHere(db: DB, chatId: string, meta: Record<string, unknown>, seed: number) {
  const world = gameWorldFromMetadata(meta);
  if (!world?.edits?.battlefields?.length) return null;
  const replies = await gameRepliesBefore(db, chatId);
  const place = worldPlaceInForce(
    world,
    lastGamePlace(replies.scoped),
    (await resolveOwnerSpatialProjection(chatId, {}, meta))?.currentLocationId,
  );
  const placeId = place?.name
    ? (worldPlaceByName(world.world, place.name)?.id ??
      worldAddedPlace(world, worldPresent(world, readWorldLedger(replies.all)), place.name)?.within.id)
    : world.world.startId;
  return worldBattlefieldHere(world, placeId, seed);
}
