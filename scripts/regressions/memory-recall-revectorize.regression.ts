import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "../../packages/server/src/db/file-query.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { chats, memoryChunks, messages } from "../../packages/server/src/db/schema/index.js";
import { chunkAndEmbedMessages, rebuildMemoryChunks } from "../../packages/server/src/services/memory-recall.js";

const dir = mkdtempSync(join(tmpdir(), "marinara-memory-revectorize-"));
process.env.FILE_STORAGE_DIR = dir;
const db = await createFileNativeDB();

try {
  await db.insert(chats).values({ id: "chat-memory", name: "Memory", mode: "conversation" });
  for (let index = 0; index < 5; index += 1) {
    await db.insert(messages).values({
      id: `message-${index}`,
      chatId: "chat-memory",
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Memory turn ${index}`,
      createdAt: `2026-08-10T10:00:0${index}.000Z`,
    });
  }

  let releaseOldEmbedding!: () => void;
  const oldEmbeddingReleased = new Promise<void>((resolve) => {
    releaseOldEmbedding = resolve;
  });
  let notifyOldEmbeddingStarted!: () => void;
  const oldEmbeddingStarted = new Promise<void>((resolve) => {
    notifyOldEmbeddingStarted = resolve;
  });
  let newEmbeddingStarted = false;

  const backgroundChunk = chunkAndEmbedMessages(
    db,
    "chat-memory",
    { userName: "User", characterNames: {} },
    {
      embeddingSource: {
        label: "old-384",
        async embed(texts) {
          notifyOldEmbeddingStarted();
          await oldEmbeddingReleased;
          return texts.map(() => Array.from({ length: 384 }, () => 0.25));
        },
      },
    },
  );
  await oldEmbeddingStarted;

  const rebuild = rebuildMemoryChunks(
    db,
    "chat-memory",
    { userName: "User", characterNames: {} },
    {
      embeddingSource: {
        label: "new-768",
        async embed(texts) {
          newEmbeddingStarted = true;
          return texts.map(() => Array.from({ length: 768 }, () => 0.5));
        },
      },
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(newEmbeddingStarted, false, "re-vectorization waits for in-flight background chunking on the same chat");
  releaseOldEmbedding();
  await Promise.all([backgroundChunk, rebuild]);

  const stored = await db.select().from(memoryChunks).where(eq(memoryChunks.chatId, "chat-memory"));
  assert.equal(stored.length, 1, "re-vectorization replaces the prior native chunk exactly once");
  assert.equal(JSON.parse(stored[0]!.embedding ?? "[]").length, 768, "only vectors from the new model remain");
} finally {
  await db._fileStore.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log("Memory Recall re-vectorization regression checks passed.");
