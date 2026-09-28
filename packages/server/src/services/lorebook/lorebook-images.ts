import { constants } from "node:fs";
import { mkdir, open, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  LOREBOOK_ENTRY_IMAGE_PATH_PATTERN,
  MAX_LOREBOOK_ENTRY_IMAGES,
  type LorebookEntryImage,
} from "@marinara-engine/shared";
import { getDataDir } from "../../config/runtime-config.js";
import { isAllowedImageBuffer } from "../../utils/security.js";

export const LOREBOOK_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const lorebookImagesDirectory = () => join(getDataDir(), "lorebooks", "images", "entries");

export function lorebookImageInfo(buffer: Buffer) {
  const info = isAllowedImageBuffer(buffer);
  return buffer.length <= LOREBOOK_IMAGE_MAX_BYTES && info && ["png", "jpg", "webp"].includes(info.ext) ? info : null;
}

export async function saveLorebookImage(buffer: Buffer): Promise<LorebookEntryImage> {
  const info = lorebookImageInfo(buffer);
  if (!info) throw new Error("Reference images must be PNG, JPEG, or WebP and no larger than 5 MB");
  const filename = `${randomUUID()}.${info.ext}`;
  await mkdir(lorebookImagesDirectory(), { recursive: true });
  await writeFile(join(lorebookImagesDirectory(), filename), buffer, { flag: "wx" });
  return { path: `/api/lorebooks/entry-images/${filename}`, caption: "" };
}

/** Only for a newly uploaded file that failed to attach; saved references may be shared by copies. */
export async function discardLorebookImage(image: LorebookEntryImage): Promise<void> {
  if (!LOREBOOK_ENTRY_IMAGE_PATH_PATTERN.test(image.path)) return;
  await unlink(join(lorebookImagesDirectory(), image.path.slice(image.path.lastIndexOf("/") + 1)));
}

/** Strict server-generated paths, bounded reads, and no file symlink traversal. */
export async function readLorebookImageDataUrl(path: string): Promise<string | null> {
  if (!LOREBOOK_ENTRY_IMAGE_PATH_PATTERN.test(path)) return null;
  const filename = path.slice(path.lastIndexOf("/") + 1);
  try {
    const file = await open(join(lorebookImagesDirectory(), filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > LOREBOOK_IMAGE_MAX_BYTES) return null;
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead !== buffer.length) return null;
      const info = lorebookImageInfo(buffer);
      if (!info || !filename.endsWith(`.${info.ext}`)) return null;
      return `data:${info.mimeType};base64,${buffer.toString("base64")}`;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/** Both lorebook export formats carry bytes rather than another installation's paths. */
export async function embedLorebookImages(entries: Array<Record<string, unknown>>) {
  const portable: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const images: Array<{ dataUrl: string; caption: string }> = [];
    for (const image of (entry.images ?? []) as LorebookEntryImage[]) {
      const dataUrl = await readLorebookImageDataUrl(image.path);
      if (!dataUrl) throw new Error(`Cannot export missing reference image for ${String(entry.name)}`);
      images.push({ dataUrl, caption: image.caption });
    }
    portable.push({ ...entry, images });
  }
  return portable;
}

type DecodedLorebookImage = { caption: string } & ({ buffer: Buffer } | { path: string });

/** Validate the entire import before writing assets or replacing entries. */
export async function decodeLorebookImages(value: unknown, allowLocalPaths = false): Promise<DecodedLorebookImage[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LOREBOOK_ENTRY_IMAGES) throw new Error("Invalid reference images");
  return Promise.all(
    value.map(async (image: unknown): Promise<DecodedLorebookImage> => {
      if (!image || typeof image !== "object") throw new Error("Invalid reference image");
      const { dataUrl, path, caption = "" } = image as Record<string, unknown>;
      if (allowLocalPaths && typeof path === "string" && typeof caption === "string" && caption.length <= 500) {
        if (!(await readLorebookImageDataUrl(path))) throw new Error("Missing local reference image");
        return { path, caption };
      }
      if (typeof caption !== "string" || caption.length > 500 || typeof dataUrl !== "string")
        throw new Error("Invalid reference image");
      if (dataUrl.length > Math.ceil(LOREBOOK_IMAGE_MAX_BYTES / 3) * 4 + 64)
        throw new Error("Reference image too large");
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
      if (!match) throw new Error("Invalid reference image data");
      const buffer = Buffer.from(match[2]!, "base64");
      const info = lorebookImageInfo(buffer);
      if (!info || info.mimeType !== match[1] || buffer.toString("base64") !== match[2])
        throw new Error("Invalid reference image data");
      return { buffer, caption };
    }),
  );
}

export async function saveDecodedLorebookImages(decoded: DecodedLorebookImage[]): Promise<LorebookEntryImage[]> {
  const images: LorebookEntryImage[] = [];
  try {
    for (const image of decoded)
      images.push("path" in image ? image : { ...(await saveLorebookImage(image.buffer)), caption: image.caption });
  } catch (error) {
    for (const image of images)
      if (!decoded.some((item) => "path" in item && item.path === image.path)) await discardLorebookImage(image);
    throw error;
  }
  return images;
}

export async function restoreLorebookImages(value: unknown): Promise<LorebookEntryImage[]> {
  return saveDecodedLorebookImages(await decodeLorebookImages(value));
}

/** Keep local character mirrors small; embed bytes only at the export boundary. */
export async function embedCharacterBookImages<T extends Record<string, any>>(data: T): Promise<T> {
  const book = data.character_book;
  if (!book || !Array.isArray(book.entries)) return data;
  const entries = [];
  for (const entry of book.entries) {
    const images = entry.extensions?.marinaraImages;
    if (!Array.isArray(images) || !images.some((image: any) => typeof image?.path === "string")) {
      entries.push(entry);
      continue;
    }
    const [portable] = await embedLorebookImages([{ ...entry, images }]);
    entries.push({ ...entry, extensions: { ...entry.extensions, marinaraImages: portable!.images } });
  }
  return { ...data, character_book: { ...book, entries } };
}
