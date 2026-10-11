// Saving a settings profile can update the other chats that use it (#7409), and a profile never
// carries one chat's running state (macro variables, disabled members, multiplayer room, …) to another.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatFollowsChatPreset } from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-chat-profile-followers-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { chatPresetsRoutes } = await import("../../packages/server/src/routes/chat-presets.routes.js");
const { createChatPresetsStorage } = await import("../../packages/server/src/services/storage/chat-presets.storage.js");
const { chats } = await import("../../packages/server/src/db/schema/chats.js");
const { eq } = await import("../../packages/server/src/db/file-query.js");
const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await app.register(chatsRoutes, { prefix: "/api/chats" });
await app.register(chatPresetsRoutes, { prefix: "/api/chat-presets" });
const presets = createChatPresetsStorage(db);

type Row = {
  id: string;
  connectionId: string | null;
  promptPresetId: string | null;
  metadata: string;
  updatedAt: string;
};
const readRow = async (id: string) => ((await db.select().from(chats).where(eq(chats.id, id))) as Row[])[0]!;
const readMeta = async (id: string) => JSON.parse((await readRow(id)).metadata) as Record<string, unknown>;
const writeRow = (id: string, values: Partial<Row> & { metadata?: Record<string, unknown> }) =>
  db
    .update(chats)
    .set({ ...values, ...(values.metadata && { metadata: JSON.stringify(values.metadata) }) })
    .where(eq(chats.id, id));
const createChat = async (name: string, mode: "roleplay" | "conversation" = "roleplay") => {
  const response = await app.inject({ method: "POST", url: "/api/chats", payload: { name, mode, characterIds: [] } });
  assert.equal(response.statusCode, 200);
  return response.json().id as string;
};
const followersUrl = (id: string) => `/api/chat-presets/${id}/apply-to-followers`;

// Running state that belongs to one chat. Saving must drop it; applying must keep the target's own.
const runningState = (tag: string) => ({
  macroVariables: { counter: tag },
  inactiveCharacterIds: [`muted-${tag}`],
  advancedMemoryState: { status: "idle", sourceFingerprint: `fp-${tag}` },
  intentCooldowns: { [`char-${tag}`]: { checkin: "2026-10-11T00:00:00.000Z" } },
  autonomousDailyBudget: { date: "2026-10-11", counts: { [`char-${tag}`]: 2 } },
  conversationCharacterStatuses: { [`char-${tag}`]: { status: "online", activity: tag } },
  conversationStatusOverrides: { [`char-${tag}`]: { status: "busy" } },
  conversationAboutMeOverrides: { [`char-${tag}`]: `about ${tag}` },
});
const runningKeys = Object.keys(runningState("x"));

