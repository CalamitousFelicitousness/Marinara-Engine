// A summary written by hand with Summary Scope set to Range keeps and applies that range, like Generate (#7410).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-summary-write-range-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { isMessageHiddenFromAI } = await import("../../packages/server/src/routes/generate/generate-route-utils.js");
const db = await getDB();
const chats = createChatsStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(chatsRoutes, { prefix: "/api/chats" });

const provider = createServer((request, response) => {
  request.resume();
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: '{"summary":"Generated summary.","title":"Generated"}' },
          finish_reason: "stop",
        },
      ],
    }),
  );
});

type Entry = {
  id: string;
  sourceMode?: string;
  rangeStartIndex?: number;
  rangeEndIndex?: number;
  messageCount?: number;
  messageIds?: string[];
  hiddenMessageIds?: string[];
  content: string;
};

try {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert(address && typeof address === "object");
  const connection = await createConnectionsStorage(db).create({
    name: "Summary fixture",
    provider: "custom",
    model: "fixture",
    apiKey: "fixture",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    maxContext: 32768,
  });
  assert(connection);

  const createChat = async () => {
    const chat = await chats.create({
      name: "Range summary",
      mode: "roleplay",
      characterIds: [],
      connectionId: connection.id,
    });
    assert(chat);
    await chats.patchMetadata(chat.id, {
      automaticSummaryEnabled: false,
      hideSummarisedMessages: true,
      summaryTailMessages: 2,
    });
    const ids: string[] = [];
    for (let turn = 1; turn <= 6; turn++) {
      const message = await chats.createMessage({
        chatId: chat.id,
        role: turn % 2 ? "user" : "assistant",
        characterId: null,
        content: `Turn ${turn}.`,
      });
      assert(message);
      ids.push(message.id);
    }
    return { chatId: chat.id, ids };
  };
  const entries = async (chatId: string) => {
    const chat = await chats.getById(chatId);
    assert(chat);
    const metadata = typeof chat.metadata === "string" ? JSON.parse(chat.metadata) : chat.metadata;
    return (metadata.summaryEntries ?? []) as Entry[];
  };
  const hiddenIds = async (chatId: string) =>
    (await chats.listMessages(chatId)).filter((message) => isMessageHiddenFromAI(message)).map((message) => message.id);
  const write = (chatId: string, entry: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: `/api/chats/${chatId}/summary-entries`,
      payload: { operation: "replace", entry },
    });
  // The draft the Write button saves while Summary Scope is Range.
  const manualDraft = (id: string, rangeStartIndex: number, rangeEndIndex: number) => ({
    id,
    kind: "rolling",
    origin: "manual",
    title: "Manual summary",
    content: "Manual summary test",
    enabled: true,
    sourceMode: "range",
    rangeStartIndex,
    rangeEndIndex,
    tokenEstimate: 4,
    createdAt: "2026-10-11T10:00:00.000Z",
    updatedAt: "2026-10-11T10:00:00.000Z",
  });
  const coverage = (entry: Entry, ids: string[]) => ({
    sourceMode: entry.sourceMode,
    rangeStartIndex: entry.rangeStartIndex,
    rangeEndIndex: entry.rangeEndIndex,
    messageCount: entry.messageCount,
    messages: entry.messageIds?.map((id) => ids.indexOf(id) + 1),
    hidden: entry.hiddenMessageIds?.map((id) => ids.indexOf(id) + 1),
  });

  // Generate with the range 1-3 is the behavior Write must match.
  const generated = await createChat();
  const generateResponse = await app.inject({
    method: "POST",
    url: `/api/chats/${generated.chatId}/generate-summary`,
    payload: { rangeStartIndex: 1, rangeEndIndex: 3 },
  });
  assert.equal(generateResponse.statusCode, 200, generateResponse.body);
  const [generatedEntry] = await entries(generated.chatId);
  assert(generatedEntry);
  const expected = {
    sourceMode: "range",
    rangeStartIndex: 1,
    rangeEndIndex: 3,
    messageCount: 3,
    messages: [1, 2, 3],
    hidden: [1, 2, 3],
  };
  assert.deepEqual(coverage(generatedEntry, generated.ids), expected, "Generate keeps and applies the range");

  const written = await createChat();
  const writeResponse = await write(written.chatId, manualDraft("manual-range", 1, 3));
  assert.equal(writeResponse.statusCode, 200, writeResponse.body);
  const [writtenEntry] = await entries(written.chatId);
  assert(writtenEntry);
  assert.equal(writtenEntry.id, "manual-range");
  assert.equal(writtenEntry.content, "Manual summary test");
  assert.deepEqual(coverage(writtenEntry, written.ids), expected, "Write keeps and applies the range like Generate");
  assert.deepEqual(await hiddenIds(written.chatId), written.ids.slice(0, 3), "Write hides the summarized messages");

  // The protected tail stays visible, exactly as it does for Generate.
  const tailResponse = await write(written.chatId, manualDraft("manual-tail", 4, 6));
  assert.equal(tailResponse.statusCode, 200, tailResponse.body);
  const tailEntry = (await entries(written.chatId)).find((entry) => entry.id === "manual-tail");
  assert(tailEntry);
  assert.deepEqual(coverage(tailEntry, written.ids), {
    sourceMode: "range",
    rangeStartIndex: 4,
    rangeEndIndex: 6,
    messageCount: 3,
    messages: [4, 5, 6],
    hidden: [4],
  });
  assert.deepEqual(await hiddenIds(written.chatId), written.ids.slice(0, 4));

  // Editing the saved entry later changes its text but keeps what it covers.
  const editResponse = await write(written.chatId, { id: "manual-range", title: "Edited", content: "Edited text" });
  assert.equal(editResponse.statusCode, 200, editResponse.body);
  const editedEntry = (await entries(written.chatId)).find((entry) => entry.id === "manual-range");
  assert(editedEntry);
  assert.equal(editedEntry.content, "Edited text");
  assert.deepEqual(coverage(editedEntry, written.ids), expected);
  assert.deepEqual(await hiddenIds(written.chatId), written.ids.slice(0, 4));

  // A range Generate would refuse is refused for Write too, and nothing is saved.
  for (const [start, end, error] of [
    [1, 3, "No non-hidden messages available for the requested summary range"],
    [5, 9, "Summary range is outside this chat's message history"],
  ] as const) {
    const generateRefusal = await app.inject({
      method: "POST",
      url: `/api/chats/${written.chatId}/generate-summary`,
      payload: { rangeStartIndex: start, rangeEndIndex: end },
    });
    assert.equal(generateRefusal.statusCode, 400, generateRefusal.body);
    assert.equal(generateRefusal.json().error, error);
    const writeRefusal = await write(written.chatId, manualDraft(`refused-${start}`, start, end));
    assert.equal(writeRefusal.statusCode, 400, writeRefusal.body);
    assert.equal(writeRefusal.json().error, error);
  }
  assert.deepEqual(
    (await entries(written.chatId)).map((entry) => entry.id),
    ["manual-range", "manual-tail"],
  );
} finally {
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await app.close();
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}

console.info("Summary Write range regression passed.");
