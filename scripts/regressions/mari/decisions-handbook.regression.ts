// #7827: the decisions handbook replaces a 6,350-character permanent-prompt constant, so it has to
// keep the whole contract that constant carried — both macro forms, the comparison form, both gates,
// and the levers the constant never mentioned — while dropping the one rule the constant got wrong.
// The worked example runs end to end against a temp DB with no Decision model: the first turn warns
// and stops (a write there is refused even in an ordinary, non-depth section), and the second turn's
// records quote the user's reply, not the request that never saw the warning.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mari-decisions-handbook-"));
const savedEnv = { DATA_DIR: process.env.DATA_DIR, FILE_STORAGE_DIR: process.env.FILE_STORAGE_DIR };
process.env.DATA_DIR = dir;
process.env.FILE_STORAGE_DIR = join(dir, "storage");
const { loadBuiltinSkills } = await import("../../../packages/server/src/services/professor-mari/builtin-skills.js");
const { createFileNativeDB } = await import("../../../packages/server/src/db/file-backed-store.js");
const { MariDbService } = await import("../../../packages/server/src/services/mari-db/mari-db.service.js");
const { createChatsStorage } = await import("../../../packages/server/src/services/storage/chats.storage.js");
const { executeMariDecisionAction, withMariDecisionContext } =
  await import("../../../packages/server/src/services/professor-mari/decision-authoring.js");

const { skills } = await loadBuiltinSkills();
const skill = skills.find((entry) => entry.id === "builtin-decisions");
assert.ok(skill, "the decisions handbook ships with the app");
const text = skill.content;

type Command = Record<string, unknown> & { action: string; data?: Record<string, unknown> };
// The example is two turns: one fenced block each.
const fenced: string[][] = [];
let open: string[] | null = null;
for (const line of text.split(/\r?\n/).map((entry) => entry.trim())) {
  if (line.startsWith("```")) {
    if (open) fenced.push(open);
    open = open ? null : [];
  } else open?.push(line);
}
const blocks = fenced
  .map((block) => block.filter((line) => line.startsWith('{"action"')).map((line) => JSON.parse(line) as Command))
  .filter((block) => block.length > 0);
assert.equal(blocks.length, 2, "the worked example is two turns");
const [first, second] = blocks as [Command[], Command[]];
assert.deepEqual(
  first.map((command) => command.action),
  ["decision.get", "decision.record"],
  "the first turn checks the model and records the question, then stops",
);
assert.equal(first[1]!.data?.answer, "pending");
assert.equal(second.length, 8, "the second turn records, writes and reads back");
assert.ok(!text.includes("<id returned"), "the example has no unfilled placeholder");
assert.ok(text.includes('"lorebookId":"lore-decision-pacing"'), "the lorebook id is pinned in the example");

// The syntax is the contract: get it wrong and the decision silently never matches.
assert.ok(text.includes('{{#if decision:"'), "the decision form is taught");
assert.ok(text.includes('decision_choice:"'), "the choice form is taught");
assert.ok(text.includes('== "'), "the option comparison is taught");

// The levers and limits the old constant never mentioned.
for (const token of ["priority:", "until:", "while:", "none of these", "decision-prompt-question-limit"]) {
  assert.ok(text.includes(token), `the handbook still teaches ${token}`);
}
// Two gates, taught apart: decision content anywhere, and history placement with or without decisions.
assert.ok(text.includes("injectionPosition"), "the gated section shape is named");
assert.ok(text.includes("position: 2"), "the gated lorebook position is named");
assert.ok(!text.includes("three gated shapes"), "decision syntax is not described as gated only at depth");
assert.ok(text.includes('even with `decisionMode: "off"`'), "a drafted statement counts while off");
assert.ok(text.includes("Preserve existing Decisions"), "unrelated edits keep the user's Decisions");

// The constant's wrong rule must not survive the move.
assert.ok(
  !text.includes("Without a selected model, ordinary authoring introduces no Decision content"),
  "the corrected permission rule replaced the old one",
);

try {
  const db = await createFileNativeDB();
  try {
    const mari = new MariDbService(db);
    const chats = createChatsStorage(db);
    const chat = await chats.create({
      name: "Decisions handbook",
      mode: "conversation",
      characterIds: [],
      promptPresetId: null,
      connectionId: null,
    });
    assert.ok(chat);
    let context = { db, chatId: chat.id, userMessageId: "" };
    const turn = async (content: string) => {
      const message = await chats.createMessage({ chatId: chat.id, role: "user", content });
      assert.ok(message);
      context = { ...context, userMessageId: message.id };
    };
    type Result = { ok: boolean; error?: string; output?: unknown };
    const run = (command: Command): Promise<Result> =>
      withMariDecisionContext(context, async () => {
        if (command.action.startsWith("decision.")) {
          return { ok: true, output: await executeMariDecisionAction(command.action, command.data) };
        }
        return (await mari.executeAction(command)) as Result;
      });
    const quoted = (block: Command[]) =>
      block.find((command) => command.action === "decision.record" && command.data?.quote)?.data?.quote as string;

    // Turn one: the user's request, with no Decision model selected.
    await turn("Use Decisions for this chat and add the pacing preset.");
    const status = (await run(first[0]!)).output as { model: { state: string } };
    assert.notEqual(status.model.state, "selected", "the example's precondition holds");
    await run(first[1]!);
    const presetCreate = second.find((command) => command.action === "preset.create")!;
    const early = await run(presetCreate);
    assert.equal(early.ok, false, "a decision in an ordinary (non-depth) section is gated before the reply");
    assert.match(String(early.error), /decision\.record \(authoring\)/);

    // Turn two: the user's reply to the warning.
    const reply = quoted(second);
    assert.ok(reply && !"Use Decisions for this chat and add the pacing preset.".includes(reply));
    await turn(reply);
    for (const command of second) {
      const result = await run(command);
      assert.equal(result.ok, true, `${command.action} failed: ${String(result.error ?? "")}`);
    }
    const final = (await run(second[second.length - 1]!)).output as {
      interactions: Record<string, { answer: string } | undefined>;
    };
    assert.equal(final.interactions.authoring?.answer, "allow");
    assert.equal(final.interactions.setupReminder?.answer, "allow");
  } finally {
    await db._fileStore.close();
  }
} finally {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log("Professor Mari decisions handbook regression passed.");
