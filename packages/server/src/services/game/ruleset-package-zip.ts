// ──────────────────────────────────────────────
// A ruleset package zip, read (RM): the one reader the import, the check and the ruleset editor's open
// share. The zip is read in memory and never written anywhere: what comes out of it is the text of its
// manifest, its ruleset.json and its catalogs/<id>.json files, each read through the strict schemas, or
// the reasons it was refused. Nothing else in a zip is accepted, and nothing in one is ever run, served
// or loaded as code: a ruleset is data.
//
// The zip is read by the Engine's strict zip reader (lib/zip-reader.ts, which every archive the Engine
// did not make goes through: honest sizes, no shared data, inflating stopped at the declared size, the
// CRC checked, no ZIP64, encryption or split archives), and held here to what a ruleset package is:
//   - the end record has no comment, and the entry count is capped before the directory is read;
//   - the records lie back to back from the first byte to the directory: no data before, between or
//     after them;
//   - names are matched exactly against the few a ruleset package has; the only directory accepted is
//     an empty `catalogs/`, and no entry is a link;
//   - every file is capped by its kind before a byte of it is read.
// What comes out is each document as it was parsed (`JSON.stringify` of what was read), so a repeated
// key, a byte-order mark or padding in a file never reaches the store.
// ──────────────────────────────────────────────
import { createHash } from "node:crypto";
import {
  capabilityPackageManifestSchema,
  isRulesetCatalogAssetPath,
  parseRulesetCatalogFile,
  rulesetCatalogEntryIssues,
  type RulesetCatalogEntriesById,
  parseRulesetDefinition,
  rulesetShapeIssue,
  RULESET_CATALOG_MAX_BYTES,
  RULESET_MAX_BYTES,
  type RulesetDefinition,
} from "@marinara-engine/shared";
import { readZip, ZipReadError, type ZipFile } from "../../lib/zip-reader.js";

/** The most a ruleset package zip may be. */
export const RULESET_PACKAGE_ZIP_MAX_BYTES = 8 * 1024 * 1024;
/** Its manifest, its ruleset and at most 12 catalogs (a ruleset declares no more). */
const MAX_ENTRIES = 14;
const MANIFEST_MAX_BYTES = 64 * 1024;
const TOTAL_MAX_BYTES = 16 * 1024 * 1024;
// Past the longest note in any ruleset the project ships (5e-2014 has one of 1,016 characters).
const COMMENT_MAX_CHARS = 2000;
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
  // Each issue names where it is, as a schema issue does, so an editor shows it there.
  const walk = (value: unknown, path: string): string | null => {
    const at = (key: string | number) => (path ? `${path}.${key}` : String(key));
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const issue = walk(item, at(index));
        if (issue) return issue;
      }
      return null;
    }
    if (!value || typeof value !== "object") return null;
    for (const [key, item] of Object.entries(value)) {
      if (key === "$comment" && (typeof item !== "string" || item.length > COMMENT_MAX_CHARS)) {
        return `${file} ${at(key)}: a $comment is a note of at most ${COMMENT_MAX_CHARS} characters`;
      }
      if (key === "$schema" && (path || typeof item !== "string" || !OWN_SCHEMA.test(item))) {
        return `${file} ${at(key)}: $schema may only name the Engine's own ruleset schema`;
      }
      const issue = walk(item, at(key));
      if (issue) return issue;
    }
    return null;
  };
  return walk(document, "");
}

/** The zip's files, read by the Engine's strict reader (`readZip`: honest sizes, no shared data, no
 *  ZIP64, encryption or split archives), held to what a ruleset package is besides: no comment, at
 *  most its few entries, and its records back to back from the first byte to the directory, with
 *  nothing before, between or after them. */
