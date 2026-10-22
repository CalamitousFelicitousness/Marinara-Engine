// #7827: the shipped reply-diagnosis handbook must keep the two things that make a repair honest:
// the reply is READ before it is rewritten (chat.diagnose returns no text), and the repair is
// applied rather than left as an invisible dry run. It also corrects two things the old permanent
// prompt got wrong — the user-facing card says Undo, not "Keep/Restore" — and must keep teaching
// every finding code. The worked example runs against a temp DB: `chat.messages` ignores
// `messageId`, so a read "by id" returned the whole chat instead of the reply being repaired.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../../packages/server/src/db/file-backed-store.js";
import { loadBuiltinSkills } from "../../../packages/server/src/services/professor-mari/builtin-skills.js";
import { MariDbService } from "../../../packages/server/src/services/mari-db/mari-db.service.js";
import { createChatsStorage } from "../../../packages/server/src/services/storage/chats.storage.js";

const { skills } = await loadBuiltinSkills();
const skill = skills.find((entry) => entry.id === "builtin-repair");
assert.ok(skill, "the reply diagnosis handbook ships with the app");
const text = skill.content;

type Command = Record<string, unknown> & { action?: string; messageId?: string; apply?: boolean };
type Row = { postNumber: number; id: string; content: string };
type Result = { ok?: boolean; error?: string; output?: unknown; approval?: { status?: string } };

const commands = text
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.startsWith('{"action"'))
  .map((line) => JSON.parse(line) as Command);

assert.equal(commands.length, 4, "the worked example has four executable lines");
assert.deepEqual(
  commands.map((command) => command.action),
  ["chat.diagnose", "chat.messages", "chat.updateMessage", "chat.messages"],
  "the order is diagnose, read the reply, repair, verify",
);
assert.equal(commands[2]!.apply, true, "the repair is applied, not left as a dry run the user cannot see");
assert.equal(commands[2]!.messageId, commands[0]!.messageId, "the repair targets the reply that was diagnosed");
for (const index of [1, 3]) {
  assert.equal(commands[index]!.messageId, undefined, "chat.messages has no messageId argument; it reads by post");
}

// The card a user sees says Undo; "Keep/Restore" was internal jargon in the draft.
assert.ok(text.includes("Undo card"), "the handbook names the card the user actually sees");
assert.ok(!text.includes("Keep/Restore"), "the internal keep/restore wording is gone");

// Every finding code stays taught, and a dry run is named as the trap it is.
for (const code of [
  "cut_off",
  "empty_reply",
  "history_trimmed",
  "reply_budget_cut",
  "lore_budget_skipped",
  "card_large",
]) {
  assert.ok(text.includes(code), `the handbook still teaches ${code}`);
}
assert.ok(text.includes("apply: true"), "the handbook tells her to send apply:true");

// The answer shape the old permanent prompt fixed, restored: one cause with its number, one fix.
for (const phrase of ["ONE cause with its real number first", "at most three short bullets", "ONE fix", "no hedging"]) {
  assert.ok(text.includes(phrase), `the report shape keeps "${phrase}"`);
}

const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
const dir = mkdtempSync(join(tmpdir(), "marinara-mari-repair-handbook-"));
process.env.FILE_STORAGE_DIR = dir;

try {
  const db = await createFileNativeDB();
  try {
    const chats = createChatsStorage(db);
    const mari = new MariDbService(db);
    const chat = await chats.create({ name: "Repair handbook", mode: "roleplay", characterIds: ["character-a"] });
    // Several posts, so a read that returns the whole chat cannot pass for a read of one reply.
    const posts = [
      { role: "user", content: "How many ships were there?" },
      { role: "assistant", content: "She thinks about it for a long moment." },
      { role: "user", content: "Well?" },
      { role: "assistant", content: 'She sets the glass down and finally answers you. "Twelve ships," she sa' },
    ] as const;
    const ids: string[] = [];
    for (const post of posts) {
      const created = await chats.createMessage({ chatId: chat.id, role: post.role, content: post.content });
      ids.push(created!.id);
    }
    const newestId = ids[ids.length - 1]!;

    // The example's ids stand for this chat and its newest reply.
    const bind = (command: Command): Command => ({
      ...command,
      chatId: chat.id,
      ...(command.messageId ? { messageId: newestId } : {}),
    });
    const run = async (index: number) => (await mari.executeAction(bind(commands[index]!))) as Result;
    const rowsOf = (result: Result) => (result.output as { messages: Row[] }).messages;

    const diagnosed = await run(0);
    assert.equal(diagnosed.ok, true, `chat.diagnose failed: ${String(diagnosed.error ?? "")}`);
    assert.equal((diagnosed.output as { messageId?: string }).messageId, newestId);

    const read = await run(1);
    assert.equal(read.ok, true, `the reply read failed: ${String(read.error ?? "")}`);
    assert.equal(rowsOf(read).length, 1, "the read returns the one reply, not the chat");
    assert.equal(rowsOf(read)[0]!.id, newestId, "the read returns the reply that was diagnosed");
    assert.equal(rowsOf(read)[0]!.content, posts[3].content);

    const repaired = await run(2);
    assert.equal(repaired.ok, true, `chat.updateMessage failed: ${String(repaired.error ?? "")}`);
    assert.equal(repaired.approval?.status, "pending");

    const verified = await run(3);
    assert.equal(rowsOf(verified)[0]!.id, newestId);
    assert.equal(rowsOf(verified)[0]!.content, commands[2]!.content, "the verify read shows the repaired swipe");

    // The older-post path the workflow teaches: afterPost = postNumber - 1, limit 1.
    const older = (await mari.executeAction({
      action: "chat.messages",
      chatId: chat.id,
      afterPost: 1,
      limit: 1,
    })) as Result;
    assert.deepEqual(
      rowsOf(older).map((row) => [row.postNumber, row.id]),
      [[2, ids[1]]],
      "afterPost reads exactly the named older post",
    );

    // Why the old example was wrong: messageId is ignored and the whole chat comes back.
    const byId = (await mari.executeAction({ action: "chat.messages", chatId: chat.id, messageId: ids[1] })) as Result;
    assert.equal(rowsOf(byId).length, posts.length, "chat.messages ignores messageId");
  } finally {
    await db._fileStore.close();
  }
} finally {
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(dir, { recursive: true, force: true });
}

console.log("Professor Mari reply diagnosis handbook regression passed.");
