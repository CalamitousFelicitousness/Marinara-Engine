// Chat variables share their store with {{setvar}}, which a running generation
// writes back mid-request. The metadata route must therefore merge rather than
// replace, and must express a removal explicitly.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousDataDir = process.env.DATA_DIR;
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "marinara-chat-variables-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { normalizeChatMacroVariables } = await import("../../packages/server/src/services/prompt/macro-context.js");

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await app.register(chatsRoutes, { prefix: "/api/chats" });

try {
  const chats = createChatsStorage(db);
  const chat = await chats.create({
    name: "Variables",
    mode: "roleplay",
    characterIds: [],
    personaId: null,
    promptPresetId: null,
    connectionId: null,
    groupId: null,
  });
  assert.ok(chat);

  const patchVariables = (macroVariables: Record<string, string | null>) =>
    app.inject({ method: "PATCH", url: `/api/chats/${chat.id}/metadata`, payload: { macroVariables } });
  const storedVariables = async () => {
    const current = await chats.getById(chat.id);
    const metadata = typeof current!.metadata === "string" ? JSON.parse(current!.metadata) : (current!.metadata ?? {});
    return normalizeChatMacroVariables(metadata.macroVariables);
  };

  // A patch adds names without disturbing the ones it does not mention.
  assert.equal((await patchVariables({ char1: "Mary" })).statusCode, 200);
  assert.equal((await patchVariables({ char2: "Ana" })).statusCode, 200);
  assert.deepEqual(await storedVariables(), { char1: "Mary", char2: "Ana" });

  // Editing one value leaves the rest alone.
  assert.equal((await patchVariables({ char1: "Anna" })).statusCode, 200);
  assert.deepEqual(await storedVariables(), { char1: "Anna", char2: "Ana" });

  // null removes a name.
  assert.equal((await patchVariables({ char2: null })).statusCode, 200);
  assert.deepEqual(await storedVariables(), { char1: "Anna" });

  // A rename travels as one patch so it cannot half-apply.
  assert.equal((await patchVariables({ char1: null, lead: "Anna" })).statusCode, 200);
  assert.deepEqual(await storedVariables(), { lead: "Anna" });

  // A generation's {{setvar}} write lands in the same key. The next UI patch
  // must not drop it.
  await chats.patchMetadata(
    chat.id,
    (current) => ({
      ...current,
      macroVariables: { ...normalizeChatMacroVariables(current.macroVariables), mood: "tense" },
    }),
    { touchUpdatedAt: false },
  );
  assert.equal((await patchVariables({ lead: "Mary" })).statusCode, 200);
  assert.deepEqual(await storedVariables(), { lead: "Mary", mood: "tense" });

  // A name a {{setvar}} created keeps its own shape: still editable and
  // removable even though the UI could not have created it.
  await chats.patchMetadata(
    chat.id,
    (current) => ({
      ...current,
      macroVariables: { ...normalizeChatMacroVariables(current.macroVariables), "story.day": "3" },
    }),
    { touchUpdatedAt: false },
  );
  assert.equal((await patchVariables({ "story.day": "4" })).statusCode, 200);
  assert.equal((await storedVariables())["story.day"], "4");
  assert.equal((await patchVariables({ "story.day": null })).statusCode, 200);
  assert.ok(!("story.day" in (await storedVariables())));

  // …but a new name of that shape is refused, because a bare {{story.day}}
  // would never resolve.
  assert.equal((await patchVariables({ "story.day": "5" })).statusCode, 400);
  assert.equal((await patchVariables({ char: "Nope" })).statusCode, 400, "built-in macro name");
  assert.equal((await patchVariables({ "bad name": "x" })).statusCode, 400, "space is not storable");
  assert.equal(
    (await patchVariables({ ["constructor"]: "x" })).statusCode,
    400,
    "object members are not variable names",
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/chats/${chat.id}/metadata`,
        payload: { macroVariables: { char1: "Mary" }, summaryTailMessages: 3 },
      })
    ).statusCode,
    400,
    "a combined patch would skip the other keys' handling",
  );
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/api/chats/${chat.id}/metadata`,
        payload: { macroVariables: { char1: 7 } },
      })
    ).statusCode,
    400,
    "values must be strings or null",
  );
  assert.deepEqual(await storedVariables(), { lead: "Mary", mood: "tense" }, "a rejected patch changes nothing");

  // The storage gate stays permissive so existing setvar values survive.
  assert.deepEqual(normalizeChatMacroVariables({ "my.var": "kept", "bad name": "dropped", n: 1 }), {
    "my.var": "kept",
  });

  console.info("chat variables persistence regressions passed.");
} finally {
  await app.close();
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
}
