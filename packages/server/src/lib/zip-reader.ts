// ──────────────────────────────────────────────
// Strict ZIP reader for archives the Engine did not create
// ──────────────────────────────────────────────
// Agent packages, custom Agent repositories, .charx cards and .marinara packages are read through
// this module. It accepts what common tools write (stored and deflated entries, data descriptors,
// ZIP64 records) and refuses an archive whose records disagree with each other, so the size an entry
// declares is the size a caller gets back. Every read names a byte limit.
import { posix } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

const END_SIGNATURE = 0x06054b50;
const END_SIZE = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_END_SIGNATURE = 0x06064b50;
const ZIP64_END_SIZE = 56;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_SIZE = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_SIZE = 30;
const DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
// Bit 0 (encrypted), bit 6 (strong encryption) and bit 13 (masked local headers).
const ENCRYPTED_FLAGS = 0x0001 | 0x0040 | 0x2000;
const DESCRIPTOR_FLAG = 0x0008;
const STORED = 0;
const DEFLATED = 8;

const NOT_A_ZIP = "The file is not a readable ZIP archive";
const END_RECORD_DAMAGED = "The ZIP archive's end record is damaged";
const SPLIT_ARCHIVE = "Split or multi-part ZIP archives are not supported";
const FILE_LIST_DAMAGED = "The ZIP archive's file list is damaged";
const OVERLAPPING_FILES = "Files inside the ZIP archive overlap";

/** A refusal whose message is plain enough to show the person who supplied the file. */
export class ZipArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipArchiveError";
  }
}

export interface ZipEntry {
  /** The entry's path inside the archive, decoded as UTF-8. */
  readonly entryName: string;
  readonly isDirectory: boolean;
  /** Uncompressed size from the central directory; `read` returns exactly this many bytes. */
  readonly size: number;
  /** External attributes; a Unix mode sits in the high 16 bits. */
  readonly attr: number;
  /** Decompress and verify the entry. One declared larger than `maxBytes` is refused without being read. */
  read(maxBytes: number): Buffer;
}

export interface ZipArchive {
  /** Every entry, in central directory order. */
  getEntries(): readonly ZipEntry[];
  /** The entry at this path (normalized as a POSIX path), or null. */
  getEntry(name: string): ZipEntry | null;
}

function refuse(message: string): never {
  throw new ZipArchiveError(message);
}

function label(name: string): string {
  return JSON.stringify(name.length > 120 ? `${name.slice(0, 120)}…` : name);
}

function readU64(buffer: Buffer, offset: number, message: string): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) refuse(message);
  return Number(value);
}

/** The one end record that closes the file exactly. A comment that ends somewhere else, or two
 *  records that both could, leave the archive without a single meaning. */
function findEndRecord(buffer: Buffer): number {
  const last = buffer.length - END_SIZE;
  let found = -1;
  for (let offset = last; offset >= Math.max(0, last - MAX_COMMENT_LENGTH); offset -= 1) {
    if (buffer[offset] !== 0x50 || buffer.readUInt32LE(offset) !== END_SIGNATURE) continue;
    if (offset + END_SIZE + buffer.readUInt16LE(offset + 20) !== buffer.length) continue;
    if (found !== -1) refuse("The ZIP archive has more than one end record");
    found = offset;
  }
  if (found === -1) refuse(NOT_A_ZIP);
  return found;
}

/** A classic end-record field holds its value, or all ones when the ZIP64 record carries it. */
function resolveZip64Field(classic: number, saturated: number, zip64: number): number {
  if (classic !== saturated && classic !== zip64) refuse(END_RECORD_DAMAGED);
  return zip64;
}

