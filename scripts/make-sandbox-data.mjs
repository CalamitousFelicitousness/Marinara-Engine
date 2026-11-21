#!/usr/bin/env node
// Builds a sandbox data directory from a copy of real data with the private content replaced.
//
//   node scripts/make-sandbox-data.mjs --from <data dir copy> [--to <sandbox dir>] [--force]
//
// Structure survives (tables, ids, row counts, settings, chat modes, tracker shapes); words in
// free text become same-length pseudo-words, secrets and remote hosts are blanked, embeddings are
// dropped, images become same-size placeholders, and other media is left out. Names and lorebook
// keys map consistently under a per-run random salt, so names still match across tables and
// lorebook keys still fire; every other word is replaced at random on each occurrence.
//
// Output is counts and schema names only, never values, so a run can be shared or logged. A run
// whose check finds source text copied through exits 1 and leaves the folder unmarked, and
// run-sandbox.mjs starts only a marked folder.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SANDBOX_DATA_DIR,
  SANDBOX_MARKER,
  findOutputProblems,
  foldersOverlap,
  isSandboxData,
  repoRoot,
  resolveRealInstall,
} from "./sandbox-paths.mjs";

const sharp = createRequire(path.join(repoRoot, "packages/server/package.json"))("sharp");

const USAGE =
  "Usage: make-sandbox-data.mjs --from <data dir copy> [--to <sandbox dir>] [--force]\n" +
  "       make-sandbox-data.mjs --defaults-only [--to <sandbox dir>]";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--from" || flag === "--to") args[flag.slice(2)] = argv[++index];
    else if (flag === "--force") args.force = true;
    else if (flag === "--defaults-only") args.defaultsOnly = true;
    else throw new Error(`Unknown argument ${flag}`);
  }
  if (!args.from && !args.defaultsOnly) throw new Error(USAGE);
  return {
    from: args.from ? path.resolve(args.from) : null,
    to: path.resolve(args.to ?? DEFAULT_SANDBOX_DATA_DIR),
    force: args.force === true,
    defaultsOnly: args.defaultsOnly === true,
  };
}

/** --defaults-only edits files in place, so it takes only a marked sandbox clear of the real install. */
function assertSandboxTarget(dir) {
  const real = resolveRealInstall();
  if (!isSandboxData(dir)) throw new Error(`${dir} has no ${SANDBOX_MARKER}`);
  for (const realDir of [real.dataDir, real.storageDir]) {
    if (foldersOverlap(dir, realDir)) throw new Error(`${dir} overlaps the real install (${realDir})`);
  }
}

const SALT = randomBytes(32);
const hmac = (text) => createHmac("sha256", SALT).update(text).digest();

// ── Classification ──────────────────────────────────────────────

const SECRET_KEY =
  /(api[-_]?key|secret|password|passphrase|cookie|credential|authorization|bearer|private[-_]?key|access[-_]?key|encrypted)/i;
// encryptApiKey's "iv:ciphertext:authTag" (packages/server/src/utils/crypto.ts), under whatever key holds it.
// Matched loosely (any IV length, an optional version part): older builds wrote other widths.
const ENCRYPTED_VALUE = /^(?:[0-9a-z]{1,4}:)?[0-9a-f]{16,}:[0-9a-f]*:[0-9a-f]{16,}$/i;
// Provider reasoning signatures are opaque and may carry the encrypted reasoning itself.
const SECRET_SUFFIX = /(token|signature)$/i;
const HOST_KEY = /(host|hostname|endpoint|base[-_]?url|webhook|proxy)/i;
const VECTOR_KEY = /^(embedding|embeddings|vector|vectors)$/i;
const NAME_KEY =
  /^(name|names|title|displayName|nickname|nicknames|firstName|lastName|alias|aliases|author|creator|creatorName|characterName|personaName|speaker|sender|senderName|username|nick|owner|ownerName)$/i;
const KEYWORD_KEY = /^(keys|secondaryKeys|secondary_keys|keywords|triggers|triggerWords|aliases)$/i;

