// ──────────────────────────────────────────────
// A ruleset package zip, read (RM): the one reader the import, the check and the ruleset editor's open
// share. The zip is read in memory and never written anywhere: what comes out of it is the text of its
// manifest, its ruleset.json and its catalogs/<id>.json files, each read through the strict schemas, or
// the reasons it was refused. Nothing else in a zip is accepted, and nothing in one is ever run, served
// or loaded as code: a ruleset is data.
//
// The zip is parsed here, strictly, and by nothing else (adm-zip parses a whole directory before any
// check, trusts an entry's own sizes, and reads past records it does not list):
//   - the end record has no comment, and the directory it names ends right where it starts;
//   - the entry count comes from it, BEFORE the directory is read, and the directory's records must fill
//     exactly the size it names, so no record hides past the count;
//   - each local record's name and method are its directory record's, and the records lie back to back
//     from the first byte to the directory: no data before, between or after them, none shared;
//   - names are matched exactly against the few a ruleset package has; the only directory accepted is
//     an empty `catalogs/`;
//   - every size is capped before a byte is inflated, a stored entry's two sizes agree, inflating stops
//     at the declared size, and the CRC is checked;
//   - no ZIP64, encryption or links.
// What comes out is each document as it was parsed (`JSON.stringify` of what was read), so a repeated
// key, a byte-order mark or padding in a file never reaches the store.
// ──────────────────────────────────────────────
import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import {
  capabilityPackageManifestSchema,
  isRulesetCatalogAssetPath,
  parseRulesetCatalogFile,
  parseRulesetDefinition,
  rulesetShapeIssue,
  RULESET_CATALOG_MAX_BYTES,
  RULESET_MAX_BYTES,
  type RulesetDefinition,
} from "@marinara-engine/shared";

/** The most a ruleset package zip may be. */
export const RULESET_PACKAGE_ZIP_MAX_BYTES = 8 * 1024 * 1024;
/** Its manifest, its ruleset and at most 12 catalogs (a ruleset declares no more). */
const MAX_ENTRIES = 14;
const MANIFEST_MAX_BYTES = 64 * 1024;
const TOTAL_MAX_BYTES = 16 * 1024 * 1024;
const COMMENT_MAX_CHARS = 500;
/** The `$schema` an author may point at: the Engine's own published schema. */
const OWN_SCHEMA =
  /^https:\/\/raw\.githubusercontent\.com\/Pasta-Devs\/Marinara-Engine\/(?:main|staging)\/docs\/extending\/ruleset\.schema\.json$/;

export type RulesetPackageRead =
  | {
      ok: true;
      definition: RulesetDefinition;
      /** Each document as it was read (re-serialized: no repeated keys, padding or byte-order mark). */
      ruleset: string;
      catalogs: Record<string, string>;
      manifest: string;
    }
  | { ok: false; issues: string[] };

const refused = (...issues: string[]): RulesetPackageRead => ({ ok: false, issues });
const sha256Of = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** The cap on a file's size, by its name; null for a name a ruleset package does not have. */
function capOf(name: string): number | null {
  if (name === "manifest.json") return MANIFEST_MAX_BYTES;
  if (name === "ruleset.json") return RULESET_MAX_BYTES;
  return isRulesetCatalogAssetPath(name) ? RULESET_CATALOG_MAX_BYTES : null;
}

/** Why a document carries more than a ruleset: a long `$comment` anywhere, a `$schema` not the Engine's. */
function extraContent(document: unknown, file: string): string | null {
  const walk = (value: unknown, root: boolean): string | null => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const issue = walk(item, false);
        if (issue) return issue;
      }
      return null;
    }
    if (!value || typeof value !== "object") return null;
    for (const [key, item] of Object.entries(value)) {
      if (key === "$comment" && (typeof item !== "string" || item.length > COMMENT_MAX_CHARS)) {
        return `${file}: a $comment is a note of at most ${COMMENT_MAX_CHARS} characters`;
      }
      if (key === "$schema" && (!root || typeof item !== "string" || !OWN_SCHEMA.test(item))) {
        return `${file}: $schema may only name the Engine's own ruleset schema`;
      }
      const issue = walk(item, false);
      if (issue) return issue;
    }
    return null;
  };
  return walk(document, true);
}

/** One file of the zip, as its directory and local records agree it is. */
interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  /** Unix file type and mode, when the zip was made on Unix. */
  mode: number | null;
  dataStart: number;
}

