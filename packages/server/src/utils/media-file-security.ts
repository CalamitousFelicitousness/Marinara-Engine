import { open, realpath } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { getDataDir, getFileStorageDir } from "../config/runtime-config.js";
import { assertInsideDir, isAllowedImageBuffer } from "./security.js";

const RASTER_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"]);
const SVG_EXTENSION = ".svg";
const IMAGE_HEADER_BYTES = 4096;
const SVG_IMAGE_MAX_BYTES = 50 * 1024 * 1024;

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

function isXmlNameCharacter(character: string | undefined): boolean {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    character === "." ||
    character === "-" ||
    character === "_" ||
    character === ":"
  );
}

function skipXmlWhitespace(source: string, start: number): number {
  let cursor = start;
  while (
    source[cursor] === " " ||
    source[cursor] === "\t" ||
    source[cursor] === "\n" ||
    source[cursor] === "\r" ||
    source[cursor] === "\f"
  ) {
    cursor += 1;
  }
  return cursor;
}

/** Scan URL-valued SVG attributes without backtracking over attacker-controlled whitespace. */
function hasUnsafeSvgHref(source: string): boolean {
  const normalized = source.toLowerCase();
  for (const attribute of ["href", "xlink:href"] as const) {
    let searchFrom = 0;
    while (searchFrom < normalized.length) {
      const start = normalized.indexOf(attribute, searchFrom);
      if (start < 0) break;
      searchFrom = start + attribute.length;
      if (isXmlNameCharacter(normalized[start - 1]) || isXmlNameCharacter(normalized[searchFrom])) continue;

      let cursor = skipXmlWhitespace(normalized, searchFrom);
      if (normalized[cursor] !== "=") continue;
      cursor = skipXmlWhitespace(normalized, cursor + 1);
      if (normalized[cursor] === '"' || normalized[cursor] === "'") {
        cursor = skipXmlWhitespace(normalized, cursor + 1);
      }
      if (
        normalized.startsWith("javascript", cursor) ||
        normalized.startsWith("vbscript", cursor) ||
        normalized.startsWith("data:text/html", cursor)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Resolve symlinks and permit reads only from Marinara's configured media roots. */
async function resolveAllowedMediaPath(filePath: string): Promise<string | null> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(resolve(filePath));
  } catch {
    return null;
  }

  for (const configuredRoot of new Set([getDataDir(), getFileStorageDir()])) {
    try {
      const canonicalRoot = await realpath(resolve(configuredRoot));
      const rootPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
      if (canonicalPath === canonicalRoot || canonicalPath.startsWith(rootPrefix)) return canonicalPath;
    } catch {
      // A configured root may not exist yet; it cannot contain this file.
    }
  }
  return null;
}

/**
 * SVG remains a supported sprite/game-asset format, but active document
 * features are not needed for artwork and are unsafe on a same-origin route.
 */
export function isSafeSvgImageBuffer(buffer: Buffer): boolean {
  const source = buffer.toString("utf8");
  if (source.includes("\ufffd") || !/<svg(?:\s|>)/iu.test(source)) return false;
  // Preserve ordinary SVG 1.1 exports while rejecting internal subsets and
  // non-SVG declarations. Entity declarations remain forbidden below.
  const doctypeStart = source.search(/<!doctype/iu);
  let withoutPassiveDoctype = source;
  if (doctypeStart >= 0) {
    const doctypeEnd = source.indexOf(">", doctypeStart);
    if (doctypeEnd < 0) return false;
    const declaration = source.slice(doctypeStart, doctypeEnd + 1);
    const normalized = declaration.replace(/\s+/gu, " ").trim().toLowerCase();
    const passiveSvgDoctype =
      normalized === "<!doctype svg>" ||
      (/^<!doctype svg (?:public|system) /u.test(normalized) &&
        !normalized.includes("[") &&
        normalized.includes("www.w3.org/graphics/svg/") &&
        normalized.endsWith(">"));
    if (!passiveSvgDoctype) return false;
    withoutPassiveDoctype = `${source.slice(0, doctypeStart)} ${source.slice(doctypeEnd + 1)}`;
  }
  return !(
    /<!doctype|<!entity/iu.test(withoutPassiveDoctype) ||
    /<(?:script|foreignObject|iframe|object|embed)(?:\s|>)/iu.test(source) ||
    /\bon[a-z][a-z0-9_-]*\s*=/iu.test(source) ||
    hasUnsafeSvgHref(source) ||
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
  const safeFilePath = await resolveAllowedMediaPath(filePath);
  if (!safeFilePath) return null;
  if (extname(filename).toLowerCase() === SVG_EXTENSION) {
    if (!options.allowSvg) return null;
    let handle;
    try {
      handle = await open(safeFilePath, "r");
      const file = await handle.stat();
      if (!file.isFile() || file.size > SVG_IMAGE_MAX_BYTES) return null;
      const bytes = Buffer.alloc(file.size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== file.size) return null;
      return validateImageAssetBuffer(bytes.subarray(0, bytesRead), filename, options);
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  let handle;
  try {
    handle = await open(safeFilePath, "r");
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
  const safeFilePath = await resolveAllowedMediaPath(filePath);
  if (!safeFilePath) return null;
  let handle;
  try {
    handle = await open(safeFilePath, "r");
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