const ID_LIKE = /^(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{10,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENUM_LIKE = /^[a-z0-9]+(?:[_\-.:+/][a-z0-9]+)*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMERIC = /^-?\d+(\.\d+)?(px|rem|em|%|ms|s|vh|vw)?$/;
const CSS_VALUE =
  /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|color-mix|var|calc)\(|(?:linear|radial|conic|repeating-linear|repeating-radial)-gradient\()/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

// Lowercase tokens the app itself spells as string literals (modes, types, expression names). A
// lowercase word that appears nowhere in the code is content, however enum-like it looks.
const codeTokens = new Set();
// Every word the code spells anywhere. The leak check skips these: they survive legitimately as keys
// and setting values, so only words foreign to the app (names, places, invented terms) count.
const codeWords = new Set();

function collectCodeTokens(dir, { includeDist = false } = {}) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && (includeDist || entry.name !== "dist"))
        collectCodeTokens(full, { includeDist });
    } else if (/\.(ts|tsx|mjs|js|json)$/.test(entry.name)) {
      const source = fs.readFileSync(full, "utf8");
      for (const match of source.matchAll(/["'`]([a-z0-9][a-z0-9_\-.:+/]*)["'`]/g)) codeTokens.add(match[1]);
      for (const word of source.match(/[A-Za-z]+/g) ?? []) codeWords.add(word.toLowerCase());
      for (const word of source.match(/[A-Z]?[a-z]+/g) ?? []) codeWords.add(word.toLowerCase());
    }
  }
}

function isStructuralToken(value) {
  return (
    ID_LIKE.test(value) ||
    UUID.test(value) ||
    ISO_DATE.test(value) ||
    NUMERIC.test(value) ||
    (ENUM_LIKE.test(value) && codeTokens.has(value))
  );
}

// Letter runs of an identifier, split at camelCase humps: "presentCharacters" -> present, characters.
function identifierWords(token) {
  return token.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [];
}

function isCodeIdentifier(token) {
  return identifierWords(token).every((word) => word.length < 3 || codeWords.has(word.toLowerCase()));
}

function keyIsStructural(key) {
  return (/^[A-Za-z_$][A-Za-z0-9_$\-.:]*$/.test(key) || UUID.test(key)) && isCodeIdentifier(key);
}

/**
 * Ids, slugs, keys and tag names: each letter run the code never uses gets a keyed same-length
 * replacement, the same everywhere, so references between tables still match. Digits and
 * separators stay.
 */
function mapIdentifier(token) {
  // UUIDs and hex digests hold no words, and their format is validated.
  if (UUID.test(token) || /^[0-9a-f]{16,}$/i.test(token)) return token;
  return token.replace(/[\p{L}\p{M}]+/gu, (run) =>
    (run.length < 3 && /^[A-Za-z]+$/.test(run)) || codeWords.has(run.toLowerCase())
      ? run
      : matchCase(run, pseudoWord([...run].length, hmac(`id:${run.toLowerCase()}`))),
  );
}

// ── Pseudo-words ────────────────────────────────────────────────

const CONSONANTS = "bcdfghjklmnprstvz";
const VOWELS = "aeiou";

function pseudoWord(length, bytes) {
  let word = "";
  for (let index = 0; index < length; index += 1) {
    const byte = bytes[index % bytes.length] ^ (index * 37);
    word += index % 2 === 0 ? CONSONANTS[byte % CONSONANTS.length] : VOWELS[byte % VOWELS.length];
  }
  return word;
}

function matchCase(source, word) {
  if (source.length > 1 && source === source.toUpperCase() && source !== source.toLowerCase())
    return word.toUpperCase();
  if (source[0] && source[0] === source[0].toUpperCase() && source[0] !== source[0].toLowerCase()) {
    return word[0].toUpperCase() + word.slice(1);
  }
  return word;
}

const anchorWords = new Set();
// Too common to anchor: a stable mapping for them would only give the text a readable rhythm.
const STOPWORDS = new Set(
  "the and for with from that this into over under your their what when where which who whom will have".split(" "),
);

function addAnchor(word) {
  const lower = word.toLowerCase();
  if (lower.length >= 3 && !/^\d+$/.test(lower) && !STOPWORDS.has(lower)) anchorWords.add(lower);
}

function replaceWord(word) {
  if (/^\d+$/.test(word)) return word;
  const lower = word.toLowerCase();
  const bytes = anchorWords.has(lower) ? hmac(`anchor:${lower}`) : randomBytes(16);
  return matchCase(word, pseudoWord(Math.max(2, [...word].length), bytes));
}

const WORD = /[\p{L}\p{M}\p{N}']+/gu;

// Checks split words the way the code scan does: apostrophes and camelCase humps separate words.
// A run the code spells whole ("DeepSeek") is code, as mapIdentifier treats it.
function checkWords(text) {
  return (
    (text.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [])
      // ASCII letters split from digits, as mapIdentifier sees them ("gemini2" is "gemini").
      // Hex digests are kept whole; their a-f runs only spell words by chance.
      .filter((token) => !/^[0-9a-f]{16,}$/i.test(token))
      .flatMap((token) => (/^[A-Za-z0-9]+$/.test(token) ? (token.match(/[A-Za-z]+/g) ?? []) : [token]))
      .flatMap((word) => {
        if (codeWords.has(word.toLowerCase())) return [];
        return /^[A-Za-z]+$/.test(word) ? (word.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [word]) : [word];
      })
  );
}

function scrubWords(text) {
  return text.replace(WORD, (word) => replaceWord(word));
}

const MACRO_OR_TAG = /(\{\{[\s\S]*?\}\}|<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>)/g;

function scrubText(text) {
  return text
    .split(MACRO_OR_TAG)
    .map((part, index) => {
      if (index % 2 === 0) return scrubWords(part);
      if (part.startsWith("{{")) {
        const inner = part.slice(2, -2).split("::");
        return `{{${[mapIdentifier(inner[0]), ...inner.slice(1).map(scrubWords)].join("::")}}}`;
      }
      const tag = part.match(/^<(\/?)([A-Za-z][\w:-]*)/);
      return `<${tag[1]}${mapIdentifier(tag[2])}${part.endsWith("/>") ? "/" : ""}>`;
    })
    .join("");
}

// ── Paths and URLs ──────────────────────────────────────────────

function scrubPathSegment(segment) {
  if (!segment || segment === "." || segment === "..") return segment;
  // Ids and slugs map like the values that name them, so a path the app builds from an id still resolves.
  // File extensions are code words, so they survive the mapping.
  if (/^[A-Za-z0-9_.-]+$/.test(segment)) return mapIdentifier(segment);
  const ext = segment.match(/\.[A-Za-z0-9]{1,5}$/)?.[0] ?? "";
  return `f${createHash("sha256").update(SALT).update(segment).digest("hex").slice(0, 16)}${ext.toLowerCase()}`;
}

// Mirrors encodeShardKey/decodeShardKey in packages/server/src/db/file-backed-store.ts.
function encodeShardKey(rawKey) {
  let encoded = "";
  for (const byte of Buffer.from(rawKey, "utf8")) {
    const char = String.fromCharCode(byte);
    encoded += /[a-z0-9-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded.length > 120 ? null : encoded;
}

function decodeShardKey(encoded) {
  if (!encoded || encoded.startsWith("%h")) return null;
  const bytes = [];
  for (let index = 0; index < encoded.length;) {
    if (encoded[index] === "%") {
      const hex = encoded.slice(index + 1, index + 3);
      if (!/^[0-9A-F]{2}$/.test(hex)) return null;
      bytes.push(Number.parseInt(hex, 16));
      index += 3;
    } else {
      bytes.push(encoded.charCodeAt(index));
      index += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

const shardStats = { remapped: 0, unchanged: 0, hashNamed: 0 };

/** storage/tables/<table>/<encoded key>.json follows the key its rows now carry. */
function storageOutputPath(rel) {
  const match = rel.match(/^(storage\/tables\/[^/]+\/)([^/]+)\.json$/);
  if (!match) return rel;
  const key = decodeShardKey(match[2]);
  if (key === null) {
    shardStats.hashNamed += 1;
    return rel;
  }
  const encoded = encodeShardKey(mapIdentifier(key));
  if (encoded === null || encoded === match[2]) {
    shardStats.unchanged += 1;
    return rel;
  }
  shardStats.remapped += 1;
  return `${match[1]}${encoded}.json`;
}

function scrubPath(value) {
  return value
    .split(/([/\\])/)
    .map((part) => (part === "/" || part === "\\" ? part : scrubPathSegment(part)))
    .join("");
}

const PATH_LIKE = /^(?:\.{0,2}[/\\])?[^\s/\\]+(?:[/\\][^\s/\\]*)+$/;

function scrubUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (!LOCAL_HOSTS.has(url.hostname)) return "";
  return `${url.protocol}//${url.host}${scrubPath(url.pathname)}`;
}

// ── Values ──────────────────────────────────────────────────────

const PLACEHOLDER_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const stats = {
  strings: 0,
  secrets: 0,
  urls: 0,
  vectors: 0,
  dataUris: 0,
  renamedKeys: 0,
  nested: 0,
  defaultPrompts: 0,
  chatsOnStockPreset: 0,
};

// Strings and keys emitted unchanged that still hold a word foreign to the code, by field and rule.
const keptForeign = new Map();

function noteKept(input, output, key, rule) {
  if (input !== output) return;
  const foreign = checkWords(input).some(
    (word) => word.length >= 4 && !/\d/.test(word) && !/^[0-9a-f]+$/i.test(word) && !codeWords.has(word.toLowerCase()),
  );
  if (!foreign) return;
  const label = `${key}:${rule}`;
  keptForeign.set(label, (keptForeign.get(label) ?? 0) + 1);
}

// For anchor or sampled words in a scrubbed string: copied from its own input, or introduced by the scrub.
const hitOrigins = new Map();

function noteHitOrigins(input, output, key, rule) {
  if (input === output || rule === "nested-json") return;
  const inputWords = new Set(checkWords(input).map((word) => word.toLowerCase()));
  for (const word of checkWords(output)) {
    const lower = word.toLowerCase();
    if (GENERATED_SHAPE.test(lower) || !(anchorWords.has(lower) || sampledWords.has(lower))) continue;
    const label = `${key}:${rule}:${inputWords.has(lower) ? "copied" : "introduced"}`;
    hitOrigins.set(label, (hitOrigins.get(label) ?? 0) + 1);
  }
}

function scrubString(value, key, context) {
  const output = scrubStringRule(value, key, context);
  noteKept(value, output.value, key, output.rule);
  noteHitOrigins(value, output.value, key, output.rule);
  return output.value;
}

function scrubStringRule(value, key, context) {
  stats.strings += 1;
  if (value === "") return { value, rule: "empty" };
  // Scrubbed instructions would drive agents with pseudo-words. Empty falls back to the agent's own default
  // (agent-executor.ts: config.promptTemplate || getDefaultPromptForAgent(config)).
  if (key === "promptTemplate") {
    stats.defaultPrompts += 1;
    return { value: "", rule: "default-prompt" };
  }
  if (context.secret || SECRET_KEY.test(key) || SECRET_SUFFIX.test(key) || ENCRYPTED_VALUE.test(value.trim())) {
    stats.secrets += 1;
    return { value: "", rule: "secret" };
  }
  const trimmed = value.trim();
  if (trimmed.startsWith("data:")) {
    stats.dataUris += 1;
    return { value: PLACEHOLDER_DATA_URI, rule: "data-uri" };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    stats.urls += 1;
    return { value: scrubUrl(trimmed), rule: "url" };
  }
  if (HOST_KEY.test(key) && !LOCAL_HOSTS.has(trimmed.replace(/:\d+$/, ""))) {
    stats.urls += 1;
    return { value: "", rule: "host" };
  }
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) {
    try {
      const parsed = JSON.parse(trimmed);
      stats.nested += 1;
      return { value: JSON.stringify(scrubValue(parsed, key, context)), rule: "nested-json" };
    } catch {
      // Not JSON: scrubbed as text below.
    }
  }
  if (NAME_KEY.test(key) || KEYWORD_KEY.test(key)) return { value: scrubText(value), rule: "name" };
  if (/^#[0-9a-f]{3,8}$/i.test(trimmed)) return { value, rule: "hex-color" };
  if (
    CSS_VALUE.test(trimmed) &&
    (trimmed.match(/[A-Za-z]+/g) ?? []).every((word) => codeWords.has(word.toLowerCase()))
  ) {
    return { value, rule: "css" };
  }
  if (ISO_DATE.test(trimmed) || NUMERIC.test(trimmed)) return { value, rule: "date-or-number" };
  // A bare file name ("Name.jpg") maps like the file it names, which outputPath renamed the same way.
  if (/^[^\s/\\]+\.[A-Za-z0-9]{2,5}$/.test(trimmed)) return { value: scrubPathSegment(trimmed), rule: "file-name" };
  if (ID_LIKE.test(trimmed) || UUID.test(trimmed) || ENUM_LIKE.test(trimmed)) {
    return { value: mapIdentifier(value), rule: "identifier" };
  }
  if (PATH_LIKE.test(trimmed)) return { value: scrubPath(value), rule: "path" };
  return { value: scrubText(value), rule: "text" };
}

function scrubValue(value, key, context = {}) {
  if (typeof value === "string") return scrubString(value, key, context);
  if (value === null || typeof value !== "object") return value;
  if (VECTOR_KEY.test(key)) {
    stats.vectors += 1;
    return null;
  }
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, key, context));
  const secret = context.secret || SECRET_KEY.test(key);
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    let outKey = childKey;
    let keyRule = "structural-key";
    if (!keyIsStructural(childKey)) {
      stats.renamedKeys += 1;
      const identifier = /^[A-Za-z0-9_$\-.:]+$/.test(childKey);
      outKey = identifier ? mapIdentifier(childKey) : scrubText(childKey);
      keyRule = identifier ? "identifier-key" : "text-key";
    }
    noteKept(childKey, outKey, `${key}{key}`, keyRule);
    out[outKey] = scrubValue(childValue, childKey, { secret });
  }
  return out;
}

// Pass 1: names and lorebook keys become anchors, mapped the same way wherever they appear.
function collectAnchors(value, key) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) {
      try {
        collectAnchors(JSON.parse(trimmed), key);
        return;
      } catch {
        // plain text
      }
    }
    if (NAME_KEY.test(key) || KEYWORD_KEY.test(key)) {
      for (const word of checkWords(value)) addAnchor(word);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectAnchors(item, key);
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    if (!keyIsStructural(childKey)) for (const word of checkWords(childKey)) addAnchor(word);
    collectAnchors(childValue, childKey);
  }
}

// ── Leak check ──────────────────────────────────────────────────

// Words from the source's free text, kept in memory only. A hit is reported by the field it
// surfaced in, never by the word.
const sampledWords = new Set();
const SAMPLE_LIMIT = 20000;

function sampleWords(value, key) {
  if (typeof value === "string") {
    if (sampledWords.size >= SAMPLE_LIMIT) return;
    if (isStructuralToken(value.trim()) || CSS_VALUE.test(value.trim())) return;
    for (const word of checkWords(value)) {
      const lower = word.toLowerCase();
      if (lower.length >= 6 && !/\d/.test(lower) && !codeWords.has(lower) && Math.random() < 0.05)
        sampledWords.add(lower);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value))
    sampleWords(childValue, Array.isArray(value) ? key : childKey);
}

const hits = { anchors: new Map(), words: new Map() };
// Which rule let a leaking string through, described by its shape only (never its text).
const leakShapes = new Map();

function describeShape(value) {
  const trimmed = value.trim();
  const rule = ID_LIKE.test(trimmed)
    ? "id-like"
    : UUID.test(trimmed)
      ? "uuid"
      : ENUM_LIKE.test(trimmed)
        ? "enum-like"
        : CSS_VALUE.test(trimmed)
          ? "css"
          : PATH_LIKE.test(trimmed)
            ? "path-like"
            : /\s/.test(trimmed)
              ? "text"
              : "token";
  const length = trimmed.length < 20 ? "<20" : trimmed.length < 200 ? "<200" : ">=200";
  return `${rule}/${length}`;
}

// The generator's own output shape. A source word of this shape can reappear by chance, so a match
// proves nothing either way; such words are counted apart instead of as leaks.
const GENERATED_SHAPE = /^(?:[bcdfghjklmnprstvz][aeiou])*[bcdfghjklmnprstvz]?$/;
let unverifiable = 0;
// Where leaking strings sit: the table for storage, else the first two path segments (app-defined).
const leakFiles = new Map();
let currentLeakFile = "";

function leakFileLabel(rel) {
  const parts = rel.split("/");
  if (parts[0] === "storage" && parts[1] === "tables") return `storage:${parts[2]?.replace(/\.json$/, "")}`;
  if (parts[0] === "capability-packages" && parts.length === 2) return rel;
  return `${parts[0]}/${parts.length > 2 ? "..." : ""}`;
}

function checkLeaks(value, key) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) {
      try {
        checkLeaks(JSON.parse(trimmed), key);
        return;
      } catch {
        // plain text
      }
    }
    let leaked = false;
    for (const word of checkWords(value)) {
      const lower = word.toLowerCase();
      if (codeWords.has(lower)) continue;
      // A run of hex letters inside a UUID or digest spells "facade" by chance.
      if (/^[a-f]+$/.test(lower)) continue;
      if (GENERATED_SHAPE.test(lower)) {
        if (anchorWords.has(lower) || sampledWords.has(lower)) unverifiable += 1;
        continue;
      }
      if (lower.length >= 4 && anchorWords.has(lower)) {
        hits.anchors.set(key, (hits.anchors.get(key) ?? 0) + 1);
        leaked = true;
      }
      if (sampledWords.has(lower)) {
        hits.words.set(key, (hits.words.get(key) ?? 0) + 1);
        leaked = true;
      }
    }
    if (leaked) {
      const shape = `${key}:${describeShape(value)}`;
      leakShapes.set(shape, (leakShapes.get(shape) ?? 0) + 1);
      const fileLabel = `${currentLeakFile} ${shape}`;
      leakFiles.set(fileLabel, (leakFiles.get(fileLabel) ?? 0) + 1);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    checkLeaks(childKey, `${key}{key}`);
    checkLeaks(childValue, Array.isArray(value) ? key : childKey);
  }
}

