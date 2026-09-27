/**
 * The Game Master's `[inventory:]` tags through a real turn: the generate route applies them when it
 * saves the reply, rewrites each one with what happened, saves the stacks and the journal, and tells
 * the client the chat's inventory changed. Nothing in the browser applies them any more, so a reply
 * that finished while nobody was reading it still changes the inventory.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ChatOptions, LLMUsage } from "../../packages/server/src/services/llm/base-provider.js";

const dir = mkdtempSync(join(tmpdir(), "marinara-inventory-turn-"));
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { createGameStateStorage } = await import("../../packages/server/src/services/storage/game-state.storage.js");
const { gameInventoryRoutes } = await import("../../packages/server/src/routes/game-inventory.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { normalizeGameInventoryStacks, gameInventoryCount, readResolvedInventoryTags } =
  await import("../../packages/shared/src/index.js");
const { ClaudeSubscriptionProvider } =
  await import("../../packages/server/src/services/llm/providers/claude-subscription.provider.js");

const prompts: ChatMessage[][] = [];
let reply = "";
async function* scriptedChat(messages: ChatMessage[], _options: ChatOptions): AsyncGenerator<string, LLMUsage> {
  prompts.push(structuredClone(messages));
  yield reply;
  return { promptTokens: 10, completionTokens: 5, totalTokens: 15, finishReason: "stop" };
}
const originalChat = ClaudeSubscriptionProvider.prototype.chat;
ClaudeSubscriptionProvider.prototype.chat = scriptedChat;

const db = await getDB();
const chats = createChatsStorage(db);
const app = Fastify();
app.decorate("db", db);
await app.register(generateRoutes, { prefix: "/api/generate" });
await app.register(chatsRoutes, { prefix: "/api/chats" });
await app.register(gameInventoryRoutes, { prefix: "/api/game/inventory" });
try {
  const connection = await createConnectionsStorage(db).create({
    name: "Inventory fixture",
    provider: "claude_subscription",
    model: "fixture",
    apiKey: "synthetic-fixture",
    maxContext: 32768,
  });
  const chat = await chats.create({
    name: "Inventory turn",
    mode: "game",
    characterIds: [],
    connectionId: connection.id,
    promptPresetId: null,
  });
  assert.ok(chat);
  await chats.patchMetadata(chat.id, {
    enableAgents: false,
    enableTools: false,
    // Bram left the party but still carries the arrows, so the Game Master can still name him.
    gameInventory: [
      { id: "st-rope", name: "Rope", quantity: 1 },
      { id: "st-arrows", name: "Arrow", quantity: 10, holder: "Bram" },
    ],
  });
  const readInventory = async () => {
    const row = await chats.getById(chat.id);
    const meta = typeof row!.metadata === "string" ? JSON.parse(row!.metadata) : row!.metadata;
    return { stacks: normalizeGameInventoryStacks(meta.gameInventory), journal: meta.gameJournal };
  };
  const turn = async (text: string, payload: Record<string, unknown> = {}) => {
    reply = text;
    await chats.createMessage({ chatId: chat.id, role: "user", content: "I look around." });
    const response = await app.inject({
      method: "POST",
      url: "/api/generate/",
      payload: { chatId: chat.id, streaming: true, ...payload },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(!response.body.includes('"type":"error"'), response.body);
    return { response, saved: (await chats.listMessages(chat.id)).at(-1)! };
  };

  // The prompt shows who carries what, since Bram carries something.
  const first = await turn(
    [
      `You find a lantern. [inventory: action="add" item="Lantern"]`,
      `Bram hands over two arrows. [inventory: action="give" item="Arrow" count="2" who="Bram" to="User"]`,
      `The rope snaps. [inventory: action="remove" item="Rope" result="ok"]`,
      `[inventory: action="remove" item="Crown"]`,
    ].join("\n"),
  );
  assert.match(
    prompts
      .at(-1)!
      .map((message) => message.content)
      .join("\n"),
    /PARTY INVENTORY:\n- User: Rope\n- Bram: Arrow ×10/,
  );
  const resolved = readResolvedInventoryTags(first.saved.content);
  assert.deepEqual(
    resolved.map((tag) => `${tag.action} ${tag.item} ${tag.ok ? `ok ${tag.count}->${tag.now}` : tag.reason}`),
    ["add Lantern ok 1->1", "give Arrow ok 2->2", "remove Rope ok 1->0", "remove Crown none-held"],
    "every tag is answered in the saved reply, a forged result included",
  );
  const after = await readInventory();
  assert.equal(gameInventoryCount(after.stacks, "Lantern", {}), 1);
  assert.equal(gameInventoryCount(after.stacks, "Arrow", {}), 2);
  assert.equal(gameInventoryCount(after.stacks, "Arrow", { holder: "Bram" }), 8);
  assert.equal(gameInventoryCount(after.stacks, "Rope"), 0);
  assert.deepEqual(
    (after.journal?.inventoryLog ?? []).map(
      (entry: { item: string; action: string }) => `${entry.action} ${entry.item}`,
    ),
    ["acquired Lantern", "lost Rope"],
  );
  assert.match(first.response.body, /"type":"metadata_patch","data":\{"gameInventory":/, "the client is told");

  // The next turn's prompt carries the answered tags, so the Game Master reads its own refusal.
  const second = await turn(`Nothing else happens.`);
  assert.match(
    prompts
      .at(-1)!
      .map((message) => message.content)
      .join("\n"),
    /item="Crown" count="1" result="refused" reason="none-held"/,
  );
  assert.doesNotMatch(second.response.body, /"type":"metadata_patch","data":\{"gameInventory":/);
  assert.equal(normalizeGameInventoryStacks((await readInventory()).stacks).length, after.stacks.length);

  // An impersonated turn is the player writing: nothing in it is applied.
  reply = `I take the crown. [inventory: action="add" item="Crown"]`;
  const impersonated = await app.inject({
    method: "POST",
    url: "/api/generate/",
    payload: { chatId: chat.id, streaming: true, impersonate: true },
  });
  assert.equal(impersonated.statusCode, 200, impersonated.body);
  assert.equal(gameInventoryCount((await readInventory()).stacks, "Crown"), 0);

  // ── Tellings of one turn never add up (#6774) ──
  {
    const swords = async () => gameInventoryCount((await readInventory()).stacks, "Sword");
    const maps = async () => gameInventoryCount((await readInventory()).stacks, "Map");
    const sword = `A blade in the grass. [inventory: action="add" item="Sword"]`;
    // The turn before carries a detailed inventory, so every telling's own row gets one too.
    const states = createGameStateStorage(db);
    const previous = (await chats.listMessages(chat.id)).filter((message) => message.role === "assistant").at(-1)!;
    await states.create({
      chatId: chat.id,
      messageId: previous.id,
      swipeIndex: previous.activeSwipeIndex ?? 0,
      date: null,
      time: null,
      location: null,
      weather: null,
      temperature: null,
      presentCharacters: [],
      recentEvents: [],
      playerStats: {
        stats: [],
        attributes: null,
        skills: {},
        inventory: [{ name: "Lantern", description: "", quantity: 1, location: "on_person" }],
        activeQuests: [],
        status: "",
      } as never,
      personaStats: null,
    });
    const rowSwords = async (swipe: number) => {
      const row = await states.getByChatAndMessage(chat.id, told.saved.id, swipe);
      const stats = row?.playerStats ? JSON.parse(row.playerStats as string) : null;
      return (stats?.inventory ?? [])
        .filter((item: { name: string }) => item.name === "Sword")
        .reduce((total: number, item: { quantity: number }) => total + item.quantity, 0);
    };
    const told = await turn(sword);
    assert.equal(await swords(), 1);
    assert.equal(await rowSwords(0), 1, "the turn's own row has the sword");
    const regenerate = async (text: string) => {
      reply = text;
      const response = await app.inject({
        method: "POST",
        url: "/api/generate/",
        payload: { chatId: chat.id, streaming: true, regenerateMessageId: told.saved.id },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(!response.body.includes('"type":"error"'), response.body);
    };
    const showSwipe = async (index: number) => {
      const response = await app.inject({
        method: "PUT",
        url: `/api/chats/${chat.id}/messages/${told.saved.id}/active-swipe`,
        payload: { index },
      });
      assert.equal(response.statusCode, 200, response.body);
    };

    await regenerate(sword);
    assert.equal(await swords(), 1, "the second telling starts where the turn began, not where the first left it");
    // And the Game Master is shown the inventory it starts from, without the first telling's sword.
    const shown = prompts
      .at(-1)!
      .map((message) => message.content)
      .join("\n");
    const inventoryBlock = shown.slice(shown.search(/(PARTY|PLAYER) INVENTORY/));
    assert.match(inventoryBlock, /(PARTY|PLAYER) INVENTORY/);
    assert.doesNotMatch(inventoryBlock.split("\n\n")[0]!, /Sword/);
    assert.equal(await rowSwords(1), 1, "and so does its row, not built on the first telling's");
    await regenerate(`The grass is empty.`);
    assert.equal(await swords(), 0, "a telling with no tags leaves the turn as it began");
    assert.equal(await rowSwords(2), 0);
    // Its row carries the turn's beginning too, rather than being left to whatever it was cloned from.
    const telling2 = await states.getByChatAndMessage(chat.id, told.saved.id, 2);
    assert.deepEqual(
      JSON.parse(telling2!.playerStats as string).inventory.map((item: { name: string }) => item.name),
      ["Lantern"],
    );

    await showSwipe(0);
    assert.equal(await swords(), 1, "swiping back shows what the first telling left");
    await showSwipe(2);
    assert.equal(await swords(), 0);
    await showSwipe(1);
    assert.equal(await swords(), 1);

    // Once the player changes the inventory, nothing they did is thrown away.
    const added = await app.inject({
      method: "POST",
      url: "/api/game/inventory",
      payload: { chatId: chat.id, ops: [{ op: "add", name: "Map", count: 1 }] },
    });
    assert.equal(added.statusCode, 200, added.body);
    await showSwipe(2);
    assert.equal(await swords(), 1, "the sword stays: the stacks are no longer what that telling left");
    assert.equal(await maps(), 1);
    await regenerate(sword);
    assert.equal(await swords(), 2, "and a new telling adds on top of the player's change");
    assert.equal(await maps(), 1);

    // A continuation adds to its own telling, and its row keeps what the first part already wrote.
    reply = `A torch, too. [inventory: action="add" item="Torch"]`;
    const continued = await app.inject({
      method: "POST",
      url: "/api/generate/",
      payload: { chatId: chat.id, streaming: true, continueMessageId: told.saved.id },
    });
    assert.equal(continued.statusCode, 200, continued.body);
    assert.ok(!continued.body.includes('"type":"error"'), continued.body);
    assert.equal(gameInventoryCount((await readInventory()).stacks, "Torch"), 1);
    const active = (await chats.getMessage(told.saved.id))!.activeSwipeIndex ?? 0;
    const row = await states.getByChatAndMessage(chat.id, told.saved.id, active);
    const names = (JSON.parse(row!.playerStats as string).inventory as Array<{ name: string }>).map(
      (item) => item.name,
    );
    assert.ok(
      names.includes("Torch") && names.includes("Sword"),
      `the continued row keeps both parts: ${names.join(", ")}`,
    );
  }

  console.info("game inventory turn regressions passed.");
} finally {
  ClaudeSubscriptionProvider.prototype.chat = originalChat;
  await app.close();
  await closeDB();
  rmSync(dir, { recursive: true, force: true });
}
