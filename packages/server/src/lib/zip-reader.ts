// ──────────────────────────────────────────────
// A zip the Engine did not make (a capability package, a repository archive, a .charx or .marinara
// file), read strictly and in memory. adm-zip trusts what an archive says about itself: it hands back
// a stored entry's bytes whatever size the entry declares, lets any number of entries point at one
// stretch of data, and inflates up to whatever size is declared. A size budget over the declared sizes
// is then no budget at all. Here the archive has to be honest before anything in it is read:
//   - the end record is found exactly (a comment must run to the end of the file); no ZIP64, no split
//     archive;
//   - the directory's records fill exactly the size it names, in the number it names;
//   - each local record is where its directory record says, with the same name and method;
//   - no two entries' data overlap, and none runs into the directory;
//   - a stored entry's two sizes agree, and no entry is encrypted.
// Reading one entry then takes a cap from the caller, inflates exactly its declared size (never more),
// and checks the length and the CRC. Nothing is extracted to disk here, and links are reported, never
// followed.
// ──────────────────────────────────────────────
import { crc32, inflateRawSync } from "node:zlib";

/** Why an archive, or one entry in it, cannot be read. Its message is plain enough to show. */
export class ZipReadError extends Error {}

export interface ZipFile {
  /** The entry's path in the archive, as its directory record names it. */
  name: string;
  isDirectory: boolean;
  /** A symbolic link, by its Unix mode. Its target is never followed. */
  isSymlink: boolean;
  /** Its size once read, as declared, and exactly what `read` returns. */
  size: number;
  /** Where its record lies in the archive: from its local record to the end of its data (and of the
   *  data descriptor after it, when it has one), for a caller that wants nothing between records. */
  span: { start: number; end: number };
  /** Its bytes: exactly `size` of them, their CRC checked. Refused, unread, when `size` is over
   *  `maxBytes`, so every caller says what it will take. */
  read(maxBytes: number): Buffer;
}

const END_RECORD = 0x06054b50;
const DIRECTORY_RECORD = 0x02014b50;
const LOCAL_RECORD = 0x04034b50;
const DESCRIPTOR_RECORD = 0x08074b50;
const ZIP64_MARK = 0xffffffff;

const fail = (message: string): never => {
  throw new ZipReadError(message);
};

/** Where the end record is: the one whose comment runs exactly to the end of the file. */
function findEndRecord(bytes: Buffer): number {
  let trailing = false;
  for (let at = bytes.length - 22; at >= 0 && at >= bytes.length - 22 - 0xffff; at--) {
    if (bytes.readUInt32LE(at) !== END_RECORD) continue;
    if (at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) return at;
    trailing = true;
  }
  return fail(trailing ? "The zip archive has data after its end" : "The file is not a zip archive");
}

