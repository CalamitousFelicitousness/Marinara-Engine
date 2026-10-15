// A Conversation video is filed under the characters it shows: in a group chat, a clip Aster sends that
// names Bob appears in Aster's and Bob's gallery clips but not Carol's, and in the persona's gallery only when it
// names the persona. Older videos, which were never tagged, keep appearing for every character and the persona
// of their chat.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureDir = mkdtempSync(join(tmpdir(), "marinara-convo-video-galleries-"));
process.env.DATA_DIR = fixtureDir;
process.env.FILE_STORAGE_DIR = join(fixtureDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { galleryRoutes } = await import("../../packages/server/src/routes/gallery.routes.js");
const { charactersRoutes } = await import("../../packages/server/src/routes/characters.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { createGameSceneVideosStorage } =
  await import("../../packages/server/src/services/storage/game-scene-videos.storage.js");
const { characterDataSchema } = await import("../../packages/shared/dist/index.js");

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);
// What the fake prompt writer says the clip shows.
let writerReply = "Aster pulls Bob into the frame";
const provider = createServer(async (request, response) => {
  for await (const _chunk of request) void _chunk;
  const url = request.url ?? "";
  response.setHeader("content-type", "application/json");
  if (url.endsWith("/prompt")) return response.end(JSON.stringify({ prompt_id: "job" }));
  if (url.includes("/history/")) {
    return response.end(
      JSON.stringify({
        job: {
          status: { completed: true, status_str: "success" },
          outputs: { "9": { gifs: [{ filename: "clip.mp4", subfolder: "", type: "output" }] } },
        },
      }),
    );
  }
  if (url.startsWith("/view")) {
    response.setHeader("content-type", "video/mp4");
    return response.end(mp4);
  }
  response.end(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: writerReply }, finish_reason: "stop" }],
      usage: { total_tokens: 20 },
    }),
  );
});

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await app.register(galleryRoutes, { prefix: "/api/gallery" });
await app.register(charactersRoutes, { prefix: "/api/characters" });

try {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const connections = createConnectionsStorage(db);
  const text = await connections.create({
    name: "Text",
    provider: "custom",
    baseUrl: `${baseUrl}/v1`,
    model: "fixture",
    apiKey: "fixture",
  });
  const video = await connections.create({
    name: "ComfyUI video",
    provider: "video_generation",
    baseUrl,
    model: "fixture-video",
    videoService: "comfyui",
    videoGenerationSource: "comfyui",
    comfyuiWorkflow: JSON.stringify({ "1": { inputs: { text: "%prompt%" } } }),
    apiKey: "",
  });
  const characters = createCharactersStorage(db);
  const [aster, bob, carol] = await Promise.all(
    ["Aster", "Bob", "Carol"].map((name) => characters.create(characterDataSchema.parse({ name }))),
  );
  assert.ok(aster && bob && carol);
  const jamie = await characters.createPersona("Jamie", "The player.");
  assert.ok(jamie);

  const chats = createChatsStorage(db);
  const group = await chats.create({
    name: "Group",
    mode: "conversation",
    characterIds: [aster.id, bob.id, carol.id],
    connectionId: text.id,
    personaId: jamie.id,
  });
  assert.ok(group);
  await chats.patchMetadata(group.id, { sceneVideoConnectionId: video.id, sceneVideoFirstFrame: "prompt_only" });

  const sent = await app.inject({
    method: "POST",
    url: `/api/gallery/${group.id}/video`,
    payload: { characterId: aster.id },
  });
  assert.equal(sent.statusCode, 200, sent.body);
  const videoId = (sent.json() as { video: { id: string } }).video.id;

  // An older, untagged video in the same chat.
  const legacy = await createGameSceneVideosStorage(db).create({
    chatId: group.id,
    filePath: `${group.id}/legacy.mp4`,
    prompt: "Old clip",
    provider: "comfyui",
    model: "m",
    durationSeconds: 5,
    aspectRatio: "16:9",
  });
  assert.ok(legacy);

  const clipIds = async (characterId: string) => {
    const response = await app.inject({ method: "GET", url: `/api/characters/${characterId}/gallery/clips` });
    assert.equal(response.statusCode, 200, response.body);
    return (response.json() as { clips: Array<{ id: string }> }).clips.map((clip) => clip.id);
  };
  const asterClips = await clipIds(aster.id);
  const bobClips = await clipIds(bob.id);
  const carolClips = await clipIds(carol.id);
  assert.ok(asterClips.includes(`scene:${videoId}`), "the sender keeps the clip");
  assert.ok(bobClips.includes(`scene:${videoId}`), "a named character gets the clip");
  assert.ok(!carolClips.includes(`scene:${videoId}`), "an unnamed character does not");
  for (const clips of [asterClips, bobClips, carolClips]) {
    assert.ok(clips.includes(`scene:${legacy.id}`), "an untagged video still belongs to everyone in the chat");
  }

  // The persona's gallery lists a Conversation clip only when the clip shows the persona.
  writerReply = "Aster films Jamie dancing badly in the kitchen";
  const withPersona = await app.inject({
    method: "POST",
    url: `/api/gallery/${group.id}/video`,
    payload: { characterId: aster.id },
  });
  assert.equal(withPersona.statusCode, 200, withPersona.body);
  const personaVideoId = (withPersona.json() as { video: { id: string } }).video.id;
  const personaResponse = await app.inject({
    method: "GET",
    url: `/api/characters/personas/${jamie.id}/gallery/clips`,
  });
  assert.equal(personaResponse.statusCode, 200, personaResponse.body);
  const personaClips = (personaResponse.json() as { clips: Array<{ id: string }> }).clips.map((clip) => clip.id);
  assert.ok(
    !personaClips.includes(`scene:${videoId}`),
    "a clip that doesn't show the persona stays out of its gallery",
  );
  assert.ok(personaClips.includes(`scene:${personaVideoId}`), "a clip that names the persona is in its gallery");
  assert.ok(personaClips.includes(`scene:${legacy.id}`), "an untagged video still belongs to the persona's chat");
  assert.ok(!(await clipIds(bob.id)).includes(`scene:${personaVideoId}`), "naming the persona doesn't add Bob");
  console.log("convo-video-character-galleries regression passed");
} finally {
  await app.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await closeDB();
  rmSync(fixtureDir, { recursive: true, force: true });
}
