// #4708 PR 2: the downgrade guard. A build must never be allowed to run
// against data written by a newer storage format — it would show empty chat
// history and could write a conflicting old-format file. These regressions
// drive the REAL scripts:
//   - storage-format.json stays equal to STORAGE_VERSION (a missed bump
//     silently disables the guard),
//   - checkTargetStorageFormat compares the on-disk manifest against the
//     target ref's tracked storage-format.json (absent -> format 2),
//   - the check-target CLI exits 2 with a [BLOCK] message on an incompatible
//     target and 0 on a compatible one,
//   - every launcher (start.sh, start.bat, start-termux.sh) and the in-app
//     updater carry the guard, so a refactor cannot silently drop it,
//   - unshard rebuilds the monolith layout (sorted, deduped), renames shard
//     dirs to .post-unshard-<ts>, rewrites the manifest as format 2, keeps a
//     crashed-migration monolith authoritative, and refuses the ambiguous
//     monolith+shards state without deleting anything.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTargetStorageFormat, unshardLauncherStorage } from "../protect-launcher-data.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// ── storage-format.json must match STORAGE_VERSION ──

const declaredFormat = JSON.parse(readFileSync(join(repositoryRoot, "storage-format.json"), "utf8")).storageFormat;
const storeSource = readFileSync(join(repositoryRoot, "packages/server/src/db/file-backed-store.ts"), "utf8");
const storeVersion = Number(/const STORAGE_VERSION = (\d+)/.exec(storeSource)?.[1]);
assert.equal(
  declaredFormat,
  storeVersion,
  "storage-format.json must equal STORAGE_VERSION in file-backed-store.ts — a missed bump silently disables the downgrade guard",
);

// ── Every entry point carries the guard (source-level pin) ──

for (const launcherPath of ["start.sh", "start-termux.sh", "start.bat"]) {
  const launcherSource = readFileSync(join(repositoryRoot, launcherPath), "utf8");
  assert.ok(
    launcherSource.includes("protect-launcher-data.mjs") && launcherSource.includes("check-target"),
    `${launcherPath} must run the check-target downgrade guard before applying an update`,
  );
}
const updatesRoutesSource = readFileSync(
  join(repositoryRoot, "packages/server/src/routes/updates.routes.ts"),
  "utf8",
);
for (const pinnedFragment of ["checkTargetStorageFormat", ":storage-format.json", "targetFormat >= onDiskFormat"]) {
  assert.ok(
    updatesRoutesSource.includes(pinnedFragment),
    `updates.routes.ts must keep its twin of the launcher guard (missing: ${pinnedFragment}) — the server cannot import scripts/protect-launcher-data.mjs`,
  );
}
const launcherGuardSource = readFileSync(join(repositoryRoot, "scripts/protect-launcher-data.mjs"), "utf8");
for (const pinnedFragment of [":storage-format.json", "targetFormat >= onDiskFormat"]) {
  assert.ok(
    launcherGuardSource.includes(pinnedFragment),
    `protect-launcher-data.mjs guard drifted from its updates.routes.ts twin (missing: ${pinnedFragment})`,
  );
}

// ── checkTargetStorageFormat against a real git fixture ──

function gitFixtureRepo() {
  const repo = mkdtempSync(join(tmpdir(), "marinara-format-guard-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet");
  git("config", "user.email", "regression@example.invalid");
  git("config", "user.name", "Format Guard Regression");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "pre-sharding build (no storage-format.json)");
  const preShardingRef = git("rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "storage-format.json"), `${JSON.stringify({ storageFormat: 3 })}\n`);
  git("add", "storage-format.json");
  git("commit", "--quiet", "-m", "sharded build (format 3)");
  const shardedRef = git("rev-parse", "HEAD").trim();
  return { repo, preShardingRef, shardedRef };
}

function storageFixture(manifestVersion) {
  const dir = mkdtempSync(join(tmpdir(), "marinara-format-storage-"));
  if (manifestVersion !== null) {
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ version: manifestVersion, savedAt: "2026-08-08T00:00:00.000Z", backend: "file-native", tables: {} }),
    );
  }
  return dir;
}