function readDirectoryLayout(buffer: Buffer, end: number) {
  let disk = buffer.readUInt16LE(end + 4);
  let directoryDisk = buffer.readUInt16LE(end + 6);
  let diskEntries = buffer.readUInt16LE(end + 8);
  let entryCount = buffer.readUInt16LE(end + 10);
  let directorySize = buffer.readUInt32LE(end + 12);
  let directoryOffset = buffer.readUInt32LE(end + 16);
  let recordsStart = end;

  const locator = end - ZIP64_LOCATOR_SIZE;
  if (locator >= 0 && buffer.readUInt32LE(locator) === ZIP64_LOCATOR_SIGNATURE) {
    if (buffer.readUInt32LE(locator + 4) !== 0 || buffer.readUInt32LE(locator + 16) > 1) refuse(SPLIT_ARCHIVE);
    const record = readU64(buffer, locator + 8, END_RECORD_DAMAGED);
    if (
      record + ZIP64_END_SIZE > locator ||
      buffer.readUInt32LE(record) !== ZIP64_END_SIGNATURE ||
      record + 12 + readU64(buffer, record + 4, END_RECORD_DAMAGED) !== locator
    ) {
      refuse(END_RECORD_DAMAGED);
    }
    disk = resolveZip64Field(disk, U16_MAX, buffer.readUInt32LE(record + 16));
    directoryDisk = resolveZip64Field(directoryDisk, U16_MAX, buffer.readUInt32LE(record + 20));
    diskEntries = resolveZip64Field(diskEntries, U16_MAX, readU64(buffer, record + 24, END_RECORD_DAMAGED));
    entryCount = resolveZip64Field(entryCount, U16_MAX, readU64(buffer, record + 32, END_RECORD_DAMAGED));
    directorySize = resolveZip64Field(directorySize, U32_MAX, readU64(buffer, record + 40, END_RECORD_DAMAGED));
    directoryOffset = resolveZip64Field(directoryOffset, U32_MAX, readU64(buffer, record + 48, END_RECORD_DAMAGED));
    recordsStart = record;
  }

  if (disk !== 0 || directoryDisk !== 0 || diskEntries !== entryCount) refuse(SPLIT_ARCHIVE);
  if (directoryOffset + directorySize > recordsStart || entryCount * CENTRAL_SIZE > directorySize) {
    refuse(FILE_LIST_DAMAGED);
  }
  return { entryCount, directoryOffset, directorySize };
}

function findExtraField(extra: Buffer, id: number): Buffer | null {
  for (let offset = 0; offset + 4 <= extra.length;) {
    const length = extra.readUInt16LE(offset + 2);
    if (offset + 4 + length > extra.length) return null;
    if (extra.readUInt16LE(offset) === id) return extra.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
  }
  return null;
}

/** Bytes taken by the data descriptor after an entry's data: 0 when none follows, null when one
 *  follows and disagrees with the central directory. Without its optional signature a descriptor
 *  is recognised by its CRC-32; anything else at that position is the next record. */
function descriptorLength(
  buffer: Buffer,
  start: number,
  limit: number,
  crc: number,
  compressedSize: number,
  size: number,
): number | null {
  let offset = start;
  const signed = offset + 4 <= limit && buffer.readUInt32LE(offset) === DESCRIPTOR_SIGNATURE;
  if (signed) offset += 4;
  if (offset + 4 > limit || buffer.readUInt32LE(offset) !== crc) return signed ? null : 0;
  offset += 4;
  if (
    offset + 8 <= limit &&
    buffer.readUInt32LE(offset) === compressedSize &&
    buffer.readUInt32LE(offset + 4) === size
  ) {
    return offset + 8 - start;
  }
  if (
    offset + 16 <= limit &&
    buffer.readBigUInt64LE(offset) === BigInt(compressedSize) &&
    buffer.readBigUInt64LE(offset + 8) === BigInt(size)
  ) {
    return offset + 16 - start;
  }
  return null;
}