/** The zip's entries, by its directory, each checked against its local record; or why it is refused. */
function zipEntries(bytes: Buffer): { entries: ZipEntry[] } | { issue: string } {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const end = bytes.length - 22;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50)
    return { issue: "The file is not a zip (or carries a comment)" };
  if (bytes.readUInt16LE(end + 20) !== 0) return { issue: "The zip carries a comment" };
  const count = bytes.readUInt16LE(end + 10);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== count) {
    return { issue: "The zip is split across disks" };
  }
  if (count > MAX_ENTRIES)
    return { issue: `The package has ${count} entries; a ruleset package has at most ${MAX_ENTRIES}` };
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if (directoryStart + directorySize !== end) return { issue: "The zip has data where its directory should end" };
  const entries: ZipEntry[] = [];
  const names: Buffer[] = [];
  let at = directoryStart;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) return { issue: "The zip's directory does not read" };
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const offset = bytes.readUInt32LE(at + 42);
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      return { issue: "The zip is a ZIP64, which a ruleset package never needs" };
    }
    if (bytes.readUInt16LE(at + 34) !== 0) return { issue: "The zip is split across disks" };
    const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
    let name: string;
    try {
      name = decoder.decode(nameBytes);
    } catch {
      return { issue: "A name in the zip is not UTF-8" };
    }
    const madeOnUnix = bytes.readUInt8(at + 5) === 3;
    entries.push({
      name,
      method: bytes.readUInt16LE(at + 10),
      flags: bytes.readUInt16LE(at + 8),
      crc: bytes.readUInt32LE(at + 16),
      compressedSize,
      size,
      mode: madeOnUnix ? bytes.readUInt32LE(at + 38) >>> 16 : null,
      dataStart: offset,
    });
    names.push(Buffer.from(nameBytes));
    at += 46 + nameLength + extraLength + commentLength;
  }
  // The directory's records fill exactly the size it names: no record past the count.
  if (at !== end) return { issue: "The zip's directory holds more than its entries" };
  // Each local record matches its directory record, and they lie back to back from the first byte.
  const order = entries.map((entry, index) => ({ entry, index })).sort((a, b) => a.entry.dataStart - b.entry.dataStart);
  let next = 0;
  for (const { entry, index } of order) {
    const start = entry.dataStart;
    if (start !== next || start + 30 > directoryStart || bytes.readUInt32LE(start) !== 0x04034b50) {
      return { issue: `"${entry.name}" is not where the zip's directory says, or something lies beside it` };
    }
    const localName = bytes.subarray(start + 30, start + 30 + bytes.readUInt16LE(start + 26));
    if (!localName.equals(names[index]!) || bytes.readUInt16LE(start + 8) !== entry.method) {
      return { issue: `"${entry.name}" is named or packed one way in the zip's directory and another beside its data` };
    }
    entry.dataStart = start + 30 + localName.length + bytes.readUInt16LE(start + 28);
    let recordEnd = entry.dataStart + entry.compressedSize;
    // A data descriptor follows the data when the record says so: 12 bytes, 16 with its signature.
    if (entry.flags & 8)
      recordEnd += recordEnd + 4 <= directoryStart && bytes.readUInt32LE(recordEnd) === 0x08074b50 ? 16 : 12;
    if (recordEnd > directoryStart) return { issue: `"${entry.name}" runs into the zip's directory` };
    next = recordEnd;
  }
  if (next !== directoryStart) return { issue: "The zip has data no entry names" };
  return { entries };
}

/** A ruleset package zip, read and checked whole; nothing in it is kept unless all of it reads. Never
 *  throws: anything unexpected is a package that does not read. */
export function readRulesetPackageZip(bytes: Buffer): RulesetPackageRead {
  try {
    return readZip(bytes);
  } catch {
    return refused("The package does not read");
  }
}

