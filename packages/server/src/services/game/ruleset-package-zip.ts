// ──────────────────────────────────────────────
// A ruleset package zip, read (RM): the one reader the import, the check and the ruleset editor's open
// share. The zip is read in memory and never written anywhere: what comes out of it is the text of its
// manifest, its ruleset.json and its catalogs/<id>.json files, each read through the strict schemas, or
// the reasons it was refused. Nothing else in a zip is accepted, and nothing in one is ever run, served
// or loaded as code: a ruleset is data.
//
// adm-zip 0.6.1 is careful in some ways and not others, so every limit is ours, checked before the
// bytes are read:
//   - the entry count comes from the end record, BEFORE the directory is parsed (a few megabytes of
//     directory entries cost hundreds of megabytes of heap to parse);
//   - a STORED entry returns its compressed bytes whatever size it declares, so its two sizes must be
//     equal, and every entry's within its file's cap;
//   - a name ending in a slash is a directory to adm-zip whatever it holds, so the only directory
//     accepted is an empty `catalogs/`;
//   - names are matched exactly against the few a ruleset package has.
// ──────────────────────────────────────────────
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import {
  capabilityPackageManifestSchema,
  isRulesetCatalogAssetPath,
  parseRulesetCatalogFile,
  parseRulesetDefinition,
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
      /** The texts, exactly as the zip has them. */
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

/** A ruleset package zip, read and checked whole; nothing in it is kept unless all of it reads. */
export function readRulesetPackageZip(bytes: Buffer): RulesetPackageRead {
  if (bytes.length > RULESET_PACKAGE_ZIP_MAX_BYTES) {
    return refused(`The package is ${bytes.length} bytes, over the ${RULESET_PACKAGE_ZIP_MAX_BYTES}-byte limit`);
  }
  let zip: AdmZip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    return refused("The file is not a zip");
  }
  // From the end record, before the directory is read.
  const count = zip.getEntryCount();
  if (count > MAX_ENTRIES) {
    return refused(`The package has ${count} entries; a ruleset package has at most ${MAX_ENTRIES}`);
  }
  let entries: AdmZip.IZipEntry[];
  try {
    entries = zip.getEntries();
  } catch {
    return refused("The zip's directory does not read");
  }

  // ── Every entry, by its directory record, before any is read ──
  const issues: string[] = [];
  const files: AdmZip.IZipEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    const name = entry.entryName;
    const header = entry.header;
    if (seen.has(name.toLowerCase())) issues.push(`"${name}" is in the package twice`);
    seen.add(name.toLowerCase());
    if (((entry.attr >>> 16) & 0o170000) === 0o120000) issues.push(`"${name}" is a link, not a file`);
    if (header.flags & 1) issues.push(`"${name}" is encrypted`);
    if (entry.isDirectory) {
      if (name !== "catalogs/" || header.size !== 0 || header.compressedSize !== 0) {
        issues.push(`"${name}" is not a file a ruleset package has`);
      }
      continue;
    }
    const cap = capOf(name);
    if (cap === null) {
      issues.push(`"${name}" is not a file a ruleset package has (manifest.json, ruleset.json, catalogs/<id>.json)`);
      continue;
    }
    if (header.method !== 0 && header.method !== 8)
      issues.push(`"${name}" is compressed in a way the Engine does not read`);
    if (header.size > cap || header.compressedSize > cap) issues.push(`"${name}" is over its ${cap}-byte limit`);
    if (header.method === 0 && header.compressedSize !== header.size) issues.push(`"${name}" says two sizes`);
    total += header.size;
    files.push(entry);
  }
  if (total > TOTAL_MAX_BYTES) issues.push(`The package holds over ${TOTAL_MAX_BYTES} bytes`);
  // No two entries may share bytes: each local record starts after the one before it ends.
  const byOffset = [...files].sort((a, b) => a.header.offset - b.header.offset);
  for (let index = 1; index < byOffset.length; index++) {
    const before = byOffset[index - 1]!;
    const minimumEnd = before.header.offset + 30 + Buffer.byteLength(before.entryName) + before.header.compressedSize;
    if (byOffset[index]!.header.offset < minimumEnd)
      issues.push(`"${byOffset[index]!.entryName}" shares bytes with another entry`);
  }
  if (issues.length) return refused(...issues.slice(0, 20));

  // ── Each file, read one at a time, exactly its declared size, as UTF-8 ──
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const texts = new Map<string, { text: string; data: Buffer }>();
  for (const entry of files) {
    let data: Buffer;
    try {
      data = entry.getData();
    } catch {
      return refused(`"${entry.entryName}" does not read`);
    }
    if (data.length !== entry.header.size) return refused(`"${entry.entryName}" is not the size it says`);
    try {
      texts.set(entry.entryName, { text: decoder.decode(data), data });
    } catch {
      return refused(`"${entry.entryName}" is not UTF-8 text`);
    }
  }

  // ── The documents ──
  const json = (name: string): { value: unknown } | { issue: string } => {
    const file = texts.get(name);
    if (!file) return { issue: `The package has no ${name}` };
    try {
      return { value: JSON.parse(file.text) };
    } catch {
      return { issue: `${name} is not valid JSON` };
    }
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
  const declared = [...manifest.files].sort((a, b) => a.path.localeCompare(b.path));
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
    catalogs[catalog.id] = texts.get(file)!.text;
  }
  const unnamed = contents.filter(
    (name) => name !== "ruleset.json" && !named.some((catalog) => catalog.asset === name),
  );
  if (unnamed.length) return refused(`${unnamed[0]} is not a catalog the ruleset names`);

  return {
    ok: true,
    definition,
    ruleset: texts.get("ruleset.json")!.text,
    catalogs,
    manifest: texts.get("manifest.json")!.text,
  };
}
