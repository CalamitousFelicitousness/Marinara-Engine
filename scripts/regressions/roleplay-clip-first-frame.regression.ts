// Roleplay clips follow the chat's First frame, through the real routes with a fake text model, image service and
// ComfyUI: with Clips only, the avatar or no picture draws no picture at all; Send Avatar References for videos
// lets a Prompt only clip start from the avatar; a clip without a picture is written by the Clip Director and describes everyone it names, the
// user's persona included, and the Avatar first frame starts from whoever is named first.
import assert from "node:assert/strict";
import { startRoleplayVideoHarness } from "./fixtures/roleplay-video-harness.js";

const h = await startRoleplayVideoHarness("roleplay-clip-first-frame");
const { replies, requests, png, avatarPng } = h;

try {
  const roleplay = await h.createRoleplay("Roleplay");
  await h.saveChatSettings(roleplay.id, {
    enableAgents: true,
    activeAgentIds: ["illustrator"],
    illustratorUseAvatarReferences: false,
    illustratorIncludeCharacterAppearance: false,
    illustratorRunInterval: 1,
    sceneVideoConnectionId: h.video.id,
    illustratorVideoMode: "clips_only",
    sceneVideoFirstFrame: "prompt_only",
    automaticSummaryEnabled: false,
  });
  const latestReplyImages = async () => {
    const reply = (await h.chats.listMessages(roleplay.id)).filter((message) => message.role === "assistant").at(-1);
    const extra = typeof reply?.extra === "string" ? JSON.parse(reply.extra) : (reply?.extra ?? {});
    return ((extra as { attachments?: Array<{ type?: string }> }).attachments ?? []).filter(
      (attachment) => attachment.type === "image",
    ).length;
  };

  // ── Clips only: no picture is drawn unless the clip starts from one ──
  replies.agent = { shouldGenerate: true, prompt: "1girl, porch, dusk", videoPrompt: "Aster waves slowly" };
  replies.main = "Aster smiles.";
  let clips = 0;
  await h.generate(roleplay.id, "Aster waves.");
  assert.equal(requests.images, 0, "Prompt only draws no picture");
  assert.equal((await h.attachments(roleplay.id, "video")).length, ++clips);
  assert.equal(await latestReplyImages(), 0);
  assert.notEqual(h.lastComfyInputs()?.image, avatarPng.toString("base64"), "Prompt only starts from nothing");
  // No picture shows the moment, so the Clip Director writes the clip from Illustrator's scene and motion.
  const clipRequest = requests.director.at(-1) ?? "";
  assert.match(clipRequest, /No picture of this moment exists/u, "the Clip Director writes it");
  assert.doesNotMatch(clipRequest, /decide the output/u, "with no instructions, the director's own format stands");
  assert.match(clipRequest, /Requested clip: 1girl, porch, dusk\\nAster waves slowly/u, "with the scene and motion");
  assert.equal(h.lastComfyInputs()?.text, "Bottles burst across the lab floor", "its prompt is what is sent");

  // The video connection's instructions decide the format: a multi-line answer in their fields reaches the video
  // model as written, line breaks included, even as plain text instead of JSON.
  const threeFields = [
    "integrated_multimodal_description: [Shot 1] Low light on the porch; Aster waves slowly.",
    "overall_soundscape: Crickets and a creaking swing.",
    "non_diegetic_music: N/A",
  ].join("\n");
  replies.director = { content: threeFields, finishReason: "stop" };
  await h.generate(roleplay.id, "Aster waves once more.");
  assert.equal((await h.attachments(roleplay.id, "video")).length, ++clips);
  assert.equal(h.lastComfyInputs()?.text, threeFields, "the instructed format arrives intact");

  await h.saveChatSettings(roleplay.id, { sceneVideoFirstFrame: "avatar" });
  await h.generate(roleplay.id, "Aster smiles again.");
  assert.equal(requests.images, 0, "Avatar or sprite draws no picture");
  assert.equal((await h.attachments(roleplay.id, "video")).length, ++clips);
  assert.equal(h.lastComfyInputs()?.image, avatarPng.toString("base64"), "the clip starts from the avatar");

  // Send Avatar References for videos: a Prompt only clip starts from the avatar.
  await h.saveChatSettings(roleplay.id, {
    sceneVideoFirstFrame: "prompt_only",
    illustratorVideoUseAvatarReferences: true,
  });
  await h.generate(roleplay.id, "Aster nods.");
  assert.equal((await h.attachments(roleplay.id, "video")).length, ++clips);
  assert.equal(h.lastComfyInputs()?.image, avatarPng.toString("base64"));

  // New Illustrator picture: the picture is drawn, used as the first frame, and not shown.
  await h.saveChatSettings(roleplay.id, {
    sceneVideoFirstFrame: "picture",
    illustratorVideoUseAvatarReferences: false,
  });
  await h.generate(roleplay.id, "Show the porch.");
  assert.equal(requests.images, 1, "the first frame is drawn");
  assert.equal((await h.attachments(roleplay.id, "video")).length, ++clips);
  assert.equal(await latestReplyImages(), 0, "the picture is only the clip's first frame");
  assert.equal(h.lastComfyInputs()?.image, png.toString("base64"));

  // ── Pictures and clips: a picture Illustrator animates keeps showing; its clip follows First frame ──
  await h.saveChatSettings(roleplay.id, { illustratorVideoMode: "pictures_and_clips", sceneVideoFirstFrame: "avatar" });
  replies.agent = {
    shouldGenerate: true,
    prompt: "1girl, porch, rain",
    generateVideo: true,
    videoPrompt: "Rain falls",
  };
  await h.generate(roleplay.id, "It starts to rain.");
  assert.equal(await latestReplyImages(), 1, "the picture shows");
  assert.equal((await h.attachments(roleplay.id, "video")).length, ++clips);
  assert.equal(h.lastComfyInputs()?.image, avatarPng.toString("base64"), "and the clip starts from the avatar");

  // ── A clip with no picture shows everyone it names, the user's persona included ──
  const { james, bram, personaPng, bramPng } = await h.addPersonaAndBram();
  const pair = await h.createRoleplay("Pair", { characterIds: [bram.id], personaId: james.id });
  await h.saveChatSettings(pair.id, {
    enableAgents: true,
    activeAgentIds: ["illustrator"],
    illustratorVideoMode: "clips_only",
    illustratorVideoIncludeCharacterAppearance: true,
    illustratorRunInterval: 1,
    sceneVideoConnectionId: h.video.id,
    sceneVideoFirstFrame: "prompt_only",
    automaticSummaryEnabled: false,
  });
  replies.agent = {
    shouldGenerate: true,
    prompt: "James smashes beakers while Bram ducks",
    characters: ["James", "Bram"],
    videoPrompt: "Glass flies",
  };
  await h.generate(pair.id, "James throws a beaker.");
  assert.match(h.lastComfyInputs()?.text ?? "", /James stands 6'3 with dark blue eyes/u, "the persona's look");
  assert.match(h.lastComfyInputs()?.text ?? "", /Bram wears a red scarf/u, "and the character's");
  // Avatar first frame: the first one named, the persona here, then a character when named first.
  await h.saveChatSettings(pair.id, { sceneVideoFirstFrame: "avatar" });
  await h.generate(pair.id, "Again.");
  assert.equal(h.lastComfyInputs()?.image, personaPng.toString("base64"), "the clip starts from the persona's avatar");
  replies.agent = { ...replies.agent, characters: ["Bram", "James"] };
  await h.generate(pair.id, "Once more.");
  assert.equal(h.lastComfyInputs()?.image, bramPng.toString("base64"), "or from the character named first");

  console.log("roleplay-clip-first-frame regression passed");
} finally {
  await h.close();
}
