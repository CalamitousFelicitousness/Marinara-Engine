// The storyteller's [video] Roleplay Command, through the real routes with a fake text model, image service and
// ComfyUI: [video] parses and is offered only when the command is on and a clip may be made; its clip starts from
// the chat's First frame (no picture, or a new Illustrator picture used only as the first frame); and with
// Pictures and clips, a storyteller's [illustrate] is offered the clip fields and can become a clip.
import assert from "node:assert/strict";
import { startRoleplayVideoHarness } from "./fixtures/roleplay-video-harness.js";

const h = await startRoleplayVideoHarness("roleplay-video-tag");
const { replies, requests, png } = h;
const { parseRoleplayCommands, buildRoleplayCommandsReminder } =
  await import("../../packages/server/src/services/generation/roleplay-commands.js");

try {
  // ── Parsing and offer ──
  const parsed = parseRoleplayCommands(
    'Rain. [video: subject="Aster at the window" motion="She turns slowly" characters="Aster"] Done.',
  );
  assert.deepEqual(parsed.commands, [
    { type: "video", subject: "Aster at the window", motion: "She turns slowly", characters: ["Aster"] },
  ]);
  assert.equal(parseRoleplayCommands('[video: motion="no subject"]').invalid, 1, "a clip needs a subject");
  const reminderMeta = {
    roleplayCommandsEnabled: true,
    roleplayCommandToggles: { video: true },
    activeAgentIds: ["illustrator"],
  };
  const reminder = (video: { instructions: string } | null, metadata = reminderMeta) =>
    buildRoleplayCommandsReminder({
      metadata,
      privateAvailable: false,
      availableAgentIds: new Set(["illustrator"]),
      format: "xml",
      characterNames: ["Aster"],
      video,
    });
  assert.match(reminder({ instructions: "" }), /\[video: subject=/u);
  assert.match(
    reminder({ instructions: "" }),
    /Use \[video\] rather than \[illustrate\] when the moment is about motion/u,
  );
  assert.match(reminder({ instructions: "Keep it slow." }), /Keep it slow\./u, "the video connection's instructions");
  assert.doesNotMatch(reminder(null), /\[video:/u, "not offered while no clip may be made");
  assert.doesNotMatch(
    reminder({ instructions: "" }, { ...reminderMeta, roleplayCommandToggles: { video: false } }),
    /\[video:/u,
    "not offered when the command is off",
  );

  // ── [video] end to end ──
  const roleplay = await h.createRoleplay("Roleplay");
  await h.saveChatSettings(roleplay.id, {
    enableAgents: true,
    activeAgentIds: ["illustrator"],
    roleplayCommandsEnabled: true,
    roleplayCommandToggles: { video: true },
    illustratorUseAvatarReferences: false,
    illustratorIncludeCharacterAppearance: false,
    illustratorRunInterval: 1,
    illustratorVideoRunInterval: 1,
    sceneVideoConnectionId: h.video.id,
    sceneVideoFirstFrame: "prompt_only",
    automaticSummaryEnabled: false,
  });
  const command = '[video: subject="Aster at the window" motion="She turns slowly as rain streaks the glass"]';

  // Prompt only: the storyteller is offered [video], and its clip starts from no picture.
  replies.main = `Aster waits. ${command}`;
  await h.generate(roleplay.id, "Aster looks outside.");
  assert.match(requests.reply.at(-1) ?? "", /\[video: subject=/u, "the storyteller is offered [video]");
  assert.equal((await h.attachments(roleplay.id, "video")).length, 1);
  assert.match(h.lastComfyInputs()?.text ?? "", /She turns slowly as rain streaks the glass/u);
  assert.notEqual(h.lastComfyInputs()?.image, png.toString("base64"), "prompt only sends no picture");
  assert.equal(requests.images, 0, "no Illustrator picture for a prompt-only clip");

  // New Illustrator picture: Illustrator draws the moment, and that picture is animated with the motion.
  await h.saveChatSettings(roleplay.id, { sceneVideoFirstFrame: "picture" });
  await h.generate(roleplay.id, "Aster turns around.");
  assert.equal(requests.images, 1, "Illustrator drew the first frame");
  assert.equal((await h.attachments(roleplay.id, "image")).length, 0, "the picture is only the clip's first frame");
  assert.equal((await h.attachments(roleplay.id, "video")).length, 2);
  assert.match(h.lastComfyInputs()?.text ?? "", /She turns slowly as rain streaks the glass/u);
  assert.equal(h.lastComfyInputs()?.image, png.toString("base64"), "the clip starts from Illustrator's picture");

  // Command off: no offer and no clip.
  await h.saveChatSettings(roleplay.id, { roleplayCommandToggles: { video: false } });
  await h.generate(roleplay.id, "Aster waits.");
  assert.doesNotMatch(requests.reply.at(-1) ?? "", /\[video: subject=/u, "not offered when the command is off");
  assert.equal((await h.attachments(roleplay.id, "video")).length, 2, "no clip when the command is off");

  // ── [illustrate] can become a clip: with Pictures and clips, its planner is offered the clip fields ──
  await h.saveChatSettings(roleplay.id, {
    illustratorVideoMode: "pictures_and_clips",
    roleplayCommandToggles: { illustrate: true, video: true },
  });
  replies.planner = {
    prompt: "bottles shattering across a dim lab",
    generateVideo: true,
    videoPrompt: "Bottles shatter and spin through the air",
  };
  replies.main = 'Glass everywhere. [illustrate: subject="bottles flying off the counter"]';
  await h.generate(roleplay.id, "James throws the bottles.");
  assert.match(
    requests.planner.at(-1) ?? "",
    /If motion is the point of this moment/u,
    "the planner is offered a clip",
  );
  assert.equal((await h.attachments(roleplay.id, "video")).length, 3, "[illustrate] became a clip");
  assert.match(h.lastComfyInputs()?.text ?? "", /Bottles shatter and spin through the air/u);
  assert.equal(h.lastComfyInputs()?.image, png.toString("base64"), "it animates the shown picture");
  // With Pictures only, the planner is not offered a clip.
  await h.saveChatSettings(roleplay.id, { illustratorVideoMode: "pictures" });
  replies.planner = { prompt: "an empty lab" };
  replies.main = 'Silence. [illustrate: subject="the empty lab"]';
  await h.generate(roleplay.id, "Look around.");
  assert.doesNotMatch(requests.planner.at(-1) ?? "", /If motion is the point of this moment/u);
  assert.equal((await h.attachments(roleplay.id, "video")).length, 3);

  console.log("roleplay-video-tag regression passed");
} finally {
  await h.close();
}
