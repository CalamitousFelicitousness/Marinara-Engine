// Generated Videos, through the real generate route with a fake text model, image service and ComfyUI:
// a Conversation character's [video] command sends a clip on its message only when the chat turned
// Generated Videos on, and a Roleplay Illustrator that sets generateVideo animates its new picture into
// the same message only when the chat allows it (and is only offered the fields then).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureDir = mkdtempSync(join(tmpdir(), "marinara-agent-generated-videos-"));
process.env.DATA_DIR = fixtureDir;
process.env.FILE_STORAGE_DIR = join(fixtureDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.IMAGE_LOCAL_URLS_ENABLED = "true";
process.env.LOG_LEVEL = "silent";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { generateRoutes } = await import("../../packages/server/src/routes/generate.routes.js");
const { chatsRoutes } = await import("../../packages/server/src/routes/chats.routes.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { createAgentsStorage } = await import("../../packages/server/src/services/storage/agents.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { createPromptsStorage } = await import("../../packages/server/src/services/storage/prompts.storage.js");
const { parseCharacterCommands } =
  await import("../../packages/server/src/services/conversation/character-commands.js");
const { filterEnabledConversationCommands } =
  await import("../../packages/server/src/services/generation/conversation-command-runtime.js");
const { characterDataSchema, replaceBuiltInAgentDefinitions } = await import("../../packages/shared/dist/index.js");

replaceBuiltInAgentDefinitions([
  {
    id: "illustrator",
    name: "Illustrator",
    description: "Generated videos fixture",
    phase: "post_processing",
    enabledByDefault: true,
    category: "utility",
    defaultTools: [],
    defaultSettings: { contextSize: 2 },
    defaultPromptTemplate: 'AGENT_WRITER Return JSON {"shouldGenerate":true,"prompt":"..."}.',
  },
]);

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(12)]);

let mainReply = "";
let failVideo = false;
let illustratorReply: Record<string, unknown> = {
  shouldGenerate: true,
  prompt: "1girl, lantern, rain",
  generateVideo: true,
  videoPrompt: "The lantern light flickers as Aster turns",
};
const videoWriterRequests: string[] = [];
const agentRequests: string[] = [];
const comfyPrompts: string[] = [];
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString();
  const url = request.url ?? "";
  const json = (value: unknown) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(value));
  };
  if (url.endsWith("/prompt")) {
    if (failVideo) {
      response.statusCode = 500;
      return json({ error: "ComfyUI is down" });
    }
    comfyPrompts.push(body);
    return json({ prompt_id: "job" });
  }
  if (url.includes("/history/")) {
    return json({
      job: {
        status: { completed: true, status_str: "success" },
        outputs: { "9": { gifs: [{ filename: "clip.mp4", subfolder: "", type: "output" }] } },
      },
    });
  }
  if (url.startsWith("/view")) {
    response.setHeader("content-type", "video/mp4");
    return response.end(mp4);
  }
  if (url.endsWith("/images/generations")) return json({ data: [{ b64_json: png.toString("base64") }] });
  const messages = JSON.stringify(JSON.parse(body).messages ?? []);
  let content = mainReply;
  if (messages.includes("AGENT_WRITER")) {
    agentRequests.push(messages);
    content = JSON.stringify(illustratorReply);
  } else if (messages.includes("video prompt writer")) {
    videoWriterRequests.push(messages);
    content = "Aster waves at the camera";
  }
  json({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { total_tokens: 20 } });
});

const db = await getDB();
const app = Fastify();
app.decorate("db", db);
await app.register(generateRoutes, { prefix: "/api/generate" });
await app.register(chatsRoutes, { prefix: "/api/chats" });
const chats = createChatsStorage(db);

// The Generated Videos toggles are saved through Chat Settings' own route, and each comes back as sent.
const saveChatSettings = async (chatId: string, patch: Record<string, unknown>) => {
  const response = await app.inject({ method: "PATCH", url: `/api/chats/${chatId}/metadata`, payload: patch });
  assert.equal(response.statusCode, 200, response.body);
  const raw = (await chats.getById(chatId))?.metadata;
  const saved = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) assert.deepEqual(saved[key], value, key);
};

const videoAttachments = async (chatId: string) => {
  const messages = await chats.listMessages(chatId);
  return messages.flatMap((message) => {
    const extra = typeof message.extra === "string" ? JSON.parse(message.extra) : (message.extra ?? {});
    return ((extra as { attachments?: Array<{ type?: string }> }).attachments ?? [])
      .filter((attachment) => attachment.type === "video")
      .map((attachment) => ({ messageId: message.id, attachment }));
  });
};

