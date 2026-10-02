// ──────────────────────────────────────────────
// Experience map packs (worldgen W9e): an Experience's own setting kit, ready-made worlds built with it
// and tile pack, read from the installed package through the same verification as every package asset,
// and checked as share files are. A game started with the Experience is locked to them.
// ──────────────────────────────────────────────
import {
  parseTilePack,
  readWorldFile,
  readWorldKitFile,
  type ExperienceMapPack,
  type TilePack,
} from "@marinara-engine/shared";
import { capabilityPackageManager } from "../capability-packages/package-manager.service.js";

export type MapPack = ExperienceMapPack;

export type MapPackRead = { ok: true; pack: MapPack } | { ok: false; reason: string } | null;

/** Two values the same, whatever order their keys were written in. */
export function sameJson(left: unknown, right: unknown): boolean {
  const canon = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canon)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
              .sort()
              .map((key) => [key, canon((value as Record<string, unknown>)[key])]),
          )
        : value;
  return JSON.stringify(canon(left)) === JSON.stringify(canon(right));
}

// A pack is the same for the same installed version: its files are hash-pinned.
const cache = new Map<string, MapPackRead>();

/** The Experience's map pack, checked; null when it ships none (or is not installed and ready). A pack
 *  whose files do not read is refused whole, with the reason, never half used. */
export async function readMapPack(packageId: string): Promise<MapPackRead> {
  let files: Awaited<ReturnType<typeof capabilityPackageManager.mapPackFiles>>;
  try {
    files = await capabilityPackageManager.mapPackFiles(packageId);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!files) return null;
  const key = `${packageId}@${files.version}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const result = ((): MapPackRead => {
    const kit = readWorldKitFile(files.kit.toString("utf8"));
    if (!kit.ok) return { ok: false, reason: `its kit does not read: ${kit.issues[0]}` };
    const worlds: MapPack["worlds"] = [];
    for (const { path, data } of files.worlds) {
      const world = readWorldFile(data.toString("utf8"));
      if (!world.ok) return { ok: false, reason: `${path} does not read: ${world.issues[0]}` };
      if (!sameJson(world.kit, kit.kit)) return { ok: false, reason: `${path} was made with another kit` };
      if (world.notes.length) return { ok: false, reason: `${path} does not fit its kit: ${world.notes[0]}` };
      worlds.push({ path, name: world.name, world: world.world });
    }
    let tiles: TilePack | null = null;
    if (files.tiles) {
      const read = parseTilePack(files.tiles.toString("utf8"));
      if (!read.ok) return { ok: false, reason: `its tiles do not read: ${read.issues[0]}` };
      tiles = read.pack;
    }
    return { ok: true, pack: { packageId, name: files.name, kit: kit.kit, worlds, tiles } };
  })();
  cache.set(key, result);
  return result;
}

/** Why a new game's kit and world are not the ones its Experience's map pack locks it to, or nothing. */
export function mapPackLockIssue(
  pack: MapPack,
  setup: { worldKit?: unknown; world?: { seed: number; grounding?: string; brief: unknown; edits?: unknown } | null },
): string | null {
  if (!setup.worldKit || !sameJson(setup.worldKit, pack.kit)) {
    return `${pack.name} sets the game's setting kit to its own.`;
  }
  if (pack.worlds.length === 0) return null;
  const world = setup.world;
  const one = world
    ? pack.worlds.some(
        ({ world: shipped }) =>
          shipped.seed === world.seed &&
          shipped.grounding === (world.grounding ?? "expand") &&
          sameJson(shipped.brief, world.brief) &&
          sameJson(shipped.edits ?? null, world.edits ?? null),
      )
    : false;
  return one ? null : `${pack.name} sets the game's world to one of its own maps.`;
}