// ── Files ───────────────────────────────────────────────────────

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif"]);
const TEXT_EXT = new Set([".md", ".txt"]);
// Copied unchanged: code and models, no user content.
const VERBATIM_DIRS = ["capability-packages/versions", "models"];
const VERBATIM_FILES = /^capability-packages\/[^/]+\.json$/;
const DROPPED_TOP = new Set([
  ".encryption-key",
  "capability-runtime-snapshots",
  "diagnostics",
  "game-assets",
  "knowledge-sources",
  "sidecar-runtime",
]);
const STORAGE_COMPANION = /\.(bak|tmp|corrupt|pre-v\d+|pre-shard)$|\.json\.[^/]+$/;

// ── Working defaults ────────────────────────────────────────────

// MARINARA_UNIVERSAL_PRESET_SYSTEM_KEY in packages/shared/src/types/prompt.ts. The server's seed restores this
// preset's stock text on boot (keeping the scrubbed one as a copy), so it is the one preset with real prompts.
const STOCK_PRESET_SYSTEM_KEY = "marinara-universal-preset";
let stockPresetId = null;

const tableOf = (rel) => rel.match(/^storage\/tables\/([^/.]+)/)?.[1] ?? null;
const rowsOf = (value) => (Array.isArray(value) ? value : []);

