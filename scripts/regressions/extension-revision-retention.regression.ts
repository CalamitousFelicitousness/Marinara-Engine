import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personalExtensionRevisionRetentionSchema } from "../../packages/shared/src/schemas/personal-extension.schema.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { personalExtensionsRoutes } from "../../packages/server/src/routes/personal-extensions.routes.js";
import { createPersonalExtensionSettingsStorage } from "../../packages/server/src/services/extensions/personal-extension-settings.service.js";
import { createPersonalExtensionsStorage } from "../../packages/server/src/services/extensions/personal-extension-storage.service.js";
import { createAppSettingsStorage } from "../../packages/server/src/services/storage/app-settings.storage.js";

const requireFromServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireFromServer("fastify") as typeof import("fastify").default;
const directory = mkdtempSync(join(tmpdir(), "marinara-extension-retention-"));
const previousStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = directory;
const db = await createFileNativeDB();
const app = Fastify({ logger: false });
app.decorate("db", db);

try {
  await app.register(personalExtensionsRoutes, { prefix: "/api/personal-extensions" });
  const storage = createPersonalExtensionsStorage(db);
  const appSettings = createAppSettingsStorage(db);
  const userStorage = createPersonalExtensionSettingsStorage(appSettings);
  for (const raw of ["", "bad", "-1", "11"]) {
    await appSettings.set("extension-revision-retention", raw);
    assert.equal(await storage.getRevisionRetention(), 10, "Invalid stored limits preserve the default history");
  }
  await appSettings.remove("extension-revision-retention");
  const extensions = [];
  for (const source of ["professor_mari", "external"] as const) {
    const extension = await storage.create(
      { name: source, runtime: "client", js: "void 0;", version: "0" },
      { source },
    );
    assert.ok(extension);
    extensions.push(extension);
  }
  const server = await storage.create({ name: "Server", runtime: "server", serverJs: "export function start() {}" });
  assert.ok(server);
  extensions.push(server);
  for (const extension of extensions) {
    await userStorage.patch(extension.id, { saved: "keep me" });
    for (let version = 1; version <= 12; version++) {
      await storage.update(
        extension.id,
        extension.runtime === "server"
          ? { version: String(version), serverJs: `export function start() { return ${version}; }` }
          : { version: String(version), js: `void ${version};` },
      );
    }
    const current = await storage.getById(extension.id);
    assert.ok(current);
    assert.equal(current.revisions.length, 10);
    assert.equal(current.revisions[0].version, "11");
    await storage.approve(current.id, current.contentHash);
  }
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/personal-extensions/revision-history" })).json().limit,
    10,
  );
  for (const limit of [-1, 11, 1.5, "2", null]) {
    assert.equal(personalExtensionRevisionRetentionSchema.safeParse({ limit }).success, false);
  }
  const before = await storage.list();
  const denied = await app.inject({
    method: "PATCH",
    url: "/api/personal-extensions/revision-history",
    payload: { limit: 2 },
  });
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.json().code, "confirmation_required");
  assert.equal(await storage.getRevisionRetention(), 10);
  assert.deepEqual(await storage.list(), before, "An unconfirmed reduction must not delete any history");

  const accepted = await app.inject({
    method: "PATCH",
    url: "/api/personal-extensions/revision-history",
    payload: { limit: 2, confirmPrune: true },
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json(), { limit: 2 });
  assert.equal(
    await createPersonalExtensionsStorage(db).getRevisionRetention(),
    2,
    "Retention is held in shared storage",
  );
  for (const current of before) {
    const pruned = await storage.getById(current.id);
    assert.deepEqual(
      pruned,
      { ...current, revisions: current.revisions.slice(0, 2) },
      "Pruning changes only historical revisions",
    );
    assert.deepEqual(await userStorage.get(current.id), { saved: "keep me" });
    const restored = await storage.rollback(current.id, current.revisions[0].contentHash);
    assert.ok(restored);
    assert.equal(restored.revisions.length, 2);
    assert.equal(
      restored.revisions[0].contentHash,
      current.contentHash,
      "Rollback retains the previous current code first",
    );
  }

  await storage.setRevisionRetention({ limit: 0, confirmPrune: true });
  for (const extension of extensions) {
    const updated = await storage.update(
      extension.id,
      extension.runtime === "server" ? { serverJs: "export function start() { return 100; }" } : { js: "void 100;" },
    );
    assert.deepEqual(updated?.revisions, [], "Zero disables history for every source and runtime");
  }
  assert.deepEqual(
    await storage.setRevisionRetention({ limit: 5 }),
    { limit: 5 },
    "Increasing retention requires no deletion confirmation",
  );
  const personal = extensions[0];
  await Promise.all([
    storage.update(personal.id, { js: "void 101;" }),
    createPersonalExtensionsStorage(db).setRevisionRetention({ limit: 1, confirmPrune: true }),
    storage.update(personal.id, { js: "void 102;" }),
  ]);
  assert.equal(
    (await storage.getById(personal.id))?.revisions.length,
    1,
    "A concurrent edit cannot restore pruned history",
  );
  assert.deepEqual(await userStorage.get(personal.id), { saved: "keep me" });
  console.info("Extension revision retention regression passed");
} finally {
  await app.close();
  await db._fileStore.close();
  if (previousStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageDir;
  rmSync(directory, { recursive: true, force: true });
}
