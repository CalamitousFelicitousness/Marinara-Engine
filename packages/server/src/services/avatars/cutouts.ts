// ──────────────────────────────────────────────
// Avatar agents: pictures without a background
// ──────────────────────────────────────────────
// Every picture a PNGTuber or mesh avatar shows is a cut-out. A picture that already has a see-through
// background is used as it is (hasSpriteTransparency, the matte cleanup's own test). Any other is cleaned
// by the sprite background cleanup (removeSpriteBackgroundPng) with the configured engine: the built-in
// cleaner for a flat background, the AI remover (backgroundremover) when it is installed and the background
// isn't flat, or always when the AI remover is the configured engine. When the AI remover is missing or
// fails, the built-in cleaner makes the cut-out, as on Lite and Termux. The owner's sprites are never
// changed: their cut-outs are stored in the avatar's own folder, one per version of the sprite file.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { AvatarFilePath, AvatarOwnerRef } from "@marinara-engine/shared";
import { logger } from "../../lib/logger.js";
import { getSharp } from "../image/sharp-runtime.js";
import { hasSpriteTransparency, removeSpriteBackgroundPng } from "../image/sprite-background.service.js";
import {
  decodeAvatarSourceSprite,
  findAvatarSpriteFile,
  type AvatarSourceSprite,
} from "./generation/generation-context.js";
import { resolveAvatarFile, writeAvatarFiles } from "./storage.js";

/** The sprite cleanup's default strength (POST /api/sprites/cleanup). */
const CLEANUP_STRENGTH = 35;
/** Part of every stored cut-out's name, so a change to the cleanup makes new cut-outs. */
const CUTOUT_VERSION = 1;

let cleanupQueue: Promise<unknown> = Promise.resolve();

async function cleanPicture(png: Buffer): Promise<Buffer> {
  try {
    return (await removeSpriteBackgroundPng(png, CLEANUP_STRENGTH)).buffer;
  } catch (error) {
    // Only an AI remover set as the engine throws (missing or failed); the built-in cleaner still works.
    logger.warn(error, "[avatars] The background remover failed; using the built-in cleaner");
    return (await removeSpriteBackgroundPng(png, CLEANUP_STRENGTH, "builtin")).buffer;
  }
}

/** A cut-out of a picture, the same size: the picture itself when its background is already see-through.
 *  Cleanups run one at a time, so a stage loading many faces never starts many AI remover processes. */
export async function avatarCutout(png: Buffer): Promise<{ png: Buffer; cleaned: boolean }> {
  if (await hasSpriteTransparency(png)) return { png, cleaned: false };
  const run = cleanupQueue.then(() => cleanPicture(png));
  cleanupQueue = run.catch(() => undefined);
  return { png: await run, cleaned: true };
}

/** Where the cut-out of one version of a sprite file is stored. */
export function spriteCutoutPath(hash: string): AvatarFilePath {
  return `pngtuber/cutout-${CUTOUT_VERSION}-${hash.slice(0, 24)}.png` as AvatarFilePath;
}

const pendingCutouts = new Map<string, Promise<{ png: Buffer; cleaned: boolean }>>();

/** The owner's sprite as a cut-out: itself when its background is already see-through, else its cleaned
 *  copy, made once per sprite version and stored in the avatar's folder (the sprite file stays as it is).
 *  The same stored copy is the PNGTuber face, the base its blink and talk pictures are drawn on, and the
 *  mesh avatar's picture, so they always line up. */