function zipFiles(bytes: Buffer): { files: ZipFile[] } | { issue: string } {
  const end = bytes.length - 22;
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50)
    return { issue: "The file is not a zip (or carries a comment)" };
  if (bytes.readUInt16LE(end + 20) !== 0) return { issue: "The zip carries a comment" };
  const count = bytes.readUInt16LE(end + 10);
  if (count > MAX_ENTRIES)
    return { issue: `The package has ${count} entries; a ruleset package has at most ${MAX_ENTRIES}` };
  let files: ZipFile[];
  try {
    files = readZip(bytes);
  } catch (error) {
    if (error instanceof ZipReadError) return { issue: error.message };
    throw error;
  }
  let next = 0;
  for (const file of [...files].sort((a, b) => a.span.start - b.span.start)) {
    if (file.span.start !== next) {
      return { issue: `"${file.name}" is not where the zip's directory says, or something lies beside it` };
    }
    next = file.span.end;
  }
  if (next !== bytes.readUInt32LE(end + 16)) return { issue: "The zip has data no entry names" };
  return { files };
}

/** A ruleset package zip, read and checked whole; nothing in it is kept unless all of it reads. Never
 *  throws: anything unexpected is a package that does not read. */
export function readRulesetPackageZip(bytes: Buffer): RulesetPackageRead {
  try {
    return readPackage(bytes);
  } catch {
    return refused("The package does not read");
  }
}

function readPackage(bytes: Buffer): RulesetPackageRead {
  if (bytes.length > RULESET_PACKAGE_ZIP_MAX_BYTES) {
    return refused(`The package is ${bytes.length} bytes, over the ${RULESET_PACKAGE_ZIP_MAX_BYTES}-byte limit`);
  }
  const listed = zipFiles(bytes);
  if ("issue" in listed) return refused(listed.issue);

  // ── Every entry, by its records, before any is read ──
  const issues: string[] = [];
  const files: Array<{ file: ZipFile; cap: number }> = [];
  const seen = new Set<string>();
  let total = 0;
  for (const file of listed.files) {
    const { name } = file;
    if (seen.has(name.toLowerCase())) issues.push(`"${name}" is in the package twice`);
    seen.add(name.toLowerCase());
    if (file.isSymlink) issues.push(`"${name}" is a link, not a file`);
    if (name.endsWith("/") || name.endsWith("\\")) {
      if (name !== "catalogs/" || file.size !== 0) issues.push(`"${name}" is not a file a ruleset package has`);
      continue;
    }
    const cap = capOf(name);
    if (cap === null) {
      issues.push(`"${name}" is not a file a ruleset package has (manifest.json, ruleset.json, catalogs/<id>.json)`);
      continue;
    }
    if (file.size > cap) issues.push(`"${name}" is over its ${cap}-byte limit`);
    total += file.size;
    files.push({ file, cap });
  }
  if (total > TOTAL_MAX_BYTES) issues.push(`The package holds over ${TOTAL_MAX_BYTES} bytes`);
  if (issues.length) return refused(...issues.slice(0, 20));

  // ── Each file, read one at a time, exactly its declared size, its CRC checked, as UTF-8 ──
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const texts = new Map<string, { text: string; data: Buffer }>();
  for (const { file, cap } of files) {
    let data: Buffer;
    try {
      data = file.read(cap);
    } catch (error) {
      if (error instanceof ZipReadError) return refused(error.message);
      throw error;
    }
    try {
      texts.set(file.name, { text: decoder.decode(data), data });
    } catch {
      return refused(`"${file.name}" is not UTF-8 text`);
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
  const entriesById: RulesetCatalogEntriesById = {};
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
    entriesById[catalog.id] = read.entries;
  }
  const complete = {
    ...definition,
    catalogs: definition.catalogs?.map((catalog) => ({
      ...catalog,
      entries: [...(entriesById[catalog.id] ?? catalog.entries ?? [])],
    })),
  };
  for (const catalog of complete.catalogs ?? []) {
    if (!catalog.entries?.some((entry) => entry.creature?.spellcasting)) continue;
    const issues = rulesetCatalogEntryIssues(complete, catalog, catalog.entries ?? []);
    if (issues.length)
      return refused(...issues.slice(0, 10).map((issue) => `${catalog.id} ${issue.path.join(".")}: ${issue.message}`));
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
