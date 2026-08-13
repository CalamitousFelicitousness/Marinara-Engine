import { open, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { assertInsideDir, isAllowedImageBuffer } from "./security.js";

const RASTER_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"]);
const SVG_EXTENSION = ".svg";
const IMAGE_HEADER_BYTES = 4096;

export type ValidatedImageAsset = {
  mimeType: string;
  isSvg: boolean;
};

export type ValidatedVideoAsset = {
  mimeType: string;
};

function normalizedRasterExtension(extension: string): string {
  return extension === ".jpeg" ? "jpg" : extension.slice(1);
}

/**
 * SVG remains a supported sprite/game-asset format, but active document
 * features are not needed for artwork and are unsafe on a same-origin route.
 */
export function isSafeSvgImageBuffer(buffer: Buffer): boolean {
  const source = buffer.toString("utf8");
  if (source.includes("\ufffd") || !/<svg(?:\s|>)/iu.test(source)) return false;
  return !(
    /<!doctype|<!entity/iu.test(source) ||
    /<(?:script|foreignObject|iframe|object|embed)(?:\s|>)/iu.test(source) ||
    /\bon[a-z][a-z0-9_-]*\s*=/iu.test(source) ||
    /\b(?:href|xlink:href)\s*=\s*["']?\s*(?:javascript|vbscript|data:text\/html)/iu.test(source) ||
    /(?:@import|expression\s*\(|-moz-binding\s*:)/iu.test(source)
  );
}

/** Validate bytes and ensure their detected type agrees with the filename. */
export function validateImageAssetBuffer(
  buffer: Buffer,
  filename: string,
  options: { allowSvg?: boolean } = {},
): ValidatedImageAsset | null {
  const extension = extname(filename).toLowerCase();
  if (extension === SVG_EXTENSION) {
    return options.allowSvg && isSafeSvgImageBuffer(buffer) ? { mimeType: "image/svg+xml", isSvg: true } : null;
  }
  if (!RASTER_IMAGE_EXTENSIONS.has(extension)) return null;
  const image = isAllowedImageBuffer(buffer, extension);
  if (!image || image.ext !== normalizedRasterExtension(extension)) return null;
  return { mimeType: image.mimeType, isSvg: false };
}

export function validateVideoAssetBuffer(buffer: Buffer, filename: string): ValidatedVideoAsset | null {
  const extension = extname(filename).toLowerCase();
  if (
    (extension === ".mp4" || extension === ".mov") &&
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString("ascii") === "ftyp"
  ) {
    return { mimeType: extension === ".mov" ? "video/quicktime" : "video/mp4" };
  }
  if (
    extension === ".webm" &&
    buffer.length >= 4 &&
    buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  ) {
    return { mimeType: "video/webm" };
  }
  return null;
}

/** Read only enough bytes to identify a raster image; SVG needs a full safety scan. */
export async function validateImageAssetFile(
  filePath: string,
  filename = basename(filePath),
  options: { allowSvg?: boolean } = {},
): Promise<ValidatedImageAsset | null> {
  if (extname(filename).toLowerCase() === SVG_EXTENSION) {
    try {
      return validateImageAssetBuffer(await readFile(filePath), filename, options);
    } catch {
      return null;
    }
  }

  let handle;
  try {
    handle = await open(filePath, "r");
    const header = Buffer.alloc(IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return validateImageAssetBuffer(header.subarray(0, bytesRead), filename, options);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function validateVideoAssetFile(filePath: string, filename = basename(filePath)) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const header = Buffer.alloc(IMAGE_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    return validateVideoAssetBuffer(header.subarray(0, bytesRead), filename);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Flat-file stores must never interpret an imported row value as a path. */
export function resolveFlatMediaFile(rootDir: string, storedFilePath: unknown): string | null {
  if (typeof storedFilePath !== "string" || !storedFilePath || storedFilePath.includes("\0")) return null;
  if (basename(storedFilePath) !== storedFilePath || storedFilePath.includes("/") || storedFilePath.includes("\\")) {
    return null;
  }
  try {
    return assertInsideDir(rootDir, join(rootDir, storedFilePath));
  } catch {
    return null;
  }
}