export async function avatarSpriteCutout(
  owner: AvatarOwnerRef,
  sprite: AvatarSourceSprite,
): Promise<AvatarSourceSprite> {
  const path = spriteCutoutPath(sprite.hash);
  const key = `${owner.ownerType}:${owner.ownerId}:${path}`;
  let pending = pendingCutouts.get(key);
  if (!pending) {
    pending = (async () => {
      const stored = resolveAvatarFile(owner, path);
      if (existsSync(stored)) return { png: await readFile(stored), cleaned: true };
      const cut = await avatarCutout(sprite.png);
      if (cut.cleaned) await writeAvatarFiles(owner, [{ path, bytes: cut.png }]);
      return cut;
    })().finally(() => pendingCutouts.delete(key));
    pendingCutouts.set(key, pending);
  }
  const cut = await pending;
  if (!cut.cleaned) return sprite;
  const sharp = await getSharp();
  return { ...sprite, png: cut.png, transparent: !(await sharp(cut.png).stats()).isOpaque };
}

/** Sprite versions whose own file is shown (already see-through, or animated), so a reload skips decoding. */
const shownAsIs = new Set<string>();
const SHOWN_AS_IS_LIMIT = 4096;

/** The file to show for an owner's sprite in an avatar: its cut-out, or the sprite file itself when it
 *  already has a see-through background or is animated (a cut-out would keep only its first frame). When the
 *  sprite can't be cleaned here, the sprite is shown and `final` is false (the reason is logged), so the
 *  browser asks again. Null when there is no raster sprite with this label. */
export async function avatarSpriteDisplayFile(
  owner: AvatarOwnerRef,
  label: string,
): Promise<{ file: string; name: string; final: boolean } | null> {
  const file = findAvatarSpriteFile(owner.ownerId, label);
  if (!file) return null;
  const original = { file, name: basename(file), final: true };
  let sharp: Awaited<ReturnType<typeof getSharp>>;
  try {
    sharp = await getSharp();
  } catch {
    // No image processing on this server (some Android installs); its loader already said why.
    return { ...original, final: false };
  }
  try {
    const bytes = await readFile(file);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const path = spriteCutoutPath(hash);
    const stored = { file: resolveAvatarFile(owner, path), name: basename(path), final: true };
    if (shownAsIs.has(hash)) return original;
    if (existsSync(stored.file)) return stored;
    const animated = ((await sharp(bytes, { animated: true }).metadata()).pages ?? 1) > 1;
    if (!animated) await avatarSpriteCutout(owner, await decodeAvatarSourceSprite(label, bytes));
    if (existsSync(stored.file)) return stored;
    if (shownAsIs.size >= SHOWN_AS_IS_LIMIT) shownAsIs.clear();
    shownAsIs.add(hash);
    return original;
  } catch (error) {
    logger.warn(error, "[avatars] Couldn't make a cut-out of the sprite %s; showing the sprite", label);
    return { ...original, final: false };
  }
}

/** Cut-outs of a base picture and its talk and blink pictures (all one size). Each variant keeps the base's
 *  cut-out wherever it shows the same pixel as the base, so swapping to it never moves an edge or shows a
 *  background the base doesn't; only what the variant changes is cut on its own. */
export async function avatarCutoutSet(base: Buffer, variants: readonly Buffer[]): Promise<Buffer[]> {
  const baseCut = await avatarCutout(base);
  const sharp = await getSharp();
  const rgba = (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const baseBefore = baseCut.cleaned ? await rgba(base) : null;
  const baseAfter = baseCut.cleaned ? await rgba(baseCut.png) : null;
  const result = [baseCut.png];
  for (const variant of variants) {
    const cut = await avatarCutout(variant);
    const before = baseBefore && baseAfter ? await rgba(variant) : null;
    const after = before ? await rgba(cut.png) : null;
    if (!baseBefore || !baseAfter || !before || !after || before.data.length !== baseBefore.data.length) {
      result.push(cut.png);
      continue;
    }
    for (let i = 0; i < after.data.length; i += 4) {
      if (before.data.readUInt32LE(i) === baseBefore.data.readUInt32LE(i)) baseAfter.data.copy(after.data, i, i, i + 4);
    }
    const { width, height } = after.info;
    result.push(
      await sharp(after.data, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer(),
    );
  }
  return result;
}
