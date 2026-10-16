import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-chat-window-layout-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
process.env.DISABLE_REQUEST_LOGGING = "true";
process.env.AUTO_CREATE_DEFAULT_CONNECTION = "false";

type TestApp = {
  close(): Promise<void>;
  inject(options: Record<string, unknown>): Promise<{ statusCode: number; json(): any; body: string }>;
  ready(): Promise<void>;
};
let app: TestApp | null = null;
let closeDatabase: (() => Promise<void>) | undefined;
try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  const { closeDB, getDB } = await import("../../packages/server/src/db/connection.js");
  closeDatabase = closeDB;
  const { chats } = await import("../../packages/server/src/db/schema/index.js");
  const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");

  app = (await buildApp()) as unknown as TestApp;
  await app.ready();
  const db = await getDB();
  const storage = createChatsStorage(db);

  const layout = { version: 1, windows: {}, bubbles: { "control:session": { x: 40, y: 60 } } };
  const ownLayout = { version: 1, windows: {}, bubbles: { "control:session": { x: 400, y: 300 } } };

  // The shared layout keys hold a layout snapshot or null, nothing else.
  const sharedUrl = "/api/app-settings/chat-window-shared-roleplay";
  const saved = await app.inject({ method: "PUT", url: sharedUrl, payload: { value: JSON.stringify(layout) } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(JSON.parse((await app.inject({ method: "GET", url: sharedUrl })).json().value), layout);
  for (const value of ['{"version":2,"windows":{}}', "[]", "not json"]) {
    const rejected = await app.inject({ method: "PUT", url: sharedUrl, payload: { value } });
    assert.equal(rejected.statusCode, 400, value);
  }
  assert.equal((await app.inject({ method: "PUT", url: sharedUrl, payload: { value: "null" } })).statusCode, 200);
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/app-settings/chat-window-shared-solo" })).statusCode,
    404,
    "only the three chat modes have a shared layout",
  );

  // Applying a layout writes it into every chat of that mode except Professor Mari's and multiplayer ones.
  const timestamp = "2026-10-01T00:00:00.000Z";
  const seed = async (id: string, mode: string, metadata: Record<string, unknown>) =>
    db.insert(chats).values({
      id,
      name: id,
      mode,
      characterIds: "[]",
      metadata: JSON.stringify({ windowLayout: ownLayout, ...metadata }),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  await seed("roleplay-a", "roleplay", {});
  await seed("roleplay-b", "roleplay", { windowLayout: null });
  await seed("conversation-c", "conversation", {});
  await seed("roleplay-multiplayer", "roleplay", { multiplayer: { role: "host" } });
  await seed("roleplay-mari", "roleplay", { internalAssistant: "professor-mari" });

  const applied = await app.inject({
    method: "POST",
    url: "/api/chats/window-layout/apply",
    payload: { mode: "roleplay", windowLayout: layout },
  });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.deepEqual(applied.json(), { updated: 2 });
  const layoutOf = async (id: string) => JSON.parse((await storage.getById(id))!.metadata).windowLayout;
  assert.deepEqual(await layoutOf("roleplay-a"), layout);
  assert.deepEqual(await layoutOf("roleplay-b"), layout);
  assert.deepEqual(await layoutOf("conversation-c"), ownLayout, "another mode keeps its layout");
  assert.deepEqual(await layoutOf("roleplay-multiplayer"), ownLayout, "multiplayer keeps its layout");
  assert.deepEqual(await layoutOf("roleplay-mari"), ownLayout, "Professor Mari's chat keeps its layout");
  assert.equal((await storage.getById("roleplay-a"))!.updatedAt, timestamp, "a layout is not chat activity");

  for (const payload of [
    { mode: "solo", windowLayout: layout },
    { mode: "roleplay", windowLayout: { version: 1 } },
    { mode: "roleplay" },
  ]) {
    const rejected = await app.inject({ method: "POST", url: "/api/chats/window-layout/apply", payload });
    assert.equal(rejected.statusCode, 400, JSON.stringify(payload));
  }
  const cleared = await app.inject({
    method: "POST",
    url: "/api/chats/window-layout/apply",
    payload: { mode: "conversation", windowLayout: null },
  });
  assert.deepEqual(cleared.json(), { updated: 1 });
  assert.equal(await layoutOf("conversation-c"), null, "null resets every chat of the mode to the standard layout");
} finally {
  await app?.close();
  await closeDatabase?.();
  rmSync(dataDir, { recursive: true, force: true });
}

process.stdout.write("Chat window shared layout regression passed.\n");
