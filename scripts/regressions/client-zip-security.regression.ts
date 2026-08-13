import assert from "node:assert/strict";
import { readTextFilesFromZip } from "../../packages/client/src/lib/read-zip-text.js";

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function write16(bytes: Uint8Array, offset: number, value: number) {
  new DataView(bytes.buffer).setUint16(offset, value, true);
}

function write32(bytes: Uint8Array, offset: number, value: number) {
  new DataView(bytes.buffer).setUint32(offset, value, true);
}

function storedZip(path: string, content: Uint8Array, declaredSize = content.byteLength) {
  const name = new TextEncoder().encode(path);
  const localSize = 30 + name.byteLength + content.byteLength;
  const centralSize = 46 + name.byteLength;
  const bytes = new Uint8Array(localSize + centralSize + 22);
  const checksum = crc32(content);

  write32(bytes, 0, 0x04034b50);
  write16(bytes, 4, 20);
  write32(bytes, 14, checksum);
  write32(bytes, 18, content.byteLength);
  write32(bytes, 22, declaredSize);
  write16(bytes, 26, name.byteLength);
  bytes.set(name, 30);
  bytes.set(content, 30 + name.byteLength);

  write32(bytes, localSize, 0x02014b50);
  write16(bytes, localSize + 4, 20);
  write16(bytes, localSize + 6, 20);
  write32(bytes, localSize + 16, checksum);
  write32(bytes, localSize + 20, content.byteLength);
  write32(bytes, localSize + 24, declaredSize);
  write16(bytes, localSize + 28, name.byteLength);
  write32(bytes, localSize + 42, 0);
  bytes.set(name, localSize + 46);

  const end = localSize + centralSize;
  write32(bytes, end, 0x06054b50);
  write16(bytes, end + 8, 1);
  write16(bytes, end + 10, 1);
  write32(bytes, end + 12, centralSize);
  write32(bytes, end + 16, localSize);
  return bytes;
}

const normal = storedZip("agent/manifest.json", new TextEncoder().encode('{"name":"safe"}'));
assert.deepEqual(
  await readTextFilesFromZip(new File([normal], "agent.zip", { type: "application/zip" })),
  [{ path: "agent/manifest.json", text: '{"name":"safe"}' }],
  "ordinary package ZIP imports remain available",
);

const corrupt = normal.slice();
corrupt[30 + new TextEncoder().encode("agent/manifest.json").byteLength] ^= 0xff;
await assert.rejects(
  readTextFilesFromZip(new File([corrupt], "corrupt.zip", { type: "application/zip" })),
  /checksum/u,
  "corrupted package entries must be rejected",
);

const oversized = storedZip("agent/manifest.json", new Uint8Array([0x78]), 2 * 1024 * 1024 + 1);
await assert.rejects(
  readTextFilesFromZip(new File([oversized], "oversized.zip", { type: "application/zip" })),
  /too large/u,
  "declared oversized entries must be rejected before extraction",
);

const mismatched = storedZip("agent/manifest.json", new TextEncoder().encode("{}"), 0);
await assert.rejects(
  readTextFilesFromZip(new File([mismatched], "mismatched.zip", { type: "application/zip" })),
  /unexpected size/u,
  "entries must match their declared uncompressed size exactly",
);

console.info("Client ZIP security regressions passed.");