function readZip(bytes: Buffer): RulesetPackageRead {
  if (bytes.length > RULESET_PACKAGE_ZIP_MAX_BYTES) {
    return refused(`The package is ${bytes.length} bytes, over the ${RULESET_PACKAGE_ZIP_MAX_BYTES}-byte limit`);
  }
  const listed = zipEntries(bytes);
  if ("issue" in listed) return refused(listed.issue);

  // ── Every entry, by its records, before any is read ──
  const issues: string[] = [];
  const files: ZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of listed.entries) {
    const { name } = entry;
    if (seen.has(name.toLowerCase())) issues.push(`"${name}" is in the package twice`);
    seen.add(name.toLowerCase());
    if (entry.mode !== null && (entry.mode & 0o170000) === 0o120000) issues.push(`"${name}" is a link, not a file`);
    if (entry.flags & 1) issues.push(`"${name}" is encrypted`);
    if (name.endsWith("/") || name.endsWith("\\")) {
      if (name !== "catalogs/" || entry.size !== 0 || entry.compressedSize !== 0)
        issues.push(`"${name}" is not a file a ruleset package has`);
      continue;
    }
    const cap = capOf(name);
    if (cap === null) {
      issues.push(`"${name}" is not a file a ruleset package has (manifest.json, ruleset.json, catalogs/<id>.json)`);
      continue;
    }
    if (entry.method !== 0 && entry.method !== 8)
      issues.push(`"${name}" is compressed in a way the Engine does not read`);
    if (entry.size > cap || entry.compressedSize > cap) issues.push(`"${name}" is over its ${cap}-byte limit`);
    if (entry.method === 0 && entry.compressedSize !== entry.size) issues.push(`"${name}" says two sizes`);
    total += entry.size;
    files.push(entry);
  }
  if (total > TOTAL_MAX_BYTES) issues.push(`The package holds over ${TOTAL_MAX_BYTES} bytes`);
  if (issues.length) return refused(...issues.slice(0, 20));

  // ── Each file, read one at a time, exactly its declared size, its CRC checked, as UTF-8 ──
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const texts = new Map<string, { text: string; data: Buffer }>();
  for (const entry of files) {
    const packed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
    let data: Buffer;
    try {
      data =
        entry.method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      return refused(`"${entry.name}" does not read, or is bigger than it says`);
    }
    if (data.length !== entry.size) return refused(`"${entry.name}" is not the size it says`);
    if (crc32(data) !== entry.crc) return refused(`"${entry.name}" is damaged (its checksum does not match)`);
    try {
      texts.set(entry.name, { text: decoder.decode(data), data });
    } catch {
      return refused(`"${entry.name}" is not UTF-8 text`);
    }
  }

  // ── The documents ──
  const json = (name: string): { value: unknown } | { issue: string } => {
    const file = texts.get(name);
    if (!file) return { issue: `The package has no ${name}` };
    let value: unknown;
    try {
      value = JSON.parse(file.text);
    } catch {
      return { issue: `${name} is not valid JSON` };
    }
    // Its shape before anything walks it: no nesting or list beyond what a ruleset ever has.
    const shape = rulesetShapeIssue(value);
    return shape ? { issue: `${name} ${shape}` } : { value };
  };
  const manifestJson = json("manifest.json");
  if ("issue" in manifestJson) return refused(manifestJson.issue);
  const manifestRead = capabilityPackageManifestSchema.safeParse(manifestJson.value);
  if (!manifestRead.success) {
    return refused(
      ...manifestRead.error.issues
        .slice(0, 5)
        .map((issue) => `manifest.json ${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  const manifest = manifestRead.data;
  const { kind, entrypoints, permissions, localizations, restartRequired, contributions } = manifest;
  // A ruleset package and nothing else: no code to run, nothing to grant, nothing on screen.
  if (kind.length !== 1 || kind[0] !== "ruleset")
    issues.push("manifest.json: a ruleset package is of the kind ruleset alone");
  if (Object.keys(entrypoints).length) issues.push("manifest.json: a ruleset package has no entrypoints (no code)");
  if (permissions.length) issues.push("manifest.json: a ruleset package asks for no permissions");
  if (localizations) issues.push("manifest.json: a ruleset package has no localizations");
  if (restartRequired) issues.push("manifest.json: a ruleset package needs no restart");
  const contributionKeys = Object.keys(contributions ?? {});
  if (contributionKeys.length !== 1 || contributionKeys[0] !== "assets") {
    issues.push("manifest.json: a ruleset package contributes its assets and nothing else");
  }
  const contents = [...texts.keys()].filter((name) => name !== "manifest.json").sort();
  const assets = [...(contributions?.assets?.paths ?? [])].sort();
  if (JSON.stringify(assets) !== JSON.stringify(contents)) {
    issues.push("manifest.json: its assets are not the package's ruleset and catalog files");
  }
  // Both sorted the same way, by code unit (a locale's order puts "_" before "." and before digits).
  const declared = [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (JSON.stringify(declared.map((file) => file.path)) !== JSON.stringify(contents)) {
    issues.push("manifest.json: its files are not the package's ruleset and catalog files");
  } else {
    for (const file of declared) {
      const data = texts.get(file.path)!.data;
      if (data.length !== file.bytes || sha256Of(data) !== file.sha256)
        issues.push(`manifest.json: ${file.path} is not the file it lists`);
    }
  }
  if (issues.length) return refused(...issues);

  const rulesetJson = json("ruleset.json");
  if ("issue" in rulesetJson) return refused(rulesetJson.issue);
  const extra = extraContent(rulesetJson.value, "ruleset.json");
  if (extra) return refused(extra);
  const parsed = parseRulesetDefinition(rulesetJson.value);
  if (!parsed.ok) return refused(...parsed.issues.map((issue) => `ruleset.json ${issue}`));
  const definition = parsed.definition;

  // Its catalog files, exactly the ones the ruleset names.
  const catalogs: Record<string, string> = {};
  const named = (definition.catalogs ?? []).filter((catalog) => catalog.asset);
  for (const catalog of named) {
    const file = catalog.asset!;
    const document = json(file);
    if ("issue" in document) return refused(`${document.issue} (the catalog "${catalog.id}")`);
    const extraInCatalog = extraContent(document.value, file);
    if (extraInCatalog) return refused(extraInCatalog);
    const read = parseRulesetCatalogFile(definition, catalog.id, document.value);
    if (!read.ok) return refused(...read.issues.slice(0, 10).map((issue) => `${file} ${issue}`));
    catalogs[catalog.id] = JSON.stringify(document.value);
  }
  const unnamed = contents.filter(
    (name) => name !== "ruleset.json" && !named.some((catalog) => catalog.asset === name),
  );
  if (unnamed.length) return refused(`${unnamed[0]} is not a catalog the ruleset names`);

  return {
    ok: true,
    definition,
    ruleset: JSON.stringify(rulesetJson.value),
    catalogs,
    manifest: JSON.stringify(manifestJson.value),
  };
}
