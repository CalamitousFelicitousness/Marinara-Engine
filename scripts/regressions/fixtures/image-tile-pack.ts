/**
 * A small image tile pack (tile pack v2) for the lanes: PNG sheets written here, pixel by pixel, so no
 * art is checked in and every byte is known.
 */
import { deflateSync } from "node:zlib";
import type { ImageTilePack } from "../../../packages/shared/src/index.js";

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A PNG of `width` by `height`, each pixel's RGBA from `colour(x, y)`. */
export function pngBytes(width: number, height: number, colour: (x: number, y: number) => number[]): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(colour(x, y), y * (width * 4 + 1) + 1 + x * 4);
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const pngDataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;

/** A 48 px pack: one sheet four cells across and two down, grass in the first cell (two variants), a
 *  house sprite of two cells by two at the third, a tree one cell across and two down at the last. */
export function imageTilePack(extra: Partial<ImageTilePack> = {}): ImageTilePack {
  const sheet = pngBytes(192, 96, (x, y) =>
    x < 48
      ? [40, 140 + (y < 48 ? 0 : 20), 60, 255]
      : x < 96
        ? [0, 0, 0, 0]
        : x < 144
          ? [180, 80, 60, 255]
          : [30, 90, 40, 255],
  );
  return {
    tilePackVersion: 2,
    id: "riverlands-art",
    name: "Riverlands art",
    family: "fantasy",
    version: 1,
    tileSize: 48,
    sheets: [{ id: "town", png: pngDataUrl(sheet), width: 192, height: 96 }],
    tiles: {
      grass: [
        { sheet: "town", x: 0, y: 0 },
        { sheet: "town", x: 0, y: 1 },
      ],
      house: [{ sheet: "town", x: 2, y: 0, w: 2, h: 2 }],
      tree: [{ sheet: "town", x: 3, y: 0, h: 2 }],
    },
    ...extra,
  };
}
