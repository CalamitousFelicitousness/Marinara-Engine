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

  throw new Error("Usage: node scripts/protect-launcher-data.mjs <snapshot|restore-if-missing|check-target <ref>>");
}

// pathToFileURL handles Windows drive letters; new URL(path, "file:") parses
// "D:" as a URL scheme and crashes fileURLToPath with ERR_INVALID_URL_SCHEME.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`  [ERROR] Could not protect launcher data: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
