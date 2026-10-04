// #7055: an Individual-mode Conversation group shares one daily check-in limit
// (#3887), but each character's first check-in waited only on the user's
// silence. Once the user went quiet, every character was due at once and the
// polls spent the whole day's limit within minutes, leaving the chat silent
// until the next day. Drives the real /autonomous/check route and pins:
//   - one quiet stretch produces one check-in, not a burst to the limit,
//   - the next quiet stretch still checks in, from another character,
//   - a long-absence check-in is not repeated by every character,
//   - Grouped mode, which counts each character separately, is unchanged.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "marinara-autonomous-cadence-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { conversationRoutes } = await import("../../packages/server/src/routes/conversation.routes.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { buildIntentCooldownPatch } = await import("../../packages/server/src/services/conversation/intent.service.js");
const { buildAutonomousDailyBudgetPatch, getAutonomousDailyBudget, recordAssistantActivity, recordUserActivity } =
  await import("../../packages/server/src/services/conversation/autonomous.service.js");
const { characterDataSchema } = await import("../../packages/shared/dist/index.js");

const HOUR = 60 * 60 * 1000;
const db = await getDB();
const chats = createChatsStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(conversationRoutes);

type CheckResult = { shouldTrigger: boolean; characterIds: string[]; reason: string; autonomousIntentKey?: string };

try {
  const cast: string[] = [];
  for (let index = 0; index < 12; index++) {
    const character = await createCharactersStorage(db).create(characterDataSchema.parse({ name: `Friend ${index}` }));
    cast.push(character!.id);
  }

  const createChat = async (groupChatMode: "individual" | "merged") => {
    const chat = await chats.create({ name: groupChatMode, mode: "conversation", characterIds: cast });
    await chats.patchMetadata(chat!.id, {
      autonomousMessages: true,
      conversationSchedulesEnabled: false,
      groupChatMode,
    });
    return chat!.id;
  };
  const check = async (chatId: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/autonomous/check",
      payload: { chatId, userStatus: "idle" },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as CheckResult;
  };
  // What the generate route records once the check-in is saved.
  const saveCheckIn = async (chatId: string, result: CheckResult) => {
    const characterId = result.characterIds[0]!;
    recordAssistantActivity(chatId, characterId);
    await chats.patchMetadata(chatId, (meta) => ({
      ...buildAutonomousDailyBudgetPatch(meta, characterId),
      ...(result.autonomousIntentKey === "long_absence_check_in"
        ? buildIntentCooldownPatch(meta, characterId, "long_absence_check_in")
        : {}),
    }));
  };
  // One poll per tick, like the 30 s client and 60 s server pollers.
  const pollQuietStretch = async (chatId: string, polls: number) => {
    const speakers: string[] = [];
    let last: CheckResult | null = null;
    for (let poll = 0; poll < polls; poll++) {
      last = await check(chatId);
      if (!last.shouldTrigger) continue;
      speakers.push(last.characterIds[0]!);
      await saveCheckIn(chatId, last);
    }
    return { speakers, last: last! };
  };
  const usedToday = async (chatId: string) => {
    const meta = (await chats.getById(chatId))!.metadata as unknown;
    const counts = getAutonomousDailyBudget(typeof meta === "string" ? JSON.parse(meta) : (meta ?? {})).counts;
    return Object.values(counts).reduce((total, count) => total + count, 0);
  };

  {
    const chatId = await createChat("individual");
    recordUserActivity(chatId, { occurredAt: Date.now() - 4 * HOUR });
    const first = await pollQuietStretch(chatId, 12);
    assert.equal(
      first.speakers.length,
      1,
      `one quiet stretch should bring one check-in, not spend the shared limit (got ${first.speakers.length})`,
    );
    assert.equal(first.last.reason, "none", "the next check-in waits for the chat's follow-up time");
    assert.equal(await usedToday(chatId), 1, "the rest of the day's limit is still available");

    recordUserActivity(chatId, { occurredAt: Date.now() - 4 * HOUR });
    const second = await pollQuietStretch(chatId, 3);
    assert.equal(second.speakers.length, 1, "the next quiet stretch still brings a check-in");
    assert.notEqual(second.speakers[0], first.speakers[0], "the shared limit rotates between characters");
  }

  {
    const chatId = await createChat("individual");
    recordUserActivity(chatId, { occurredAt: Date.now() - 20 * HOUR });
    recordAssistantActivity(chatId);
    const away = await pollQuietStretch(chatId, 6);
    assert.equal(away.speakers.length, 1, "a long absence brings one check-in, not one per character");
    assert.equal(await usedToday(chatId), 1);
  }

  {
    const chatId = await createChat("merged");
    recordUserActivity(chatId, { occurredAt: Date.now() - 4 * HOUR });
    const grouped = await pollQuietStretch(chatId, 2);
    assert.equal(grouped.speakers.length, 2, "Grouped mode keeps each character's own check-in rhythm");
    assert.notEqual(grouped.speakers[0], grouped.speakers[1]);
  }
} finally {
  await app.close();
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}
process.stdout.write("Individual group autonomous cadence regressions passed.\n");