{
  const { repo, preShardingRef, shardedRef } = gitFixtureRepo();
  const formatThreeData = storageFixture(3);
  const formatTwoData = storageFixture(2);
  const freshData = storageFixture(null);
  const envFor = (dir) => ({ FILE_STORAGE_DIR: dir });
  try {
    const blocked = await checkTargetStorageFormat({ root: repo, env: envFor(formatThreeData), targetRef: preShardingRef });
    assert.deepEqual(
      blocked,
      { compatible: false, onDiskFormat: 3, targetFormat: 2 },
      "format-3 data must refuse a target ref that predates storage-format.json (absent -> 2)",
    );
    const allowed = await checkTargetStorageFormat({ root: repo, env: envFor(formatThreeData), targetRef: shardedRef });
    assert.equal(allowed.compatible, true, "format-3 data accepts a format-3 target");
    const upgrade = await checkTargetStorageFormat({ root: repo, env: envFor(formatTwoData), targetRef: shardedRef });
    assert.equal(upgrade.compatible, true, "format-2 data accepts a NEWER target (upgrades are always allowed)");
    const sideways = await checkTargetStorageFormat({ root: repo, env: envFor(formatTwoData), targetRef: preShardingRef });
    assert.equal(sideways.compatible, true, "format-2 data accepts a format-2 target");
    const fresh = await checkTargetStorageFormat({ root: repo, env: envFor(freshData), targetRef: preShardingRef });
    assert.deepEqual(
      fresh,
      { compatible: true, onDiskFormat: null, targetFormat: null },
      "no manifest means nothing to protect — never block a fresh install",
    );
  } finally {
    for (const dir of [repo, formatThreeData, formatTwoData, freshData]) rmSync(dir, { recursive: true, force: true });
  }
}

// ── The check-target CLI: exit 2 + [BLOCK] on incompatible, exit 0 otherwise ──

{
  const guardScript = join(repositoryRoot, "scripts", "protect-launcher-data.mjs");
  const newerData = storageFixture(99);
  const currentData = storageFixture(2);
  try {
    const blocked = spawnSync(process.execPath, [guardScript, "check-target", "HEAD"], {
      encoding: "utf8",
      env: { ...process.env, FILE_STORAGE_DIR: newerData },
    });
    assert.equal(blocked.status, 2, "check-target must exit 2 when the target cannot read the data");
    assert.match(blocked.stderr, /\[BLOCK\]/, "the refusal must print a [BLOCK] line for the launcher log");
    const allowed = spawnSync(process.execPath, [guardScript, "check-target", "HEAD"], {
      encoding: "utf8",
      env: { ...process.env, FILE_STORAGE_DIR: currentData },
    });
    assert.equal(allowed.status, 0, "check-target must exit 0 for a compatible target");
  } finally {
    for (const dir of [newerData, currentData]) rmSync(dir, { recursive: true, force: true });
  }
}

// ── unshard: rebuild the monolith layout from shards ──

const row = (id, chatId, createdAt, content) => ({ id, chatId, role: "user", content, createdAt });

function shardedStorageFixture() {
  const dir = mkdtempSync(join(tmpdir(), "marinara-unshard-"));
  mkdirSync(join(dir, "tables", "messages"), { recursive: true });
  mkdirSync(join(dir, "tables", "message_swipes"), { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      version: 3,
      savedAt: "2026-08-08T00:00:00.000Z",
      backend: "file-native",
      tables: {},
      shards: { messages: 2, message_swipes: 1 },
    }),
  );
  return dir;
}