try {
  // The [video] command parses like [selfie], and stays off unless Generated Videos is on.
  // Free text may quote dialogue and wrap lines; an unclosed tag never swallows text or the next command.
  const quoted = parseCharacterCommands(
    'Here! [video: she wears a "tardigrade enthusiast" shirt\nand whispers "sorry" to it.] Humbling.',
  );
  assert.deepEqual(quoted.commands, [
    { type: "video", context: 'she wears a "tardigrade enthusiast" shirt\nand whispers "sorry" to it.' },
  ]);
  assert.equal(quoted.cleanContent.replace(/\s+/gu, " ").trim(), "Here! Humbling.");
  assert.deepEqual(parseCharacterCommands("Look [video: no closing bracket and more words").commands, []);
  assert.deepEqual(
    parseCharacterCommands("Look [video: unclosed [selfie] after").commands.map((command) => command.type),
    ["selfie"],
  );
  assert.deepEqual(parseCharacterCommands("Now [video]").commands, [{ type: "video", context: undefined }]);

  const parsed = parseCharacterCommands('On my way! [video: context="waving from the bus"]');
  assert.deepEqual(parsed.commands, [{ type: "video", context: "waving from the bus" }]);
  assert.equal(parsed.cleanContent.trim(), "On my way!");
  assert.deepEqual(filterEnabledConversationCommands(parsed.commands, {}), []);
  assert.equal(
    filterEnabledConversationCommands(parsed.commands, { conversationCommandToggles: { video: true } }).length,
    1,
  );

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
  const image = await connections.create({
    name: "Image",
    provider: "image_generation",
    baseUrl: `${baseUrl}/v1`,
    model: "dall-e-3",
    imageService: "openai",
    imageGenerationSource: "openai",
    apiKey: "fixture",
  });
  const video = await connections.create({
    name: "ComfyUI video",
    provider: "video_generation",
    baseUrl,
    model: "fixture-video",
    videoService: "comfyui",
    videoGenerationSource: "comfyui",
    comfyuiWorkflow: JSON.stringify({ "1": { inputs: { text: "%prompt%", image: "%reference_image%" } } }),
    apiKey: "",
    videoPromptInstructions: "Describe one slow camera move.",
  });
  await createAgentsStorage(db).create({
    type: "illustrator",
    name: "Illustrator",
    phase: "post_processing",
    connectionId: text.id,
    settings: { imageConnectionId: image.id, contextSize: 2, enabledTools: [] },
  });
  const aster = await createCharactersStorage(db).create(characterDataSchema.parse({ name: "Aster" }));
  assert.ok(aster);
  const preset = await createPromptsStorage(db).create({ name: "Fixture", parameters: {}, wrapFormat: "xml" });
  assert.ok(preset);
  await createPromptsStorage(db).createSection({
    presetId: preset.id,
    identifier: "history",
    name: "History",
    isMarker: true,
    markerConfig: { type: "chat_history" },
  });
  const generate = async (chatId: string, userMessage: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/generate",
      payload: { chatId, userMessage, streaming: false },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.body;
  };

  // ── Roleplay Illustrator ──
  const roleplay = await chats.create({
    name: "Roleplay",
    mode: "roleplay",
    characterIds: [aster.id],
    connectionId: text.id,
    promptPresetId: preset.id,
  });
  assert.ok(roleplay);
  const roleplayMeta = {
    enableAgents: true,
    activeAgentIds: ["illustrator"],
    illustratorUseAvatarReferences: false,
    illustratorIncludeCharacterAppearance: false,
    illustratorRunInterval: 1,
    automaticSummaryEnabled: false,
    sceneVideoConnectionId: video.id,
  };

  // Pictures: the agent is not offered the fields, and its generateVideo is ignored.
  await saveChatSettings(roleplay.id, { ...roleplayMeta, illustratorVideoMode: "pictures" });
  mainReply = "Aster lifts a lantern.";
  await generate(roleplay.id, "Aster finds a lantern.");
  assert.doesNotMatch(agentRequests.at(-1) ?? "", /optional_video/u);
  assert.equal((await videoAttachments(roleplay.id)).length, 0);
  assert.equal(comfyPrompts.length, 0);

  // Pictures and clips: the fields and the video connection's instructions are offered, and the picture is animated.
  await saveChatSettings(roleplay.id, { ...roleplayMeta, illustratorVideoMode: "pictures_and_clips" });
  await generate(roleplay.id, "Aster walks into the rain.");
  assert.match(
    agentRequests.at(-1) ?? "",
    /<optional_video>[\s\S]*?generateVideo[\s\S]*?Describe one slow camera move\.\\n<\/optional_video>/u,
  );
  const roleplayVideos = await videoAttachments(roleplay.id);
  assert.equal(roleplayVideos.length, 1, JSON.stringify(roleplayVideos));
  const lastAssistant = (await chats.listMessages(roleplay.id))
    .filter((message) => message.role === "assistant")
    .at(-1);
  assert.equal(roleplayVideos[0]?.messageId, lastAssistant?.id, "the clip joins the message with its picture");
  const roleplayWorkflow = JSON.parse(comfyPrompts.at(-1) ?? "{}").prompt["1"].inputs;
  assert.equal(roleplayWorkflow.text, "The lantern light flickers as Aster turns");
  assert.equal(roleplayWorkflow.image, png.toString("base64"));
  const imagesOn = async (messageId: string | undefined) =>
    (await chats.listMessages(roleplay.id))
      .filter((message) => message.id === messageId)
      .flatMap((message) => {
        const extra = typeof message.extra === "string" ? JSON.parse(message.extra) : (message.extra ?? {});
        return ((extra as { attachments?: Array<{ type?: string }> }).attachments ?? []).filter(
          (attachment) => attachment.type === "image",
        );
      });
  assert.equal((await imagesOn(lastAssistant?.id)).length, 1, "the picture is shown with its clip");

  // Clips only: every picture becomes a clip without the agent asking, and only the clip is shown.
  await saveChatSettings(roleplay.id, { ...roleplayMeta, illustratorVideoMode: "clips_only" });
  illustratorReply = { shouldGenerate: true, prompt: "1girl, lantern, rain" };
  await generate(roleplay.id, "Aster opens the door.");
  assert.match(agentRequests.at(-1) ?? "", /shows short video clips instead of pictures/u);
  const clipOnly = (await chats.listMessages(roleplay.id)).filter((message) => message.role === "assistant").at(-1);
  assert.equal((await videoAttachments(roleplay.id)).filter((item) => item.messageId === clipOnly?.id).length, 1);
  assert.equal((await imagesOn(clipOnly?.id)).length, 0, "the picture is only the clip's first frame");
  assert.equal(JSON.parse(comfyPrompts.at(-1) ?? "{}").prompt["1"].inputs.image, png.toString("base64"));

  // Clips only, clip fails: the picture is shown instead.
  failVideo = true;
  await generate(roleplay.id, "Aster steps outside.");
  failVideo = false;
  const fellBack = (await chats.listMessages(roleplay.id)).filter((message) => message.role === "assistant").at(-1);
  assert.equal((await videoAttachments(roleplay.id)).filter((item) => item.messageId === fellBack?.id).length, 0);
  assert.equal((await imagesOn(fellBack?.id)).length, 1, "a failed clip leaves its picture in the reply");

  // ── Conversation [video] ──
  const convo = await chats.create({
    name: "Convo",
    mode: "conversation",
    characterIds: [aster.id],
    connectionId: text.id,
  });
  assert.ok(convo);
  const convoMeta = {
    characterCommands: true,
    sceneVideoConnectionId: video.id,
    sceneVideoFirstFrame: "prompt_only",
    automaticSummaryEnabled: false,
  };
  mainReply = 'Look! [video: context="waving from the bus"]';

  await saveChatSettings(convo.id, { ...convoMeta, conversationCommandToggles: {} });
  await generate(convo.id, "Send me a video?");
  assert.equal((await videoAttachments(convo.id)).length, 0, "Generated Videos off: no clip");

  await saveChatSettings(convo.id, { ...convoMeta, conversationCommandToggles: { video: true } });
  const body = await generate(convo.id, "Send me a video!");
  const convoVideos = await videoAttachments(convo.id);
  assert.equal(convoVideos.length, 1, body);
  assert.equal((convoVideos[0]?.attachment as { characterName?: string }).characterName, "Aster");
  const sender = await chats.getMessage(convoVideos[0]!.messageId);
  assert.equal(sender?.characterId, aster.id);
  assert.doesNotMatch(String(sender?.content), /\[video/u, "the command tag is hidden");
  assert.match(body, /"type":"video"/u);
  assert.match(videoWriterRequests.at(-1) ?? "", /Context for the video message: waving from the bus/u);

  // A bare [video] gives the writer the recent conversation, as /video does: the user's request and the reply.
  mainReply = "Here are the pinkish haloarchaea under my microscope! [video]";
  await chats.patchMetadata(convo.id, { illustratorVideoRunInterval: 1 });
  await generate(convo.id, "Show me the microscope dancing!");
  assert.equal((await videoAttachments(convo.id)).length, 2);
  assert.match(
    videoWriterRequests.at(-1) ?? "",
    /Recent conversation:[\s\S]*Show me the microscope dancing![\s\S]*pinkish haloarchaea/u,
    "the user's request and the reply both reach the writer",
  );
  assert.doesNotMatch(videoWriterRequests.at(-1) ?? "", /Context for the video message/u);
  console.log("agent-generated-videos regression passed");
} finally {
  await app.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await closeDB();
  rmSync(fixtureDir, { recursive: true, force: true });
}