function findStockPreset(rel, parsed) {
  if (tableOf(rel) !== "prompt_presets") return;
  const stock = rowsOf(parsed).find((row) => row?.systemKey === STOCK_PRESET_SYSTEM_KEY);
  if (stock?.id) stockPresetId = stock.id;
}

/** Every chat uses the stock preset, which is also the default: scrubbed presets would prompt in pseudo-words. */
function applyWorkingDefaults(rel, rows, presetId) {
  if (!presetId) return;
  const table = tableOf(rel);
  if (table === "chats") {
    for (const row of rowsOf(rows)) {
      if (!row || typeof row !== "object") continue;
      row.promptPresetId = presetId;
      stats.chatsOnStockPreset += 1;
    }
  } else if (table === "prompt_presets") {
    for (const row of rowsOf(rows)) if (row && typeof row === "object") row.isDefault = String(row.id === presetId);
  }
}

/** Empties every promptTemplate, inside JSON stored as text too, so agents run their own defaults. */
function blankPromptTemplates(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length > 1) {
      try {
        const parsed = JSON.parse(trimmed);
        const changed = blankPromptTemplates(parsed);
        return changed === parsed ? value : JSON.stringify(changed);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = value.map(blankPromptTemplates);
    return items.some((item, index) => item !== value[index]) ? items : value;
  }
  let changed = false;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    const next =
      key === "promptTemplate" && typeof child === "string" && child !== "" ? "" : blankPromptTemplates(child);
    if (next !== child) {
      changed = true;
      if (key === "promptTemplate") stats.defaultPrompts += 1;
    }
    out[key] = next;
  }
  return changed ? out : value;
}

