import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";

// Covers lorebook activation statistics: batched writes, the generation hook,
// cascade on entry delete, and failure safety.

const dataDir = mkdtempSync(join(tmpdir(), "marinara-lorebook-activation-stats-"));
const previous = {
  DATA_DIR: process.env.DATA_DIR,
  FILE_STORAGE_DIR: process.env.FILE_STORAGE_DIR,
  MARINARA_FILE_STORAGE_DIR: process.env.MARINARA_FILE_STORAGE_DIR,
};
type Response = { statusCode: number; body: string; json(): any };
let app: {
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<Response>;
} | null = null;

try {
  const fileStorageDir = join(dataDir, "file-storage");
  process.env.DATA_DIR = dataDir;
  process.env.FILE_STORAGE_DIR = fileStorageDir;
  process.env.MARINARA_FILE_STORAGE_DIR = fileStorageDir;

  // A minimal app with just the lorebook routes keeps this well inside the time budget.
  const [{ createFileNativeDB }, { lorebooksRoutes }, stats, featureSettings] = await Promise.all([
    import("../../packages/server/src/db/file-backed-store.js"),
    import("../../packages/server/src/routes/lorebooks.routes.js"),
    import("../../packages/server/src/services/lorebook/activation-stats.js"),
    import("../../packages/server/src/services/features/feature-settings.js"),
  ]);
  const db = await createFileNativeDB();
  const Fastify = createRequire(new URL("../../packages/server/package.json", import.meta.url))("fastify");
  const server = Fastify();
  server.decorate("db", db);
  await server.register(lorebooksRoutes, { prefix: "/api/lorebooks" });
  app = server;
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await app!.inject({ method, url, payload });
    assert.ok(response.statusCode < 400, `${method} ${url} -> ${response.statusCode}`);
    return response.body ? response.json() : null;
  };

  const book = await request("POST", "/api/lorebooks", { name: "Stats World" });
  const entry = (name: string, extra: Record<string, unknown>) =>
    request("POST", `/api/lorebooks/${book.id}/entries`, { lorebookId: book.id, name, ...extra });
  const city = await entry("Valdenmoor", { keys: ["Valdenmoor"], content: "The capital." });
  const queen = await entry("Queen Sybel", { keys: ["Sybel"], content: "A monarch." });

  // ── Activation statistics ──
  const statsUrl = `/api/lorebooks/${book.id}/activation-stats`;
  featureSettings.resetFeatureSettingsForTests();
  assert.deepEqual(await request("GET", statsUrl), [], "nothing has fired yet");
  stats.recordLorebookActivations(db, { entryIds: [city.id] });
  await stats.flushLorebookActivationStats(db);
  assert.deepEqual(await request("GET", statsUrl), [], "activation collection is off by default");
  featureSettings.resetFeatureSettingsForTests({ usageAndActivationStats: true });

  stats.recordLorebookActivations(db, {
    entryIds: [city.id, queen.id],
    chatId: "chat-1",
    at: "2026-09-01T00:00:00.000Z",
  });
  stats.recordLorebookActivations(db, {
    entryIds: [city.id, city.id],
    chatId: "chat-2",
    at: "2026-09-02T00:00:00.000Z",
  });
  stats.recordLorebookActivations(db, { entryIds: ["deleted-entry"], chatId: "chat-2" });
  stats.recordLorebookActivations(db, { entryIds: [] });
  await stats.flushLorebookActivationStats(db);

  let rows = (await request("GET", statsUrl)) as Array<Record<string, unknown>>;
  const cityStat = rows.find((row) => row.entryId === city.id);
  assert.equal(cityStat?.count, 2, "one count per generation, duplicates in one generation collapse");
  assert.equal(cityStat?.lastActivatedAt, "2026-09-02T00:00:00.000Z");
  assert.equal(cityStat?.lastChatId, "chat-2");
  assert.equal(cityStat?.lorebookId, book.id);
  assert.equal(rows.find((row) => row.entryId === queen.id)?.count, 1);
  assert.equal(rows.length, 2, "unknown entry ids are ignored");

  // A second batch updates in place.
  stats.recordLorebookActivations(db, { entryIds: [queen.id], chatId: "chat-3" });
  await stats.flushLorebookActivationStats(db);
  rows = await request("GET", statsUrl);
  assert.equal(rows.find((row) => row.entryId === queen.id)?.count, 2);

  // Turning the switch off drops pending counts and hides saved stats without deleting them.
  stats.recordLorebookActivations(db, { entryIds: [city.id], chatId: "chat-off" });
  featureSettings.resetFeatureSettingsForTests({ usageAndActivationStats: false });
  await stats.flushLorebookActivationStats(db);
  assert.deepEqual(await request("GET", statsUrl), [], "off hides previously saved activation stats");
  featureSettings.resetFeatureSettingsForTests({ usageAndActivationStats: true });
  rows = await request("GET", statsUrl);
  assert.equal(
    rows.find((row) => row.entryId === city.id)?.count,
    2,
    "off dropped pending data without deleting saved counts",
  );

  // Deleting an entry removes its stats row.
  await request("DELETE", `/api/lorebooks/${book.id}/entries/${queen.id}`);
  assert.deepEqual(await stats.listLorebookActivationStats(db, [queen.id]), []);

  // The generation path reports the entries it persisted with the message.
  const generateSource = readFileSync(
    new URL("../../packages/server/src/routes/generate.routes.ts", import.meta.url),
    "utf8",
  );
  const persistenceIndexes = [
    generateSource.indexOf("const committed = await chats.commitRoleplayInterruption({"),
    generateSource.indexOf("? await chats.updateMessageExtraForSwipe(savedMsg.id, savedSwipeIndex, extraUpdate)"),
    generateSource.indexOf(": await chats.updateMessageExtra(savedMsg.id, extraUpdate);"),
  ];
  const activationIndex = generateSource.indexOf("recordLorebookActivations(app.db, {");
  assert.ok(
    persistenceIndexes.every((index) => index >= 0 && activationIndex > index),
    "activation stats are recorded only after each message-persistence branch succeeds",
  );
  const activationGuardIndex = generateSource.lastIndexOf("if (!input.continueMessageId) {", activationIndex);
  assert.ok(
    activationGuardIndex >= 0 &&
      generateSource.slice(activationGuardIndex, activationIndex).trim() === "if (!input.continueMessageId) {",
    "Continue chunks do not increment activation stats",
  );
  const appSource = readFileSync(new URL("../../packages/server/src/app.ts", import.meta.url), "utf8");
  const closeHook = appSource.slice(appSource.indexOf('app.addHook("onClose"'));
  assert.ok(
    closeHook.indexOf("lorebookActivationStats") > 0 &&
      closeHook.indexOf("lorebookActivationStats") < closeHook.indexOf("await closeDB()"),
    "shutdown flushes activation stats before closing the database",
  );

  // Failures never escape: a broken database only logs.
  const brokenDb = {
    transaction: async () => {
      throw new Error("disk on fire");
    },
  } as unknown as typeof db;
  assert.doesNotThrow(() => stats.recordLorebookActivations(brokenDb, { entryIds: [city.id] }));
  await stats.flushLorebookActivationStats(brokenDb);
  assert.doesNotThrow(() =>
    stats.recordLorebookActivations(null as unknown as typeof db, { entryIds: null as unknown as string[] }),
  );
} finally {
  await app?.close();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dataDir, { recursive: true, force: true });
}

console.log("lorebook-activation-stats regression passed");
