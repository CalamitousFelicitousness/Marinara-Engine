import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDB, getDB } from "../../packages/server/src/db/connection.js";
import {
  createFileNativeDB,
  STORAGE_WRITER_LEASE_FILENAME,
  STORAGE_WRITER_OWNER_FILENAME,
  StorageConcurrentWriterError,
  StorageWriterLeaseError,
} from "../../packages/server/src/db/file-backed-store.js";
import { appSettings, chats, lorebookEntries, lorebooks, messages } from "../../packages/server/src/db/schema/index.js";
import { eq } from "../../packages/server/src/db/file-query.js";
import { getMariDbService } from "../../packages/server/src/services/mari-db/mari-db.service.js";

const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
const tempDirs: string[] = [];

function tempStorageDir(label: string) {
  const dir = mkdtempSync(join(tmpdir(), `marinara-${label}-`));
  tempDirs.push(dir);
  process.env.FILE_STORAGE_DIR = dir;
  return dir;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

type LeaseRecord = {
  version: 2;
  reclaimable: boolean;
  pid: number;
  processStartedAt: number;
  processStartIdentity: string | null;
  hostIdentity: string;
  hostname: string;
  bootIdentity: string;
  pidNamespaceIdentity: string | null;
  token: string;
  acquiredAt: string;
};

function leasePath(storageDir: string) {
  return join(storageDir, STORAGE_WRITER_LEASE_FILENAME);
}

function leaseOwnerPath(storageDir: string) {
  return join(leasePath(storageDir), STORAGE_WRITER_OWNER_FILENAME);
}

function readLease(storageDir: string) {
  return readJson<LeaseRecord>(leaseOwnerPath(storageDir));
}

function writeLease(storageDir: string, record: LeaseRecord | Record<string, unknown>) {
  const path = leasePath(storageDir);
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path);
  writeFileSync(join(path, STORAGE_WRITER_OWNER_FILENAME), JSON.stringify(record, null, 2));
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function exitedChildPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.ok(child.pid, "the stale-lease fixture child has a PID");
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return child.pid!;
}

type LeaseContenderResult = { status: "acquired"; pid: number } | { status: "rejected"; name: string; message: string };

function spawnLeaseContender(storageDir: string) {
  const source = String.raw`
    void (async () => {
      const { createFileNativeDB } = await import("./src/db/file-backed-store.ts");
      try {
        const db = await createFileNativeDB({
          afterWriterLeaseReclaimClaim: () => new Promise((resolve) => setTimeout(resolve, 250)),
        });
        process.on("message", async (message) => {
          if (message !== "close") return;
          await db._fileStore.close();
          process.exit(0);
        });
        process.send?.({ status: "acquired", pid: process.pid });
      } catch (error) {
        process.send?.({
          status: "rejected",
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
        });
        process.exit(0);
      }
    })();
  `;
  const serverDir = existsSync(join(process.cwd(), "src", "db", "file-backed-store.ts"))
    ? process.cwd()
    : join(process.cwd(), "packages", "server");
  const child = spawn(process.execPath, ["--import", "tsx", "--eval", source], {
    cwd: serverDir,
    env: { ...process.env, FILE_STORAGE_DIR: storageDir },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const result = new Promise<LeaseContenderResult>((resolve, reject) => {
    child.once("message", (message) => resolve(message as LeaseContenderResult));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code && code !== 0) reject(new Error(`lease contender exited ${code}: ${stderr}`));
    });
  });
  return { child, result };
}

function waitForExit(child: ReturnType<typeof spawn>) {
  return new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
}

