#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const serverRoot = resolve(repositoryRoot, "packages/server");
const defaultBackupRoot = resolve(repositoryRoot, "..", ".marinara-engine-update-backups");
const retainedBackupCount = 2;

async function directoryHasEntries(directory) {
  try {
    return (await readdir(directory)).length > 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readEnvDataDir(root, ambientEnv) {
  const ambientValue = ambientEnv.DATA_DIR?.trim();
  if (ambientValue) return ambientValue;

  try {
    const parsed = parseEnv(await readFile(resolve(root, ".env"), "utf8"));
    return parsed.DATA_DIR?.trim() || null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function readEnvFileStorageDir(root, ambientEnv) {
  const ambientValue = ambientEnv.FILE_STORAGE_DIR?.trim();
  if (ambientValue) return ambientValue;

  try {
    const parsed = parseEnv(await readFile(resolve(root, ".env"), "utf8"));
    return parsed.FILE_STORAGE_DIR?.trim() || null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Mirrors the server's storage-dir resolution: FILE_STORAGE_DIR override, else DATA_DIR/storage. */
export async function resolveLauncherStorageDir({ root = repositoryRoot, env = process.env } = {}) {
  const configured = await readEnvFileStorageDir(root, env);
  if (configured) {
    return isAbsolute(configured) ? resolve(configured) : resolve(root, "packages/server", configured);
  }
  return resolve(await resolveLauncherDataDir({ root, env }), "storage");
}

/**
 * Downgrade guard (#4708): compares the ON-DISK storage format (the version
 * the store wrote into storage/manifest.json) against the format the TARGET
 * ref's code understands (its tracked root storage-format.json; absent on
 * refs predating that file = format 2). A build must never run against data
 * written by a newer format — it would silently see empty chat history and
 * could write a conflicting old-format file.
 */
export async function checkTargetStorageFormat({
  root = repositoryRoot,
  env = process.env,
  targetRef,
} = {}) {
  if (!targetRef) throw new Error("checkTargetStorageFormat requires a targetRef");

  let onDiskFormat = null;
  try {
    const manifest = JSON.parse(
      await readFile(resolve(await resolveLauncherStorageDir({ root, env }), "manifest.json"), "utf8"),
    );
    if (typeof manifest?.version === "number") onDiskFormat = manifest.version;
  } catch {
    /* no manifest -> fresh install or pre-storage build -> nothing to protect */
  }
  if (onDiskFormat === null) return { compatible: true, onDiskFormat: null, targetFormat: null };

  // Absent on the target ref -> that build predates storage-format.json -> 2.
  let targetFormat = 2;
  try {
    const raw = execFileSync("git", ["show", `${targetRef}:storage-format.json`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(raw);
    if (typeof parsed?.storageFormat === "number") targetFormat = parsed.storageFormat;
  } catch {
    /* keep 2 */
  }

  return { compatible: targetFormat >= onDiskFormat, onDiskFormat, targetFormat };
}

// Kept in sync with SHARDED_TABLES in packages/server/src/db/file-backed-store.ts
// (this script must run offline, so it cannot import server code).
const SHARDED_TABLES = ["messages", "message_swipes"];
const UNSHARD_SENTINEL = ".unshard-in-progress";

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Shard data files: primaries (*.json) plus .bak-only shards whose primary vanished. */
async function listShardSources(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const primaries = names.filter((name) => name.endsWith(".json"));
  const bakOnly = names.filter(
    (name) => name.endsWith(".json.bak") && !primaries.includes(name.slice(0, -".bak".length)),
  );
  return [...primaries, ...bakOnly];
}

async function readShardRowsOrThrow(dir, name) {
  const path = resolve(dir, name);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    const bak = `${path}.bak`;
    if (name.endsWith(".json") && (await pathExists(bak))) {
      try {
        return JSON.parse(await readFile(bak, "utf8"));
      } catch {
        /* fall through to the error below */
      }
    }
    throw new Error(
      `Cannot parse shard file ${path} (or its .bak). Fix or remove that file, then re-run unshard. Nothing has been changed.`,
    );
  }
}

/**
 * Downgrade escape hatch (#4708): rebuilds the pre-sharding monolith layout
 * from the per-chat shard files so a format-2 build can read the data again.
 * Run it with the server STOPPED — a running sharded server re-shards on its
 * next flush. Shard directories are renamed to `.post-unshard-<timestamp>`
 * (kept, never deleted), and the manifest is rewritten as format 2 so the
 * launcher guard stops refusing the older target.
 *
 * All reads happen before any write; an unreadable shard aborts the run with
 * the directory untouched. A sentinel makes a crashed run resumable: with the
 * sentinel present, an existing monolith is a completed partial result (the
 * tmp+rename write is atomic), not the pre-shard-build-forked-history
 * ambiguity that otherwise aborts the run.
 */
export async function unshardLauncherStorage({ root = repositoryRoot, env = process.env, now = new Date() } = {}) {
  const storageDir = await resolveLauncherStorageDir({ root, env });
  const tablesDir = resolve(storageDir, "tables");
  const unshardSentinel = resolve(tablesDir, UNSHARD_SENTINEL);
  const resumingCrashedUnshard = await pathExists(unshardSentinel);
  const warnings = [];
  const plans = [];

  for (const table of SHARDED_TABLES) {
    const monolithPath = resolve(tablesDir, `${table}.json`);
    const shardDir = resolve(tablesDir, table);
    const monolithExists = await pathExists(monolithPath);
    const sources = await listShardSources(shardDir);
    const hasShardData = !!sources && sources.length > 0;
    const migrationCrashed = hasShardData && (await pathExists(resolve(shardDir, ".migrating")));

    if (monolithExists && hasShardData && !migrationCrashed && !resumingCrashedUnshard) {
      throw new Error(
        `Table "${table}" has BOTH a monolith and shard files, and neither is marked in-progress. ` +
          `An older version may have written new history into the monolith after the shards were created; ` +
          `merging the two automatically would guess at ordering. Start the current version once so the ` +
          `store reconciles them, then re-run unshard. Nothing has been changed.`,
      );
    }
    if (monolithExists) {
      // Authoritative monolith (crashed migration, or a crashed unshard's
      // completed atomic write) — just move any shard remnants aside.
      plans.push({ table, mode: "monolith-kept", monolithPath, shardDir: sources ? shardDir : null });
      continue;
    }
    if (!hasShardData) {
      plans.push({ table, mode: "empty", monolithPath, shardDir: null });
      continue;
    }

    const rows = [];
    for (const name of sources) {
      const parsed = await readShardRowsOrThrow(shardDir, name);
      const list = Array.isArray(parsed) ? parsed : [];
      const records = list.filter((row) => !!row && typeof row === "object" && !Array.isArray(row));
      if (records.length !== list.length) {
        warnings.push(
          `${table}/${name}: skipped ${list.length - records.length} malformed row(s); the original file stays in the renamed shard directory`,
        );
      }
      rows.push(...records);
    }
    // Mirror the store's load normalization: (createdAt, id) order, then
    // keep-first dedup on primary key.
    rows.sort(
      (a, b) =>
        String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) ||
        String(a.id ?? "").localeCompare(String(b.id ?? "")),
    );
    const seenIds = new Set();
    const deduped = [];
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id : null;
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      deduped.push(row);
    }
    if (deduped.length !== rows.length) {
      warnings.push(`${table}: dropped ${rows.length - deduped.length} duplicate row id(s) found across shards`);
    }
    plans.push({ table, mode: "rebuild", monolithPath, shardDir, rows: deduped });
  }

  // Every read succeeded — now write.
  await mkdir(tablesDir, { recursive: true });
  await writeFile(unshardSentinel, now.toISOString(), "utf8");
  const timestamp = now.toISOString().replaceAll(":", "-").replace(".", "-");
  const results = [];
  for (const plan of plans) {
    if (plan.mode === "rebuild") {
      const tmp = `${plan.monolithPath}.unshard-tmp`;
      await writeFile(tmp, JSON.stringify(plan.rows), "utf8");
      await rename(tmp, plan.monolithPath);
    }
    if (plan.shardDir && (await pathExists(plan.shardDir))) {
      await rename(plan.shardDir, `${plan.shardDir}.post-unshard-${timestamp}`);
    }
    results.push(
      plan.mode === "rebuild"
        ? `${plan.table}: rebuilt the monolith from ${plan.rows.length} row(s); shard files kept as ${plan.table}.post-unshard-${timestamp}`
        : plan.mode === "monolith-kept"
          ? `${plan.table}: kept the existing monolith${plan.shardDir ? `; shard remnants moved to ${plan.table}.post-unshard-${timestamp}` : ""}`
          : `${plan.table}: no data to convert`,
    );
  }

  // Rewrite the manifest as format 2 — the launcher guard reads it, and a
  // leftover version 3 would keep refusing the downgrade unshard exists to
  // allow. (Format-2 builds themselves never read the version.)
  const manifestFile = resolve(storageDir, "manifest.json");
  try {
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) {
      manifest.version = 2;
      manifest.savedAt = now.toISOString();
      delete manifest.shards;
      const serialized = JSON.stringify(manifest, null, 2);
      await writeFile(manifestFile, serialized, "utf8");
      await writeFile(`${manifestFile}.bak`, serialized, "utf8");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      warnings.push(`could not rewrite ${manifestFile} (${error instanceof Error ? error.message : error})`);
    }
  }
  await rm(unshardSentinel, { force: true });
  return { storageDir, results, warnings };
}

export async function resolveLauncherDataDir({
  root = repositoryRoot,
  env = process.env,
} = {}) {
  const configured = await readEnvDataDir(root, env);
  if (!configured) return resolve(root, "packages/server/data");
  return isAbsolute(configured) ? resolve(configured) : resolve(root, "packages/server", configured);
}

async function listCompletedBackups(backupRoot) {
  try {
    const entries = await readdir(backupRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("update-"))
      .map((entry) => resolve(backupRoot, entry.name))
      .sort()
      .reverse();
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readManifest(backupDir) {
  try {
    return JSON.parse(await readFile(resolve(backupDir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
}

export async function snapshotLauncherData({
  root = repositoryRoot,
  backupRoot = defaultBackupRoot,
  env = process.env,
  now = new Date(),
} = {}) {
  const dataDir = await resolveLauncherDataDir({ root, env });
  if (!(await directoryHasEntries(dataDir))) {
    return { created: false, dataDir, backupDir: null };
  }

  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await chmod(backupRoot, 0o700);
  const timestamp = now.toISOString().replaceAll(":", "-").replace(".", "-");
  const backupName = `update-${timestamp}-${process.pid}`;
  const incompleteDir = resolve(backupRoot, `.incomplete-${backupName}`);
  const backupDir = resolve(backupRoot, backupName);

  await rm(incompleteDir, { recursive: true, force: true });
  try {
    await mkdir(incompleteDir, { recursive: true, mode: 0o700 });
    await cp(dataDir, resolve(incompleteDir, "data"), {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: true,
    });
    await writeFile(
      resolve(incompleteDir, "manifest.json"),
      `${JSON.stringify({ createdAt: now.toISOString(), dataDir }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(incompleteDir, backupDir);
  } catch (error) {
    await rm(incompleteDir, { recursive: true, force: true });
    throw error;
  }

  const staleBackups = (await listCompletedBackups(backupRoot)).slice(retainedBackupCount);
  await Promise.all(staleBackups.map((path) => rm(path, { recursive: true, force: true })));
  return { created: true, dataDir, backupDir };
}

export async function restoreLauncherDataIfMissing({
  root = repositoryRoot,
  backupRoot = defaultBackupRoot,
  env = process.env,
} = {}) {
  const dataDir = await resolveLauncherDataDir({ root, env });
  if (await directoryHasEntries(dataDir)) {
    return { restored: false, dataDir, backupDir: null };
  }

  for (const backupDir of await listCompletedBackups(backupRoot)) {
    const manifest = await readManifest(backupDir);
    if (manifest?.dataDir !== dataDir) continue;

    const backupDataDir = resolve(backupDir, "data");
    try {
      if (!(await stat(backupDataDir)).isDirectory() || !(await directoryHasEntries(backupDataDir))) continue;
    } catch {
      continue;
    }

    await rm(dataDir, { recursive: true, force: true });
    await mkdir(dirname(dataDir), { recursive: true });
    await cp(backupDataDir, dataDir, { recursive: true, preserveTimestamps: true, errorOnExist: true });
    return { restored: true, dataDir, backupDir };
  }

  return { restored: false, dataDir, backupDir: null };
}

async function main() {
  const command = process.argv[2];
  if (command === "snapshot") {
    const result = await snapshotLauncherData();
    if (result.created) {
      console.log(`  [OK] Protected user data at ${result.backupDir}`);
    } else {
      console.log("  [OK] No existing user data needed an update snapshot.");
    }
    return;
  }

  if (command === "restore-if-missing") {
    const result = await restoreLauncherDataIfMissing();
    if (result.restored) {
      console.log(`  [OK] Restored user data from ${result.backupDir}`);
    }
    return;
  }

  if (command === "check-target") {
    const targetRef = process.argv[3];
    if (!targetRef) throw new Error("Usage: node scripts/protect-launcher-data.mjs check-target <ref>");
    const result = await checkTargetStorageFormat({ targetRef });
    if (result.compatible) {
      return;
    }
    console.error(
      `  [BLOCK] Your data uses storage format ${result.onDiskFormat}, but the update target only understands ` +
        `format ${result.targetFormat}. Running it would hide your chat history and could corrupt the data ` +
        `layout. Update to a newer version instead, or see docs/TROUBLESHOOTING.md ("Chats show no messages ` +
        `after switching to an older version") for manual downgrade steps.`,
    );
    process.exitCode = 2;
    return;
  }

  if (command === "unshard") {
    const result = await unshardLauncherStorage();
    for (const warning of result.warnings) console.warn(`  [WARN] ${warning}`);
    for (const line of result.results) console.log(`  [OK] ${line}`);
    console.log(`  [OK] Storage at ${result.storageDir} is back on the monolith layout (format 2); older versions can read it again.`);
    return;
  }

  throw new Error("Usage: node scripts/protect-launcher-data.mjs <snapshot|restore-if-missing|check-target <ref>|unshard>");
}

// pathToFileURL handles Windows drive letters; new URL(path, "file:") parses
// "D:" as a URL scheme and crashes fileURLToPath with ERR_INVALID_URL_SCHEME.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`  [ERROR] Could not protect launcher data: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