export function openZipArchive(buffer: Buffer): ZipArchive {
  const { entryCount, directoryOffset, directorySize } = readDirectoryLayout(buffer, findEndRecord(buffer));
  const directoryEnd = directoryOffset + directorySize;
  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  const regions: Array<{ start: number; end: number }> = [];

  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + CENTRAL_SIZE > directoryEnd || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      refuse(FILE_LIST_DAMAGED);
    }
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const next = cursor + CENTRAL_SIZE + nameLength + extraLength + buffer.readUInt16LE(cursor + 32);
    if (next > directoryEnd) refuse(FILE_LIST_DAMAGED);

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    let compressedSize = buffer.readUInt32LE(cursor + 20);
    let size = buffer.readUInt32LE(cursor + 24);
    let diskStart = buffer.readUInt16LE(cursor + 34);
    const attr = buffer.readUInt32LE(cursor + 38);
    let localOffset = buffer.readUInt32LE(cursor + 42);
    const nameBytes = buffer.subarray(cursor + CENTRAL_SIZE, cursor + CENTRAL_SIZE + nameLength);
    const name = nameBytes.toString("utf8");

    // ZIP64 values appear only for the fields whose classic value is all ones, in this order.
    const zip64 = findExtraField(
      buffer.subarray(cursor + CENTRAL_SIZE + nameLength, cursor + CENTRAL_SIZE + nameLength + extraLength),
      ZIP64_EXTRA_FIELD,
    );
    if (zip64) {
      let offset = 0;
      const take = (bytes: 4 | 8) => {
        if (offset + bytes > zip64.length) refuse(FILE_LIST_DAMAGED);
        const value = bytes === 8 ? readU64(zip64, offset, FILE_LIST_DAMAGED) : zip64.readUInt32LE(offset);
        offset += bytes;
        return value;
      };
      if (size === U32_MAX) size = take(8);
      if (compressedSize === U32_MAX) compressedSize = take(8);
      if (localOffset === U32_MAX) localOffset = take(8);
      if (diskStart === U16_MAX) diskStart = take(4);
    }
    if (diskStart !== 0) refuse(SPLIT_ARCHIVE);
    if (byName.has(name)) refuse(`The ZIP archive lists ${label(name)} more than once`);

    // The local header must sit where the central directory says and describe the same file.
    const mismatch: () => never = () =>
      refuse(`The ZIP archive's file list does not match its contents at ${label(name)}`);
    if (localOffset + LOCAL_SIZE > directoryOffset || buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      mismatch();
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + LOCAL_SIZE + localNameLength + buffer.readUInt16LE(localOffset + 28);
    const dataEnd = dataStart + compressedSize;
    if (
      buffer.readUInt16LE(localOffset + 8) !== method ||
      dataEnd > directoryOffset ||
      !buffer.subarray(localOffset + LOCAL_SIZE, localOffset + LOCAL_SIZE + localNameLength).equals(nameBytes)
    ) {
      mismatch();
    }
    let regionEnd = dataEnd;
    if ((flags | localFlags) & DESCRIPTOR_FLAG) {
      const descriptor = descriptorLength(buffer, dataEnd, directoryOffset, crc, compressedSize, size);
      if (descriptor === null) mismatch();
      regionEnd += descriptor;
    }
    const encrypted = ((flags | localFlags) & ENCRYPTED_FLAGS) !== 0;
    if (method === STORED && !encrypted && compressedSize !== size) {
      refuse(`The ZIP archive gives two different sizes for ${label(name)}`);
    }
    regions.push({ start: localOffset, end: regionEnd });

    const isDirectory = name.endsWith("/") || name.endsWith("\\");
    const entry: ZipEntry = {
      entryName: name,
      isDirectory,
      size,
      attr,
      read(maxBytes: number): Buffer {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("A ZIP read needs a byte limit");
        if (isDirectory) return Buffer.alloc(0);
        if (size > maxBytes) refuse(`${label(name)} is too large`);
        if (encrypted) refuse(`${label(name)} is encrypted, which is not supported`);
        const compressed = buffer.subarray(dataStart, dataEnd);
        let data: Buffer;
        if (method === STORED) {
          data = Buffer.from(compressed);
        } else if (method === DEFLATED) {
          try {
            // Inflation stops at the declared size; a longer stream fails here instead of growing.
            data =
              size === 0 && compressedSize === 0
                ? Buffer.alloc(0)
                : inflateRawSync(compressed, { maxOutputLength: Math.max(size, 1) });
          } catch {
            refuse(`${label(name)} is damaged`);
          }
        } else {
          refuse(`${label(name)} uses a compression method that is not supported`);
        }
        if (data.length !== size || crc32(data) !== crc) refuse(`${label(name)} is damaged`);
        return data;
      },
    };
    entries.push(entry);
    byName.set(name, entry);
    cursor = next;
  }
  if (cursor !== directoryEnd) refuse(FILE_LIST_DAMAGED);

  // No two entries may share bytes: each one's header, data and descriptor stand alone.
  regions.sort((left, right) => left.start - right.start);
  for (let index = 1; index < regions.length; index += 1) {
    if (regions[index]!.start < regions[index - 1]!.end) refuse(OVERLAPPING_FILES);
  }

  return {
    getEntries: () => entries,
    getEntry: (name: string) => (name ? (byName.get(posix.normalize(name)) ?? null) : null),
  };
}