/**
 * --defaults-only: applies the working defaults to an existing sandbox in place, keeping what was set up in it
 * since (connections, keys, settings). Its server must be stopped: a running one rewrites these files.
 */
function applyDefaultsInPlace(dir) {
  if (fs.existsSync(path.join(dir, "storage", ".writer-lease"))) {
    throw new Error("a server holds this sandbox's storage: stop it first (pnpm sandbox --stop)");
  }
  const files = [...walk(dir)].filter((rel) => rel.startsWith("storage/tables/") && rel.endsWith(".json"));
  let presetId = null;
  for (const rel of files.filter((file) => tableOf(file) === "prompt_presets")) {
    const stock = rowsOf(JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"))).find(
      (row) => row?.systemKey === STOCK_PRESET_SYSTEM_KEY,
    );
    if (stock?.id) presetId = stock.id;
  }
  let rewritten = 0;
  for (const rel of files) {
    const target = path.join(dir, rel);
    const before = fs.readFileSync(target, "utf8");
    const rows = blankPromptTemplates(JSON.parse(before));
    applyWorkingDefaults(rel, rows, presetId);
    const after = JSON.stringify(rows);
    if (after !== before) {
      fs.writeFileSync(target, after);
      rewritten += 1;
    }
  }
  console.log(`stock preset found: ${presetId !== null}; files rewritten: ${rewritten}`);
  console.log(
    `agent prompts reset to defaults: ${stats.defaultPrompts}; chats on the stock preset: ${stats.chatsOnStockPreset}`,
  );
}

