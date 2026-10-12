// Generated scene videos play inline: through the real gallery route, with a fake text model and a fake
// ComfyUI, the finished video is attached to the message that shows its source image (or else the latest
// assistant message), and a video attachment never reaches a model prompt as an image or a readable file.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureDir = mkdtempSync(join(tmpdir(), "marinara-inline-chat-videos-"));
process.env.DATA_DIR = fixtureDir;
process.env.FILE_STORAGE_DIR = join(fixtureDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.LOG_LEVEL = "silent";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { galleryRoutes } = await import("../../packages/server/src/routes/gallery.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createGalleryStorage } = await import("../../packages/server/src/services/storage/gallery.storage.js");
const { extractImageAttachmentDataUrls, extractFileAttachmentInputs, buildReadableAttachmentBlocks } =
  await import("../../packages/server/src/services/generation/prompt-attachments.js");

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);

// One local server plays both the text model (director) and ComfyUI.
const comfyPrompts: string[] = [];
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const url = request.url ?? "";
  if (url.endsWith("/prompt")) {
    comfyPrompts.push(Buffer.concat(chunks).toString());
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ prompt_id: "job-1" }));
    return;
  }
  if (url.includes("/history/")) {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        "job-1": {
          status: { completed: true, status_str: "success" },
          outputs: { "9": { gifs: [{ filename: "clip.mp4", subfolder: "", type: "output" }] } },
        },
      }),
    );
    return;
  }
  if (url.startsWith("/view")) {
    response.setHeader("content-type", "video/mp4");
    response.end(mp4);
    return;
  }
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content: JSON.stringify({ narrationBeat: "Aster lifts the lantern" }) },
          finish_reason: "stop",
        },
      ],
      usage: { total_tokens: 20 },
    }),
  );
});

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await app.register(galleryRoutes, { prefix: "/api/gallery" });

try {
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const connections = createConnectionsStorage(db);
  const text = await connections.create({
    name: "Text fixture",
    provider: "custom",
    baseUrl: `${baseUrl}/v1`,
    model: "fixture",
    apiKey: "fixture",
  });
  const video = await connections.create({
    name: "ComfyUI video fixture",
    provider: "video_generation",
    baseUrl,
    model: "fixture-video",
    videoService: "comfyui",
    videoGenerationSource: "comfyui",
    comfyuiWorkflow: JSON.stringify({ "1": { inputs: { text: "%prompt%", image: "%reference_image%" } } }),
    apiKey: "",
  });

  const chats = createChatsStorage(db);
  const gallery = createGalleryStorage(db);
  const roleplay = await chats.create({ name: "Roleplay", mode: "roleplay", characterIds: [], connectionId: text.id });
  assert.ok(roleplay);
  await chats.patchMetadata(roleplay.id, { sceneVideoConnectionId: video.id });
  mkdirSync(join(fixtureDir, "gallery", roleplay.id), { recursive: true });
  writeFileSync(join(fixtureDir, "gallery", roleplay.id, "lantern.png"), png);
  const image = await gallery.create({
    chatId: roleplay.id,
    filePath: `${roleplay.id}/lantern.png`,
    prompt: "A lantern",
  });
  assert.ok(image);

  // The source message shows the image; a later assistant message must not get the video.
  const source = await chats.createMessage({
    chatId: roleplay.id,
    role: "assistant",
    characterId: null,
    content: "Aster finds a lantern.",
    extra: { attachments: [{ type: "image", url: "/api/gallery/file/x/lantern.png", galleryId: image.id }] },
  });
  const later = await chats.createMessage({
    chatId: roleplay.id,
    role: "assistant",
    characterId: null,
    content: "The night goes on.",
  });
  assert.ok(source && later);

  const generate = async (payload: Record<string, unknown>) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/gallery/generate-scene-video",
      payload: { chatId: roleplay.id, ...payload },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as { video: { id: string; url: string }; messageId: string | null };
  };
  const videoAttachments = async (messageId: string) => {
    const message = await chats.getMessage(messageId);
    const extra = typeof message?.extra === "string" ? JSON.parse(message.extra) : (message?.extra ?? {});
    const swipes = await chats.getSwipes(messageId);
    const swipeExtra = swipes[0]?.extra;
    const parsedSwipe = typeof swipeExtra === "string" ? JSON.parse(swipeExtra) : (swipeExtra ?? {});
    const pick = (record: { attachments?: Array<{ type?: string }> }) =>
      (record.attachments ?? []).filter((attachment) => attachment.type === "video");
    return { message: pick(extra), swipe: pick(parsedSwipe) };
  };

  // Animating the image attaches the video to the message that shows it, on the message and its swipe.
  const first = await generate({ galleryImageId: image.id });
  assert.equal(first.messageId, source.id);
  const onSource = await videoAttachments(source.id);
  assert.equal(onSource.message.length, 1);
  assert.equal(onSource.swipe.length, 1);
  assert.deepEqual(
    { ...onSource.message[0], url: undefined },
    {
      type: "video",
      url: undefined,
      filename: first.video.url.split("/").pop(),
      prompt: (onSource.message[0] as { prompt?: string }).prompt,
      videoId: first.video.id,
      durationSeconds: (onSource.message[0] as { durationSeconds?: number }).durationSeconds,
      aspectRatio: (onSource.message[0] as { aspectRatio?: string }).aspectRatio,
    },
  );
  assert.equal((onSource.message[0] as { url?: string }).url, first.video.url);
  assert.equal((await videoAttachments(later.id)).message.length, 0);
  assert.match(comfyPrompts[0] ?? "", /Aster lifts the lantern/u);

  // An image no message shows falls back to the latest assistant message.
  writeFileSync(join(fixtureDir, "gallery", roleplay.id, "loose.png"), png);
  const loose = await gallery.create({ chatId: roleplay.id, filePath: `${roleplay.id}/loose.png`, prompt: "Loose" });
  assert.ok(loose);
  const second = await generate({ galleryImageId: loose.id });
  assert.equal(second.messageId, later.id);
  assert.equal((await videoAttachments(later.id)).message.length, 1);

  // A video attachment is never an image, a provider file, or readable text for a model prompt.
  const attachment = { type: "video", url: first.video.url, filename: "clip.mp4", prompt: "Aster lifts the lantern" };
  assert.deepEqual(extractImageAttachmentDataUrls([attachment]), []);
  assert.deepEqual(extractFileAttachmentInputs([attachment]), []);
  assert.deepEqual(buildReadableAttachmentBlocks([attachment]), []);
  console.log("inline-chat-videos regression passed");
} finally {
  await app.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await closeDB();
  rmSync(fixtureDir, { recursive: true, force: true });
}
