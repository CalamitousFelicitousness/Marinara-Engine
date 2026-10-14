// Roleplay /video and the Gallery's clip paths, through the real routes with a fake text model, image service and
// ComfyUI: the motion director reads as many recent messages as Illustrator does (its Agent Budget context size),
// ending at the picture's reply when it animates a picture; /video makes a clip of the latest reply (or of a
// description) under the newest reply, following First frame, and its Avatar first frame starts from whoever the
// description names.
import assert from "node:assert/strict";
import { startRoleplayVideoHarness } from "./fixtures/roleplay-video-harness.js";

const h = await startRoleplayVideoHarness("roleplay-video-command");
const { replies, requests, png } = h;

try {
  const lastDirector = () => requests.director.at(-1) ?? "";

  // ── Animating a picture: the director reads Illustrator's recent messages, ending at the picture ──
  const roleplay = await h.createRoleplay("Roleplay");
  await h.saveChatSettings(roleplay.id, {
    enableAgents: true,
    activeAgentIds: ["illustrator"],
    illustratorUseAvatarReferences: false,
    illustratorIncludeCharacterAppearance: false,
    illustratorRunInterval: 1,
    sceneVideoConnectionId: h.video.id,
    automaticSummaryEnabled: false,
  });
  replies.main = "Aster looks back.";
  await h.generate(roleplay.id, "Aster turns around.");
  replies.agent = { shouldGenerate: true, prompt: "1girl, window, rain" };
  replies.main = "Aster smiles.";
  await h.generate(roleplay.id, "Aster rests.");
  replies.agent = { shouldGenerate: false };
  replies.main = "Aster sings.";
  await h.generate(roleplay.id, "Aster hums.");
  const pictured = (await h.attachments(roleplay.id, "image")).map((attachment) => attachment.galleryId);
  assert.equal(pictured.length, 1, "Illustrator drew one picture");
  const animate = async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/api/gallery/generate-scene-video",
      payload: { chatId: roleplay.id, galleryImageId: pictured[0] },
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  await animate();
  assert.match(lastDirector(), /Aster rests\.[\s\S]*Aster smiles\./u, "the picture's exchange");
  assert.doesNotMatch(lastDirector(), /Aster hums\./u, "nothing after the picture");
  assert.doesNotMatch(lastDirector(), /Aster turns around\./u, "nothing older than the context size (2)");
  await h.setIllustratorContext(4);
  await animate();
  assert.match(lastDirector(), /Aster turns around\./u, "a wider context size reaches further back");
  assert.doesNotMatch(lastDirector(), /Aster hums\./u, "still nothing after the picture");
  assert.equal(h.lastComfyInputs()?.image, png.toString("base64"), "the picked picture is the first frame");
  await h.setIllustratorContext(2);

  // ── Roleplay /video: a clip of the latest reply, or of what the user describes, under the newest reply ──
  const { james, bram, personaPng, bramPng } = await h.addPersonaAndBram();
  const pair = await h.createRoleplay("Pair", { characterIds: [bram.id], personaId: james.id });
  await h.saveChatSettings(pair.id, {
    enableAgents: true,
    activeAgentIds: ["illustrator"],
    illustratorRunInterval: 100,
    sceneVideoConnectionId: h.video.id,
    sceneVideoFirstFrame: "prompt_only",
    automaticSummaryEnabled: false,
  });
  replies.main = "Bram ducks.";
  await h.generate(pair.id, "James throws a beaker.");
  replies.main = "Bram laughs.";
  await h.generate(pair.id, "Once more.");
  const roleplayVideo = (chatId: string, description?: string) =>
    h.app.inject({
      method: "POST",
      url: `/api/gallery/${chatId}/roleplay-video`,
      payload: description ? { description } : {},
    });
  const pairReply = (await h.chats.listMessages(pair.id)).filter((message) => message.role === "assistant").at(-1);
  const slashClip = await roleplayVideo(pair.id, "Bottles explode off the shelf");
  assert.equal(slashClip.statusCode, 200, slashClip.body);
  assert.equal((slashClip.json() as { messageId: string }).messageId, pairReply?.id, "under the newest reply");
  assert.match(lastDirector(), /Requested clip: Bottles explode off the shelf/u);
  // It reads as many recent messages as Illustrator does (its context size, 2 here), the latest reply last.
  assert.match(lastDirector(), /Once more\.[\s\S]*Bram laughs\./u);
  assert.doesNotMatch(lastDirector(), /James throws a beaker\./u);
  await h.setIllustratorContext(6);
  assert.equal((await roleplayVideo(pair.id, "Bottles explode off the shelf")).statusCode, 200);
  assert.match(lastDirector(), /James throws a beaker\./u, "a wider context size reaches further back");
  assert.match(h.lastComfyInputs()?.text ?? "", /Bottles burst across the lab floor/u);
  assert.notEqual(h.lastComfyInputs()?.image, bramPng.toString("base64"), "Prompt only sends no picture");
  assert.equal((await h.attachments(pair.id, "video")).length, 2);

  // Avatar first frame: whoever the description names first, the persona included, else the chat's character.
  await h.saveChatSettings(pair.id, { sceneVideoFirstFrame: "avatar" });
  assert.equal((await roleplayVideo(pair.id)).statusCode, 200);
  assert.equal(h.lastComfyInputs()?.image, bramPng.toString("base64"), "no names: the chat's character");
  assert.equal((await roleplayVideo(pair.id, "James slams the door while Bram flinches")).statusCode, 200);
  assert.equal(h.lastComfyInputs()?.image, personaPng.toString("base64"), "the persona, named first");
  assert.equal((await roleplayVideo(pair.id, "Bram hides behind James")).statusCode, 200);
  assert.equal(h.lastComfyInputs()?.image, bramPng.toString("base64"), "the character, named first");

  // A new Illustrator picture is drawn by /illustrate first; the route says so instead of drawing it.
  await h.saveChatSettings(pair.id, { sceneVideoFirstFrame: "picture" });
  assert.deepEqual((await roleplayVideo(pair.id)).json(), { needsPicture: true });
  // Not a Roleplay chat: refused.
  const convo = await h.chats.create({
    name: "Convo",
    mode: "conversation",
    characterIds: [],
    connectionId: h.text.id,
  });
  assert.ok(convo);
  assert.equal((await roleplayVideo(convo.id)).statusCode, 400);

  console.log("roleplay-video-command regression passed");
} finally {
  await h.close();
}