/** The archive's entries, each checked against its local record; throws `ZipReadError`. */
export function readZip(bytes: Buffer): ZipFile[] {
  const end = findEndRecord(bytes);
  const count = bytes.readUInt16LE(end + 10);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== count) {
    fail("The zip archive is split across disks");
  }
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (directorySize === ZIP64_MARK || directoryStart === ZIP64_MARK || count === 0xffff) {
    fail("The zip archive is a ZIP64 archive, which the Engine does not read");
  }
  if (directoryStart + directorySize !== end) fail("The zip archive's directory is not where it says");

  const entries: Array<{
    name: string;
    nameBytes: Buffer;
    method: number;
    flags: number;
    crc: number;
    compressedSize: number;
    size: number;
    offset: number;
    mode: number;
    dataStart: number;
    end: number;
  }> = [];
  let at = directoryStart;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== DIRECTORY_RECORD) fail("The zip archive's directory does not read");
    const nameLength = bytes.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    if (next > end) fail("The zip archive's directory does not read");
    const compressedSize = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const offset = bytes.readUInt32LE(at + 42);
    if (compressedSize === ZIP64_MARK || size === ZIP64_MARK || offset === ZIP64_MARK) {
      fail("The zip archive is a ZIP64 archive, which the Engine does not read");
    }
    if (bytes.readUInt16LE(at + 34) !== 0) fail("The zip archive is split across disks");
    const nameBytes = Buffer.from(bytes.subarray(at + 46, at + 46 + nameLength));
    const name = nameBytes.toString("utf8");
    const flags = bytes.readUInt16LE(at + 8);
    if (flags & 1) fail(`"${name}" in the zip archive is encrypted`);
    const method = bytes.readUInt16LE(at + 10);
    if (method === 0 && compressedSize !== size) fail(`"${name}" in the zip archive says two different sizes`);
    entries.push({
      name,
      nameBytes,
      method,
      flags,
      crc: bytes.readUInt32LE(at + 16),
      compressedSize,
      size,
      offset,
      // The high half of the external attributes is a Unix type and mode, read whatever the archive
      // says made it (as adm-zip did), so a link is never missed for a maker that does not say Unix.
      mode: bytes.readUInt32LE(at + 38) >>> 16,
      dataStart: 0,
      end: 0,
    });
    at = next;
  }
  // The directory's records fill exactly the size it names: none hides past the count.
  if (at !== end) fail("The zip archive's directory holds more than its entries");

  // Each local record where its directory record says, and no two entries' data overlapping: data
  // descriptors and gaps may sit between them, but one stretch of data is never two entries.
  const order = [...entries].sort((a, b) => a.offset - b.offset);
  let free = 0;
  for (const entry of order) {
    const start = entry.offset;
    if (start < free || start + 30 > directoryStart || bytes.readUInt32LE(start) !== LOCAL_RECORD) {
      fail(`"${entry.name}" in the zip archive is not where its directory says, or shares its data`);
    }
    const nameLength = bytes.readUInt16LE(start + 26);
    const localName = bytes.subarray(start + 30, start + 30 + nameLength);
    if (!localName.equals(entry.nameBytes) || bytes.readUInt16LE(start + 8) !== entry.method) {
      fail(`"${entry.name}" in the zip archive is named or packed one way in its directory and another by its data`);
    }
    entry.dataStart = start + 30 + nameLength + bytes.readUInt16LE(start + 28);
    free = entry.dataStart + entry.compressedSize;
    if (free > directoryStart) fail(`"${entry.name}" in the zip archive runs into its directory`);
    // A data descriptor follows the data when the record says so: 12 bytes, 16 with its signature.
    entry.end =
      entry.flags & 8
        ? free + (free + 4 <= directoryStart && bytes.readUInt32LE(free) === DESCRIPTOR_RECORD ? 16 : 12)
        : free;
  }

  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.name.endsWith("/"),
    isSymlink: (entry.mode & 0o170000) === 0o120000,
    size: entry.size,
    span: { start: entry.offset, end: entry.end },
    read(maxBytes: number): Buffer {
      if (entry.size > maxBytes) fail(`"${entry.name}" is over the ${maxBytes}-byte limit`);
      if (entry.method !== 0 && entry.method !== 8) {
        fail(`"${entry.name}" is compressed in a way the Engine does not read`);
      }
      const packed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
      let data: Buffer;
      try {
        // Inflating stops at the declared size, so a small entry cannot unpack into a large one.
        // (An empty entry some writers mark as deflated holds no deflate stream at all.)
        data =
          entry.method === 0 || packed.length === 0
            ? Buffer.from(packed)
            : inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.size) });
      } catch {
        return fail(`"${entry.name}" in the zip archive does not unpack, or is bigger than it says`);
      }
      if (data.length !== entry.size) fail(`"${entry.name}" in the zip archive is not the size it says`);
      if (crc32(data) !== entry.crc)
        fail(`"${entry.name}" in the zip archive is damaged (its checksum does not match)`);
      return data;
    },
  }));
}