try {
  // The shared rule both the dialog count and the server use.
  assert.equal(chatFollowsChatPreset({ appliedChatPresetId: "p" }, "p"), true);
  assert.equal(chatFollowsChatPreset({ appliedChatPresetId: "q" }, "p"), false);
  assert.equal(chatFollowsChatPreset(null, "p"), false);
  assert.equal(chatFollowsChatPreset({ appliedChatPresetId: "p", multiplayer: { role: "guest" } }, "p"), false);
  assert.equal(chatFollowsChatPreset({ appliedChatPresetId: "p", multiplayerSetup: true }, "p"), false);

  const profile = (await presets.create({ name: "Shared", mode: "roleplay", settings: {} }))!;
  const other = (await presets.create({ name: "Other", mode: "roleplay", settings: {} }))!;
  const source = await createChat("Source");
  const follower = await createChat("Follower");
  const room = await createChat("Hosted room");
  const guest = await createChat("Joined room");
  const elsewhere = await createChat("Uses another profile");
  const otherMode = await createChat("Conversation", "conversation");
  for (const id of [source, follower, room, guest]) {
    const applied = await app.inject({ method: "POST", url: `/api/chat-presets/${profile.id}/apply/${id}` });
    assert.equal(applied.statusCode, 200);
  }
  assert.equal(
    (await app.inject({ method: "POST", url: `/api/chat-presets/${other.id}/apply/${elsewhere}` })).statusCode,
    200,
  );

  // Each chat has its own connection, prompt preset, running state and a tweak to a profile setting.
  await writeRow(follower, {
    connectionId: "follower-connection",
    promptPresetId: "follower-prompt",
    metadata: { ...(await readMeta(follower)), ...runningState("follower"), enableAgents: true, contextSize: 111 },
  });
  const hostedRoom = { version: 1, role: "host", roomId: "room-1", status: "active" };
  await writeRow(room, {
    metadata: { ...(await readMeta(room)), multiplayer: hostedRoom, enableAgents: true, contextSize: 222 },
  });
  await writeRow(guest, {
    metadata: { ...(await readMeta(guest)), multiplayer: { version: 1, role: "guest", roomId: "room-2" } },
  });
  await writeRow(elsewhere, { metadata: { ...(await readMeta(elsewhere)), contextSize: 333 } });
  await writeRow(otherMode, { metadata: { ...(await readMeta(otherMode)), appliedChatPresetId: profile.id } });

  // Save the profile from the source chat, the way the Save button snapshots it.
  const sourceMeta = {
    ...(await readMeta(source)),
    ...runningState("source"),
    multiplayerSetup: false,
    multiplayerGameSetup: { preferences: "source" },
    enableAgents: false,
    contextSize: 999,
  };
  const saved = await app.inject({
    method: "PUT",
    url: `/api/chat-presets/${profile.id}/settings`,
    payload: { connectionId: "source-connection", promptPresetId: "source-prompt", metadata: sourceMeta },
  });
  assert.equal(saved.statusCode, 200);
  const savedMeta = saved.json().settings.metadata as Record<string, unknown>;
  assert.equal(savedMeta.contextSize, 999, "profile settings are saved");
  for (const key of [...runningKeys, "multiplayerSetup", "multiplayerGameSetup"]) {
    assert.equal(key in savedMeta, false, `saving a profile leaves out the chat's own ${key}`);
  }

  const before = new Map(
    await Promise.all([source, room, guest, elsewhere, otherMode].map(async (id) => [id, await readRow(id)] as const)),
  );
  const followerBefore = await readRow(follower);
  const response = await app.inject({
    method: "POST",
    url: followersUrl(profile.id),
    payload: { exceptChatId: source },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { updated: 1, chatIds: [follower] }, "only the plain follower is updated");

  const updated = await readRow(follower);
  const updatedMeta = JSON.parse(updated.metadata) as Record<string, unknown>;
  assert.equal(updatedMeta.contextSize, 999, "the follower gets the profile's settings");
  assert.equal(updatedMeta.enableAgents, false, "the follower's own tweak to a profile setting is replaced");
  assert.equal(updatedMeta.appliedChatPresetId, profile.id);
  for (const key of runningKeys) {
    assert.deepEqual(updatedMeta[key], runningState("follower")[key as keyof ReturnType<typeof runningState>]);
  }
  assert.equal(updated.connectionId, "follower-connection", "the follower keeps its connection");
  assert.equal(updated.promptPresetId, "follower-prompt", "the follower keeps its prompt preset");
  assert.equal(updated.updatedAt, followerBefore.updatedAt, "a background update does not reorder recent chats");
  for (const [id, row] of before) {
    assert.deepEqual(await readRow(id), row, "the saved chat, rooms, other profiles and other modes stay unchanged");
  }

  // A chat that left the profile after the scan is skipped inside its own queue.
  assert.equal(await presets.applyToChat(profile.id, elsewhere, { asFollower: true }), null);
  assert.deepEqual(await readRow(elsewhere), before.get(elsewhere));

  // Applying a profile by hand still sets the connection and prompt preset, and keeps running state.
  const applied = await app.inject({ method: "POST", url: `/api/chat-presets/${profile.id}/apply/${follower}` });
  assert.equal(applied.statusCode, 200);
  assert.equal(applied.json().connectionId, "source-connection");
  assert.equal(applied.json().promptPresetId, "source-prompt");
  const appliedMeta = JSON.parse(applied.json().metadata) as Record<string, unknown>;
  assert.deepEqual(appliedMeta.macroVariables, { counter: "follower" }, "applying keeps the chat's macro variables");
  assert.deepEqual(appliedMeta.inactiveCharacterIds, ["muted-follower"]);
  const roomApplied = await app.inject({ method: "POST", url: `/api/chat-presets/${profile.id}/apply/${room}` });
  assert.deepEqual(JSON.parse(roomApplied.json().metadata).multiplayer, hostedRoom, "applying keeps a room");

  const defaultProfile = (await presets.getDefault("roleplay"))!;
  assert.equal(
    (await app.inject({ method: "POST", url: followersUrl(defaultProfile.id), payload: {} })).statusCode,
    400,
  );
  assert.equal((await app.inject({ method: "POST", url: followersUrl("missing"), payload: {} })).statusCode, 404);
  console.info("Settings profile follower updates and running-state exclusions passed.");
} finally {
  await app.close();
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