const verbatimOutputs = new Set();
const fileStats = { scrubbedJson: 0, placeholders: 0, text: 0, verbatim: 0, dropped: 0, renamed: 0, failed: 0 };

function* walk(dir, base = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".writer-lease") continue;
      yield* walk(full, base);
    } else if (entry.isFile()) yield rel;
  }
}

function classify(rel) {
  const top = rel.split("/")[0];
  if (DROPPED_TOP.has(top)) return "drop";
  if (VERBATIM_DIRS.some((dir) => rel.startsWith(`${dir}/`)) || VERBATIM_FILES.test(rel)) return "verbatim";
  if (top === "storage" && STORAGE_COMPANION.test(rel)) return "drop";
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".json") return "json";
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return "drop";
}

function outputPath(rel) {
  return rel.startsWith("storage/") ? storageOutputPath(rel) : scrubPath(rel);
}

async function placeholderImage(source, target) {
  const ext = path.extname(target).toLowerCase();
  let width = 256;
  let height = 256;
  try {
    const meta = await sharp(source).metadata();
    width = meta.width ?? width;
    height = meta.pageHeight ?? meta.height ?? height;
  } catch {
    // unreadable source: default size
  }
  const tint = createHash("sha256").update(target).digest();
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 60 + (tint[0] % 120), g: 60 + (tint[1] % 120), b: 60 + (tint[2] % 120) },
    },
  });
  const format = ext === ".jpg" || ext === ".jpeg" ? "jpeg" : ext.slice(1);
  await image.toFormat(format === "avif" ? "avif" : format).toFile(target);
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const { from, to, force, defaultsOnly } = parseArgs(process.argv.slice(2));
  if (defaultsOnly) {
    assertSandboxTarget(to);
    return applyDefaultsInPlace(to);
  }
  if (!fs.existsSync(path.join(from, "storage", "manifest.json")))
    throw new Error("--from has no storage/manifest.json");
  const outputProblems = findOutputProblems({ from, to, force });
  if (outputProblems.length > 0) throw new Error(outputProblems.join("; "));
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });

  for (const dir of ["packages/shared/src", "packages/server/src", "packages/client/src"]) {
    collectCodeTokens(path.join(repoRoot, dir));
  }
  // Packages ship built code, so their dist is their source.
  collectCodeTokens(path.join(from, "capability-packages", "versions"), { includeDist: true });

  const files = [...walk(from)];
  const jsonFiles = files.filter((rel) => classify(rel) === "json");

  for (const rel of jsonFiles) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(from, rel), "utf8"));
      findStockPreset(rel, parsed);
      collectAnchors(parsed, "");
      sampleWords(parsed, "");
    } catch {
      // reported in pass 2
    }
  }

  for (const rel of files) {
    const kind = classify(rel);
    const outRel = outputPath(rel);
    if (outRel !== rel) fileStats.renamed += 1;
    const source = path.join(from, rel);
    const target = path.join(to, outRel);
    if (kind === "drop") {
      fileStats.dropped += 1;
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      if (kind === "verbatim") {
        fs.copyFileSync(source, target);
        fileStats.verbatim += 1;
        verbatimOutputs.add(outRel);
      } else if (kind === "json") {
        const raw = fs.readFileSync(source, "utf8");
        const scrubbed = scrubValue(JSON.parse(raw), "");
        applyWorkingDefaults(rel, scrubbed, stockPresetId && mapIdentifier(stockPresetId));
        fs.writeFileSync(target, rel.endsWith("manifest.json") ? raw : JSON.stringify(scrubbed));
        fileStats.scrubbedJson += 1;
      } else if (kind === "image") {
        await placeholderImage(source, target);
        fileStats.placeholders += 1;
      } else if (kind === "text") {
        fs.writeFileSync(target, scrubText(fs.readFileSync(source, "utf8")));
        fileStats.text += 1;
      }
    } catch (error) {
      fileStats.failed += 1;
      console.error(`failed: ${rel.split("/")[0]}/... (${kind}) ${error?.code ?? error?.name ?? "error"}`);
    }
  }

  // The manifest is counts and shard lists, kept as written; it was not scrubbed, so check it too.
  // Verbatim files are package code and models, public text that shares ordinary words with any chat.
  for (const rel of walk(to)) {
    if (verbatimOutputs.has(rel)) continue;
    const target = path.join(to, rel);
    currentLeakFile = leakFileLabel(rel);
    // A shard is named by its percent-encoded key; the key itself is what could carry a word.
    const shard = rel.match(/^storage\/tables\/[^/]+\/([^/]+)\.json$/);
    checkLeaks((shard && decodeShardKey(shard[1])) ?? rel, "(file path)");
    if (rel.endsWith(".json")) checkLeaks(JSON.parse(fs.readFileSync(target, "utf8")), "");
    else if (rel.endsWith(".md") || rel.endsWith(".txt")) checkLeaks(fs.readFileSync(target, "utf8"), "(text file)");
  }

  // Package dependencies stay shared with the source install.
  const modules = path.join(from, "capability-packages", "node_modules");
  if (fs.existsSync(modules)) {
    const link = path.join(to, "capability-packages", "node_modules");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (process.platform === "win32")
      execFileSync("cmd", ["/c", "mklink", "/J", link, fs.realpathSync(modules)], { stdio: "ignore" });
    else fs.symlinkSync(fs.realpathSync(modules), link, "dir");
  }

  const summarize = (map) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([key, count]) => `${key || "(root)"}=${count}`)
      .join(", ") || "none";
  console.log(`files: ${JSON.stringify(fileStats)}`);
  console.log(`values: ${JSON.stringify(stats)}`);
  console.log(`storage shards: ${JSON.stringify(shardStats)}`);
  const distinctiveAnchors = [...anchorWords].filter((word) => word.length >= 4 && !codeWords.has(word)).length;
  console.log(
    `anchor words (names, lorebook keys): ${anchorWords.size}, ${distinctiveAnchors} not in the code; leaks by field: ${summarize(hits.anchors)}`,
  );
  console.log(`sampled free-text words: ${sampledWords.size}; leaks by field: ${summarize(hits.words)}`);
  console.log(`leaking strings by field and shape: ${summarize(leakShapes)}`);
  console.log(`matches shaped like generated words (unverifiable): ${unverifiable}`);
  console.log(`leaking strings by file: ${summarize(leakFiles)}`);
  console.log(`hit origins by field, rule, copied or introduced: ${summarize(hitOrigins)}`);
  console.log(`kept unchanged with a word foreign to the code, by field and rule: ${summarize(keptForeign)}`);

  // The by-field counts above include chance matches. These two do not: each entry is a rule that
  // passed source text through, so the folder stays unmarked until the rule is fixed.
  const copied = [...hitOrigins.keys()].filter((label) => label.endsWith(":copied"));
  if (keptForeign.size > 0 || copied.length > 0) {
    throw new Error("the scrub copied source text through (see the last two lines); the folder is not marked");
  }
  fs.writeFileSync(path.join(to, SANDBOX_MARKER), `${JSON.stringify({ createdAt: new Date().toISOString() })}\n`);
  console.log(`marked ${SANDBOX_MARKER}: no source text copied through`);
}

main().catch((error) => {
  // Messages here come from this script or the filesystem; never print a parsed value.
  console.error(`make-sandbox-data failed: ${error?.message ?? error}`);
  process.exit(1);
});