{
  const dir = shardedStorageFixture();
  writeFileSync(
    join(dir, "tables", "messages", "chat-a.json"),
    JSON.stringify([row("m-2", "chat-a", "2026-08-08T10:00:02.000Z", "second"), row("m-1", "chat-a", "2026-08-08T10:00:01.000Z", "first")]),
  );
  writeFileSync(
    join(dir, "tables", "messages", "chat-b.json"),
    JSON.stringify([row("m-3", "chat-b", "2026-08-08T10:00:03.000Z", "third")]),
  );
  writeFileSync(
    join(dir, "tables", "message_swipes", "orphaned-rows.json"),
    JSON.stringify([{ id: "s-1", messageId: "m-gone", index: 0, content: "orphan", createdAt: "2026-08-08T10:00:04.000Z" }]),
  );
  try {
    const result = await unshardLauncherStorage({ env: { FILE_STORAGE_DIR: dir } });
    const monolith = JSON.parse(readFileSync(join(dir, "tables", "messages.json"), "utf8"));
    assert.deepEqual(
      monolith.map((entry) => entry.id),
      ["m-1", "m-2", "m-3"],
      "the rebuilt monolith holds every shard's rows in (createdAt, id) order",
    );
    const swipes = JSON.parse(readFileSync(join(dir, "tables", "message_swipes.json"), "utf8"));
    assert.equal(swipes.length, 1, "orphaned-rows shards are folded into the monolith like any other");
    assert.equal(existsSync(join(dir, "tables", "messages")), false, "the shard directory is renamed away");
    assert.ok(
      readdirSync(join(dir, "tables")).some((name) => name.startsWith("messages.post-unshard-")),
      "the shard files are kept as .post-unshard-<timestamp>, never deleted",
    );
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.version, 2, "the manifest is rewritten as format 2 so the guard stops refusing the downgrade");
    assert.equal("shards" in manifest, false, "the shards diagnostic is dropped from the format-2 manifest");
    assert.equal(result.warnings.length, 0, "a clean conversion reports no warnings");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── unshard: duplicates keep-first, bak-only shards recovered ──

{
  const dir = shardedStorageFixture();
  const dup = row("m-dup", "chat-a", "2026-08-08T10:00:01.000Z", "original");
  writeFileSync(join(dir, "tables", "messages", "chat-a.json"), JSON.stringify([dup]));
  writeFileSync(
    join(dir, "tables", "messages", "chat-b.json"),
    JSON.stringify([{ ...dup, chatId: "chat-b", createdAt: "2026-08-08T10:00:02.000Z", content: "stale copy" }]),
  );
  writeFileSync(
    join(dir, "tables", "messages", "chat-c.json.bak"),
    JSON.stringify([row("m-c", "chat-c", "2026-08-08T10:00:03.000Z", "bak only")]),
  );
  try {
    await unshardLauncherStorage({ env: { FILE_STORAGE_DIR: dir } });
    const monolith = JSON.parse(readFileSync(join(dir, "tables", "messages.json"), "utf8"));
    assert.deepEqual(
      monolith.map((entry) => entry.content).sort(),
      ["bak only", "original"],
      "duplicate ids keep the first occurrence and bak-only shards are still recovered",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── unshard: crashed migration keeps the monolith authoritative ──

{
  const dir = shardedStorageFixture();
  writeFileSync(join(dir, "tables", "messages.json"), JSON.stringify([row("m-1", "chat-a", "2026-08-08T10:00:01.000Z", "authoritative")]));
  writeFileSync(join(dir, "tables", "messages", "chat-a.json"), JSON.stringify([row("m-partial", "chat-a", "2026-08-08T10:00:01.000Z", "partial")]));
  writeFileSync(join(dir, "tables", "messages", ".migrating"), "2026-08-08T00:00:00.000Z");
  try {
    await unshardLauncherStorage({ env: { FILE_STORAGE_DIR: dir } });
    const monolith = JSON.parse(readFileSync(join(dir, "tables", "messages.json"), "utf8"));
    assert.equal(monolith[0].content, "authoritative", "a crashed migration's monolith is kept, never overwritten from partial shards");
    assert.equal(existsSync(join(dir, "tables", "messages")), false, "the partial shard dir is still moved aside");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── unshard: the ambiguous forked state aborts without touching anything ──

{
  const dir = shardedStorageFixture();
  writeFileSync(join(dir, "tables", "messages.json"), JSON.stringify([row("m-old", "chat-a", "2026-08-08T10:00:01.000Z", "old-build rows")]));
  writeFileSync(join(dir, "tables", "messages", "chat-a.json"), JSON.stringify([row("m-new", "chat-a", "2026-08-08T10:00:02.000Z", "sharded rows")]));
  try {
    await assert.rejects(
      unshardLauncherStorage({ env: { FILE_STORAGE_DIR: dir } }),
      /both a monolith and shard files/i,
      "monolith + shards with no in-progress marker is forked history — refuse to guess a merge",
    );
    assert.ok(existsSync(join(dir, "tables", "messages", "chat-a.json")), "the aborted run changed nothing");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.version, 3, "the aborted run left the manifest alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── unshard: an unreadable shard aborts before any write ──

{
  const dir = shardedStorageFixture();
  writeFileSync(join(dir, "tables", "messages", "chat-a.json"), JSON.stringify([row("m-1", "chat-a", "2026-08-08T10:00:01.000Z", "fine")]));
  writeFileSync(join(dir, "tables", "messages", "chat-b.json"), "{not json");
  try {
    await assert.rejects(
      unshardLauncherStorage({ env: { FILE_STORAGE_DIR: dir } }),
      /cannot parse shard file/i,
      "an unreadable shard with no .bak must abort the conversion",
    );
    assert.equal(existsSync(join(dir, "tables", "messages.json")), false, "no partial monolith is left behind");
    assert.ok(existsSync(join(dir, "tables", "messages", "chat-a.json")), "the readable shards are untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.info("Launcher format-guard regressions passed.");