try {
  // The exact Professor Mari paths from #5013 remain durable through the
  // debounce, an explicit flush, and a full DB close/reopen. The reopen also
  // proves getMariDbService rebinds instead of retaining a closed DB instance.
  {
    const dir = tempStorageDir("storage-lorebook");
    const db = await getDB();
    const firstMari = getMariDbService(db);
    try {
      const created = await firstMari.executeAction({
        action: "lorebook.create",
        lorebookId: "ordinary-book",
        data: {
          name: "Ordinary Book",
          entries: Array.from({ length: 3 }, (_, index) => ({
            name: `Initial ${index + 1}`,
            content: `Initial content ${index + 1}`,
          })),
        },
        apply: true,
      });
      assert.equal(created.ok, true, "the initial lorebook create succeeds");

      const added = await firstMari.executeAction({
        action: "lorebook.addEntry",
        lorebookId: "ordinary-book",
        entryId: "debounced-entry",
        data: { name: "Debounced", content: "Must survive" },
        apply: true,
      });
      assert.equal(added.ok, true, "single-entry add succeeds");
      const immediate = (
        await firstMari.executeAction({
          action: "lorebook.entries",
          lorebookId: "ordinary-book",
        })
      ).output as Array<{ id: string }>;
      assert.ok(
        immediate.some((entry) => entry.id === "debounced-entry"),
        "the added entry is immediately visible",
      );

      await wait(850);
      await db._fileStore.flush();
      const afterDebounce = readJson<Array<{ id: string }>>(join(dir, "tables", "lorebook_entries.json"));
      assert.ok(
        afterDebounce.some((entry) => entry.id === "debounced-entry"),
        "the debounce persists the entry",
      );

      const eleven = await firstMari.executeAction({
        action: "lorebook.create",
        lorebookId: "eleven-entry-book",
        data: {
          name: "Eleven Entry Book",
          entries: Array.from({ length: 11 }, (_, index) => ({
            name: `Entry ${index + 1}`,
            content: `Content ${index + 1}`,
          })),
        },
        apply: true,
      });
      assert.equal(eleven.ok, true, "an 11-entry atomic create succeeds");
      await db._fileStore.flush();
      const elevenEntries = (
        await firstMari.executeAction({
          action: "lorebook.entries",
          lorebookId: "eleven-entry-book",
        })
      ).output as Array<{ id: string }>;
      assert.equal(elevenEntries.length, 11, "all 11 entries are visible before restart");
    } finally {
      await closeDB();
    }

    assert.equal(
      existsSync(join(dir, STORAGE_WRITER_LEASE_FILENAME)),
      false,
      "a clean DB close releases the writer lease",
    );
    const reopenedDb = await getDB();
    const reopenedMari = getMariDbService(reopenedDb);
    try {
      assert.notStrictEqual(reopenedMari, firstMari, "the Mari service rebinds when the DB identity changes");
      const ordinaryEntries = (
        await reopenedMari.executeAction({
          action: "lorebook.entries",
          lorebookId: "ordinary-book",
        })
      ).output as Array<{ id: string }>;
      assert.equal(ordinaryEntries.length, 4, "the initial and added entries survive a full reopen");
      assert.ok(ordinaryEntries.some((entry) => entry.id === "debounced-entry"));
      const elevenEntries = (
        await reopenedMari.executeAction({
          action: "lorebook.entries",
          lorebookId: "eleven-entry-book",
        })
      ).output as Array<{ id: string }>;
      assert.equal(elevenEntries.length, 11, "the 11-entry create survives a full reopen");
    } finally {
      await closeDB();
    }
  }

  // Manifest table counts are diagnostics. A stale count never hides a valid
  // row, and startup rewrites the diagnostic count from the loaded table.
  {
    const dir = tempStorageDir("storage-stale-count");
    const timestamp = "2026-08-14T00:00:00.000Z";
    const db = await createFileNativeDB();
    await db
      .insert(lorebooks)
      .values({ id: "count-book", name: "Count Book", createdAt: timestamp, updatedAt: timestamp });
    await db.insert(lorebookEntries).values({
      id: "count-entry",
      lorebookId: "count-book",
      name: "Visible",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await db._fileStore.flush();
    await db._fileStore.close();

    const manifestPath = join(dir, "manifest.json");
    const staleManifest = readJson<{ savedAt: string; tables: Record<string, number> }>(manifestPath);
    staleManifest.savedAt = "2026-08-13T00:00:00.000Z";
    staleManifest.tables.lorebook_entries = 0;
    writeFileSync(manifestPath, JSON.stringify(staleManifest, null, 2));

    const reopened = await createFileNativeDB();
    try {
      const rows = await reopened.select().from(lorebookEntries);
      assert.deepEqual(
        rows.map((row) => row.id),
        ["count-entry"],
        "a stale manifest count never filters a valid table row",
      );
      const healed = readJson<{ tables: Record<string, number> }>(manifestPath);
      assert.equal(healed.tables.lorebook_entries, 1, "startup heals the diagnostic count from loaded rows");
    } finally {
      await reopened._fileStore.close();
    }
  }

  // Every post-acquire initialization failure releases the authoritative
  // lease. A crash while preparing a complete candidate directory leaves a
  // harmless process-owned transient which no contender is allowed to erase.
  {
    const dir = tempStorageDir("storage-init-cleanup");
    const manifestPath = join(dir, "manifest.json");
    mkdirSync(manifestPath);
    await assert.rejects(createFileNativeDB(), "an unreadable manifest fails initialization");
    assert.equal(
      existsSync(join(dir, STORAGE_WRITER_LEASE_FILENAME)),
      false,
      "initialization failure releases the already-acquired writer lease",
    );
    rmSync(manifestPath, { recursive: true });

    const abandonedCandidate = join(dir, `${STORAGE_WRITER_LEASE_FILENAME}.candidate-crashed-partial`);
    mkdirSync(abandonedCandidate);
    writeFileSync(join(abandonedCandidate, STORAGE_WRITER_OWNER_FILENAME), "");
    const retry = await createFileNativeDB();
    try {
      assert.equal(
        existsSync(abandonedCandidate),
        true,
        "another process's unpublished candidate is harmless and never globally deleted",
      );
      assert.doesNotThrow(() => readLease(dir), "the authoritative lease is always complete JSON");
    } finally {
      await retry._fileStore.close();
    }
  }

  // Exactly one live store may own a data directory. A clean close hands off
  // immediately, while a crashed owner's lease is reclaimed only after PID
  // liveness proves the process exited.
  {
    const dir = tempStorageDir("storage-lease");
    const first = await createFileNativeDB();
    const leaseTemplate = readLease(dir);
    await assert.rejects(
      createFileNativeDB(),
      (error: unknown) =>
        error instanceof StorageWriterLeaseError &&
        error.message.includes(String(process.pid)) &&
        error.message.includes(dir),
      "a second live store for one data directory is rejected with owner details",
    );
    await first._fileStore.close();

    const successor = await createFileNativeDB();
    await successor._fileStore.close();

    const activeLeasePath = leasePath(dir);
    writeLease(dir, {});
    await assert.rejects(
      createFileNativeDB(),
      (error: unknown) => error instanceof StorageWriterLeaseError && /refused to guess/iu.test(error.message),
      "an invalid lease is never reclaimed without PID-liveness evidence",
    );
    assert.equal(existsSync(activeLeasePath), true, "the unproven lease is left untouched for manual inspection");
    rmSync(activeLeasePath, { recursive: true });

    const deadPid = await exitedChildPid();
    writeLease(dir, {
      ...leaseTemplate,
      pid: deadPid,
      processStartedAt: 1,
      processStartIdentity: null,
      token: "stale-token",
      acquiredAt: "2026-08-14T00:00:00.000Z",
    });
    const afterCrash = await createFileNativeDB();
    try {
      const activeLease = readLease(dir);
      assert.equal(activeLease.pid, process.pid, "the replacement lease belongs to this live process");
      assert.notEqual(activeLease.token, "stale-token", "the dead owner's token was replaced");
    } finally {
      await afterCrash._fileStore.close();
    }
    assert.equal(existsSync(activeLeasePath), false, "closing removes only the active owner's lease");

    let replacedDuringRelease = false;
    const tokenSafe = await createFileNativeDB({
      beforeWriterLeaseRelease: () => {
        if (replacedDuringRelease) return;
        replacedDuringRelease = true;
        const replacedLease = readJson<Record<string, unknown>>(leaseOwnerPath(dir));
        replacedLease.token = "replacement-owner-token";
        writeFileSync(leaseOwnerPath(dir), JSON.stringify(replacedLease));
      },
    });
    await assert.rejects(
      tokenSafe._fileStore.close(),
      (error: unknown) => error instanceof StorageConcurrentWriterError,
      "close reports a lease-owner replacement between verification and unlink",
    );
    assert.equal(
      readJson<{ token: string }>(leaseOwnerPath(dir)).token,
      "replacement-owner-token",
      "token-safe release never deletes a replacement owner's lease",
    );
  }

  // Two OS processes racing to reclaim the same dead generation elect exactly
  // one replacement owner. The loser sees a live owner/reclaimer and never
  // unlinks the winner from its earlier stale observation.
  {
    const dir = tempStorageDir("storage-simultaneous-reclaim");
    const seed = await createFileNativeDB();
    const leaseTemplate = readLease(dir);
    await seed._fileStore.close();
    const activeLeasePath = leasePath(dir);
    const deadPid = await exitedChildPid();
    writeLease(dir, {
      ...leaseTemplate,
      pid: deadPid,
      processStartedAt: 1,
      processStartIdentity: null,
      token: "simultaneous-stale-token",
      acquiredAt: "2026-08-14T00:00:00.000Z",
    });

    const contenders = [spawnLeaseContender(dir), spawnLeaseContender(dir)];
    const results = await Promise.all(contenders.map((contender) => contender.result));
    const acquiredIndexes = results.flatMap((result, index) => (result.status === "acquired" ? [index] : []));
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(acquiredIndexes.length, 1, "exactly one process reclaims and acquires the stale lease");
    assert.equal(rejected.length, 1, "the simultaneous contender fails closed");
    assert.equal(rejected[0]?.status === "rejected" ? rejected[0].name : "", "StorageWriterLeaseError");

    contenders[acquiredIndexes[0]!]!.child.send("close");
    await Promise.all(contenders.map(({ child }) => waitForExit(child)));
    assert.equal(existsSync(activeLeasePath), false, "the elected owner releases its lease cleanly");
  }

  // Complete candidate-directory publication is portable without hard links.
  // Eight fresh contenders prove that one winner cannot remove another live
  // contender's candidate and that every loser observes ordinary contention.
  {
    const dir = tempStorageDir("storage-directory-contention");
    const contenders = Array.from({ length: 8 }, () => spawnLeaseContender(dir));
    const results = await Promise.all(contenders.map((contender) => contender.result));
    const acquiredIndexes = results.flatMap((result, index) => (result.status === "acquired" ? [index] : []));
    const rejected = results.filter(
      (result): result is Extract<LeaseContenderResult, { status: "rejected" }> => result.status === "rejected",
    );
    assert.equal(acquiredIndexes.length, 1, "exactly one portable directory publication wins");
    assert.equal(rejected.length, 7, "all other directory publishers fail closed");
    assert.ok(
      rejected.every((result) => result.name === "StorageWriterLeaseError"),
      `every loser reports lease contention, not a filesystem capability failure: ${JSON.stringify(rejected)}`,
    );
    contenders[acquiredIndexes[0]!]!.child.send("close");
    await Promise.all(contenders.map(({ child }) => waitForExit(child)));
    assert.equal(existsSync(leasePath(dir)), false, "the sole winner releases cleanly after the stress race");
  }

  // Host, namespace, and exact process-start identity are mandatory before a
  // stale PID may be interpreted. Cross-host/shared-volume records and a
  // same-PID record with a merely different JS time origin always fail closed.
  {
    const dir = tempStorageDir("storage-identity-fail-closed");
    const seed = await createFileNativeDB();
    const template = readLease(dir);
    await seed._fileStore.close();
    const deadPid = await exitedChildPid();

    writeLease(dir, {
      ...template,
      pid: deadPid,
      processStartedAt: 1,
      processStartIdentity: null,
      hostIdentity: "different-host-or-container",
      hostname: "different-host-or-container",
      token: "cross-host-token",
    });
    await assert.rejects(
      createFileNativeDB(),
      StorageWriterLeaseError,
      "a dead-looking PID from another host/container is never reclaimed",
    );
    assert.equal(readLease(dir).token, "cross-host-token", "the cross-host generation remains untouched");
    rmSync(leasePath(dir), { recursive: true });

    writeLease(dir, {
      ...template,
      pid: process.pid,
      processStartedAt: 1,
      token: "same-process-start-token",
    });
    await assert.rejects(
      createFileNativeDB(),
      StorageWriterLeaseError,
      "a changed performance.timeOrigin alone never proves that the same PID exited",
    );
    assert.equal(readLease(dir).token, "same-process-start-token");
    rmSync(leasePath(dir), { recursive: true });

    if (process.platform === "linux") {
      writeLease(dir, {
        ...template,
        pid: deadPid,
        processStartedAt: 1,
        processStartIdentity: null,
        pidNamespaceIdentity: "pid:[different-namespace]",
        token: "cross-namespace-token",
      });
      await assert.rejects(
        createFileNativeDB(),
        StorageWriterLeaseError,
        "a PID from another Linux namespace is never used as liveness evidence",
      );
      assert.equal(readLease(dir).token, "cross-namespace-token");
      rmSync(leasePath(dir), { recursive: true });
    }
  }

  // Restricted Termux/Android environments may expose neither machine-id nor
  // MAC addresses. They can still acquire/release a non-reclaimable lease;
  // after a simulated crash, startup fails closed with manual-cleanup advice.
  {
    const dir = tempStorageDir("storage-no-host-identity");
    const restrictedIdentity = { writerLeaseIdentity: { hostIdentity: null } } as const;
    const first = await createFileNativeDB(restrictedIdentity);
    const template = readLease(dir);
    assert.equal(template.reclaimable, false, "the process-local fallback is explicitly non-reclaimable");
    await assert.rejects(
      createFileNativeDB(restrictedIdentity),
      (error: unknown) => error instanceof StorageWriterLeaseError && /non-reclaimable/iu.test(error.message),
      "a live process-local lease still excludes a second writer",
    );
    await first._fileStore.close();
    const successor = await createFileNativeDB(restrictedIdentity);
    await successor._fileStore.close();

    const deadPid = await exitedChildPid();
    writeLease(dir, {
      ...template,
      pid: deadPid,
      processStartedAt: 1,
      token: "non-reclaimable-crash-token",
    });
    await assert.rejects(
      createFileNativeDB(restrictedIdentity),
      (error: unknown) =>
        error instanceof StorageWriterLeaseError && /remove only that lease directory/iu.test(error.message),
      "a crashed process-local lease gives actionable fail-closed cleanup guidance",
    );
    assert.equal(readLease(dir).token, "non-reclaimable-crash-token");
    rmSync(leasePath(dir), { recursive: true });
  }

  // A batch conflict in a later primary cannot leave earlier tables from the
  // same logical action partially committed. This reproduces the exact
  // lorebooks-then-lorebook_entries ordering from #5013.
  {
    const dir = tempStorageDir("storage-lorebook-batch-rollback");
    const lorebooksPath = join(dir, "tables", "lorebooks.json");
    const entriesPath = join(dir, "tables", "lorebook_entries.json");
    const externalEntriesBytes = JSON.stringify([
      {
        id: "external-entry",
        lorebookId: "external-book",
        name: "External",
        content: "Must be preserved",
        createdAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2099-01-01T00:00:00.000Z",
      },
    ]);
    let injectEntryConflict = false;
    const db = await createFileNativeDB({
      beforeTableWrite: (table) => {
        if (table !== "lorebook_entries" || !injectEntryConflict) return;
        injectEntryConflict = false;
        writeFileSync(entriesPath, externalEntriesBytes);
      },
    });
    let conflictDetected = false;
    try {
      await db.insert(appSettings).values({ key: "batch-baseline", value: "1", updatedAt: "2026-08-14" });
      await db._fileStore.flush();
      const baselineLorebooks = readFileSync(lorebooksPath, "utf8");
      const baselineManifest = readFileSync(join(dir, "manifest.json"), "utf8");
      const timestamp = "2026-08-14T00:00:00.000Z";
      await db
        .insert(lorebooks)
        .values({ id: "local-book", name: "Local Book", createdAt: timestamp, updatedAt: timestamp });
      await db.insert(lorebookEntries).values({
        id: "local-entry",
        lorebookId: "local-book",
        name: "Local Entry",
        content: "Must commit together",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      injectEntryConflict = true;

      await assert.rejects(
        db._fileStore.flush(),
        (error: unknown) =>
          error instanceof StorageConcurrentWriterError && /lorebook_entries\.json changed/iu.test(error.message),
        "a later-table external advance rejects the complete lorebook batch",
      );
      conflictDetected = true;
      assert.equal(
        readFileSync(lorebooksPath, "utf8"),
        baselineLorebooks,
        "the earlier lorebooks.json write is rolled back byte-for-byte",
      );
      assert.equal(
        readFileSync(entriesPath, "utf8"),
        externalEntriesBytes,
        "the later external lorebook_entries generation is never overwritten",
      );
      assert.equal(
        readFileSync(join(dir, "manifest.json"), "utf8"),
        baselineManifest,
        "a partially rejected table set never receives a new manifest",
      );
      await assert.rejects(db._fileStore.close(), StorageConcurrentWriterError);
    } finally {
      if (!conflictDetected) await db._fileStore.close().catch(() => undefined);
    }
  }

  // Shard deletion atomically moves and validates the exact generation. A
  // legacy writer replacement in the former check/unlink gap is restored to
  // the canonical path and never deleted.
  {
    const dir = tempStorageDir("storage-delete-generation");
    const messagePath = join(dir, "tables", "messages", "delete-chat.json");
    let replaceBeforeDelete = false;
    const db = await createFileNativeDB({
      beforeSnapshotDeleteCommit: (path) => {
        if (path !== messagePath || !replaceBeforeDelete) return;
        replaceBeforeDelete = false;
        const originalRows = readJson<Array<Record<string, unknown>>>(messagePath);
        writeFileSync(
          messagePath,
          JSON.stringify([
            ...originalRows,
            {
              id: "external-message",
              chatId: "delete-chat",
              role: "assistant",
              content: "External replacement",
              activeSwipeIndex: 0,
              extra: "{}",
              createdAt: "2099-01-01T00:00:00.000Z",
            },
          ]),
        );
      },
    });
    let conflictDetected = false;
    try {
      const timestamp = "2026-08-14T00:00:00.000Z";
      await db.insert(chats).values({
        id: "delete-chat",
        name: "Delete Chat",
        mode: "conversation",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await db.insert(messages).values({
        id: "delete-message",
        chatId: "delete-chat",
        role: "user",
        content: "Delete me",
        createdAt: timestamp,
      });
      await db._fileStore.flush();
      await db.delete(messages).where(eq(messages.id, "delete-message"));
      replaceBeforeDelete = true;

      await assert.rejects(
        db._fileStore.flush(),
        (error: unknown) =>
          error instanceof StorageConcurrentWriterError &&
          /messages[/\\]delete-chat\.json changed during deletion/iu.test(error.message),
        "a shard replacement during deletion is detected",
      );
      conflictDetected = true;
      assert.ok(
        readFileSync(messagePath, "utf8").includes("external-message"),
        "the replacement generation remains at the canonical shard path",
      );
      await assert.rejects(db._fileStore.close(), StorageConcurrentWriterError);
    } finally {
      if (!conflictDetected) await db._fileStore.close().catch(() => undefined);
    }
  }

  // Reproduce the mixed-version order the manifest-only guard missed: a
  // legacy/bypassed writer changes a table AFTER our flush's first manifest
  // check but BEFORE its own manifest update. Per-table optimistic state must
  // reject before our local snapshot can replace those external bytes.
  {
    const dir = tempStorageDir("storage-table-guard");
    const settingsPath = join(dir, "tables", "app_settings.json");
    let injectExternalWrite = false;
    const externalRows = [{ key: "external", value: "newer", updatedAt: "2099-01-01" }];
    const externalTableBytes = JSON.stringify(externalRows);
    const db = await createFileNativeDB({
      beforeTableWrite: (table) => {
        if (table !== "app_settings" || !injectExternalWrite) return;
        injectExternalWrite = false;
        writeFileSync(settingsPath, externalTableBytes);
      },
    });
    let conflictDetected = false;
    try {
      await db.insert(appSettings).values({ key: "base", value: "base", updatedAt: "2026-08-14" });
      await db._fileStore.flush();
      const manifestBytes = readFileSync(join(dir, "manifest.json"), "utf8");
      await db.insert(appSettings).values({ key: "local", value: "must-not-overwrite", updatedAt: "2026-08-14" });
      injectExternalWrite = true;

      await assert.rejects(
        db._fileStore.flush(),
        (error: unknown) =>
          error instanceof StorageConcurrentWriterError && /app_settings\.json changed/iu.test(error.message),
        "a table-only legacy advance during the flush is rejected",
      );
      conflictDetected = true;
      assert.equal(readFileSync(settingsPath, "utf8"), externalTableBytes, "external table bytes remain untouched");
      assert.equal(
        readFileSync(join(dir, "manifest.json"), "utf8"),
        manifestBytes,
        "the rejected flush does not cover the external table with a local manifest",
      );
      await assert.rejects(db._fileStore.close(), StorageConcurrentWriterError);
    } finally {
      if (!conflictDetected) await db._fileStore.close().catch(() => undefined);
    }
  }

  // A writer that advanced manifest.json behind this process causes a hard,
  // fail-closed flush. No dirty in-memory snapshot may overwrite its table.
  {
    const dir = tempStorageDir("storage-manifest-guard");
    const db = await createFileNativeDB();
    const settingsPath = join(dir, "tables", "app_settings.json");
    const manifestPath = join(dir, "manifest.json");
    let conflictDetected = false;
    try {
      await db.insert(appSettings).values({ key: "base", value: "base", updatedAt: "2026-08-14" });
      await db._fileStore.flush();
      await db.insert(appSettings).values({ key: "local", value: "must-not-overwrite", updatedAt: "2026-08-14" });

      const externalRows = [
        { key: "base", value: "base", updatedAt: "2026-08-14" },
        { key: "external", value: "newer", updatedAt: "2026-08-14" },
      ];
      const externalTableBytes = JSON.stringify(externalRows);
      writeFileSync(settingsPath, externalTableBytes);
      const advancedManifest = readJson<{ savedAt: string }>(manifestPath);
      advancedManifest.savedAt = "2099-01-01T00:00:00.000Z";
      writeFileSync(manifestPath, JSON.stringify(advancedManifest, null, 2));

      await assert.rejects(
        db._fileStore.flush(),
        (error: unknown) => error instanceof StorageConcurrentWriterError,
        "an externally advanced manifest rejects the flush",
      );
      conflictDetected = true;
      assert.equal(readFileSync(settingsPath, "utf8"), externalTableBytes, "the external table bytes remain untouched");
      await assert.rejects(
        db._fileStore.close(),
        (error: unknown) => error instanceof StorageConcurrentWriterError,
        "close reports the detected conflict while discarding only this process's dirty snapshot",
      );
      assert.equal(
        existsSync(join(dir, STORAGE_WRITER_LEASE_FILENAME)),
        false,
        "a conflicted close releases its own lease without deleting external data",
      );
    } finally {
      if (!conflictDetected) await db._fileStore.close().catch(() => undefined);
    }
  }

  // Professor Mari must not report saved:true when her forced durable flush
  // observes the same conflict.
  {
    const dir = tempStorageDir("storage-mari-failure");
    const db = await getDB();
    const mari = getMariDbService(db);
    try {
      const created = await mari.executeAction({
        action: "lorebook.create",
        lorebookId: "failure-book",
        data: { name: "Failure Book" },
        apply: true,
      });
      assert.equal(created.ok, true);

      const entriesPath = join(dir, "tables", "lorebook_entries.json");
      const beforeEntries = readFileSync(entriesPath, "utf8");
      const manifestPath = join(dir, "manifest.json");
      const advancedManifest = readJson<{ savedAt: string }>(manifestPath);
      advancedManifest.savedAt = "2099-01-02T00:00:00.000Z";
      writeFileSync(manifestPath, JSON.stringify(advancedManifest, null, 2));

      const failed = await mari.executeAction({
        action: "lorebook.addEntry",
        lorebookId: "failure-book",
        entryId: "must-not-save",
        data: { name: "Must Not Save", content: "Conflict" },
        apply: true,
      });
      const userFacingSaved = failed.mode === "apply" && failed.ok === true;
      assert.equal(failed.ok, false, "Mari reports the durable write failure");
      assert.equal(userFacingSaved, false, "the workspace result maps the failed apply to saved:false");
      assert.equal(failed.mode, "apply");
      assert.match(failed.error ?? "", /another writer|manifest\.json changed/iu);
      assert.equal(
        readFileSync(entriesPath, "utf8"),
        beforeEntries,
        "the failed Mari write never reaches the table file",
      );
    } finally {
      await closeDB();
    }
    assert.equal(
      existsSync(join(dir, STORAGE_WRITER_LEASE_FILENAME)),
      false,
      "the failed Mari process releases its lease during shutdown",
    );
  }

  // A non-concurrent final-write failure cannot reopen a store after close()
  // has removed every autosave hook. It stays terminal and retains the lease,
  // preventing another process from mistaking the failed shutdown for a clean
  // handoff with no unsaved state.
  {
    const dir = tempStorageDir("storage-close-failure");
    const expectedFailure = new Error("simulated final snapshot failure");
    let failFinalWrite = false;
    const db = await createFileNativeDB({
      beforeTableWrite: (table) => {
        if (failFinalWrite && table === "app_settings") throw expectedFailure;
      },
    });
    await db.insert(appSettings).values({ key: "unsaved", value: "one", updatedAt: "2026-08-14" });
    failFinalWrite = true;
    await assert.rejects(db._fileStore.close(), expectedFailure);
    await assert.rejects(
      db.insert(appSettings).values({ key: "must-reject", value: "two", updatedAt: "2026-08-14" }),
      /closing or already closed/iu,
      "a failed close leaves storage terminal instead of writable without autosave",
    );
    assert.equal(
      existsSync(join(dir, STORAGE_WRITER_LEASE_FILENAME)),
      true,
      "a failed final flush is not advertised as a clean writer handoff",
    );
  }

  console.info("Storage single-writer and lorebook durability regressions passed.");
} finally {
  await closeDB();
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}
