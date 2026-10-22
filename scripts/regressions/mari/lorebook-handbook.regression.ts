// #7827: the shipped lorebook handbook claims specific API behaviour, and a handbook that teaches
// the wrong `apply` default or a nonexistent action is worse than no handbook. This runs its worked
// example — the five `{"action":…}` lines — against a real temporary database, then pins the two
// corrections the old permanent block got wrong:
//   - creates apply unless `apply:false`, updates preview unless `apply:true`;
//   - there is no `lorebook.delete` app_data action (the CLI is the only route to a book delete).
// It also runs the two activation claims against a real chat: `preventRecursion` defaults to true, so
// turning on the book's recursion alone changes nothing; and `testScan` with an `entryId` names why an
// entry that fires too often fired (its source and the key that matched).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../../packages/server/src/db/file-backed-store.js";
import { loadBuiltinSkills } from "../../../packages/server/src/services/professor-mari/builtin-skills.js";
import { MariDbService } from "../../../packages/server/src/services/mari-db/mari-db.service.js";
import { createChatsStorage } from "../../../packages/server/src/services/storage/chats.storage.js";

type Result = {
  ok?: boolean;
  mode?: string;
  error?: string;
  output?: Record<string, unknown> | null;
  readBack?: { status?: string };
};

const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
const dir = mkdtempSync(join(tmpdir(), "marinara-mari-lorebook-handbook-"));
process.env.FILE_STORAGE_DIR = dir;

try {
  const { skills } = await loadBuiltinSkills();
  const skill = skills.find((entry) => entry.id === "builtin-lorebook");
  assert.ok(skill, "the lorebook handbook ships with the app");

  const commands = skill.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{"action"'))
    .map((line) => JSON.parse(line) as { action: string; [key: string]: unknown });
  assert.equal(commands.length, 5, `the worked example has five executable lines (found ${commands.length})`);

  const db = await createFileNativeDB();
  try {
    const mari = new MariDbService(db);
    const run = async (index: number) => (await mari.executeAction(commands[index]!)) as Result;

    // 1. Create the book and its entries in one call, with no `apply` — creates write by default.
    const created = await run(0);
    assert.equal(created.ok, true, `lorebook.create failed: ${created.error ?? ""}`);

    // 2. Add the group alternate under a chosen entry id.
    const added = await run(1);
    assert.equal(added.ok, true, `lorebook.addEntry failed: ${added.error ?? ""}`);

    // 3. The proof reads the handbook tells her to make.
    const book = await run(2);
    assert.equal(book.ok, true);
    assert.equal(book.output?.entryCount, 4, "lorebook.get reports the four entries");

    const page = await run(3);
    assert.equal(page.ok, true);
    assert.equal(page.output?.total, 4, "lorebook.entries totals four");
    assert.equal(page.output?.nextOffset, 2, "a limit of 2 leaves a second page");
    assert.equal((page.output?.items as unknown[]).length, 2);

    const entry = await run(4);
    assert.equal(entry.ok, true);
    assert.equal(entry.output?.group, "coast-rumor", "the alternate landed in the group");
    assert.equal(String(entry.output?.groupWeight), "30");
    assert.equal(entry.output?.probability ?? null, null, "the example leaves probability at its default");
    for (const command of commands.slice(0, 2)) {
      const sent = JSON.stringify(command);
      for (const field of ["probability", "sticky", "cooldown", "delay", "ephemeral", "position", "depth"]) {
        assert.ok(!sent.includes(`"${field}"`), `the example leaves ${field} at its default`);
      }
    }

    // The most consequential correction in the handbook: updates preview unless `apply:true`.
    const dryRun = (await mari.executeAction({
      action: "lorebook.update",
      lorebookId: "lantern-coast",
      patch: { description: "dry run only" },
    })) as Result;
    assert.equal(dryRun.mode, "dry-run", "an update without apply:true is a dry run");
    const afterDryRun = await mari.executeAction({ action: "lorebook.get", lorebookId: "lantern-coast" });
    assert.equal((afterDryRun.output as Record<string, unknown>).description, "", "the dry run wrote nothing");

    const applied = (await mari.executeAction({
      action: "lorebook.update",
      lorebookId: "lantern-coast",
      patch: { description: "A fog-bound coast." },
      apply: true,
    })) as Result;
    assert.equal(applied.ok, true);
    const afterApply = await mari.executeAction({ action: "lorebook.get", lorebookId: "lantern-coast" });
    assert.equal((afterApply.output as Record<string, unknown>).description, "A fog-bound coast.");

    // The handbook says `lorebook.delete` does not exist and returns exactly this. Pin both halves.
    const bookDelete = (await mari.executeAction({ action: "lorebook.delete", lorebookId: "lantern-coast" })) as Result;
    assert.equal(bookDelete.ok, false);
    assert.match(String(bookDelete.error), /Unknown lorebook action "delete"\./);
    assert.ok(
      skill.content.includes('Unknown lorebook action "'),
      "the handbook quotes the refusal it will actually get",
    );

    // Recursion is inverted: the book switch alone lets nothing trigger anything.
    const chats = createChatsStorage(db);
    const chat = await chats.create({ name: "Lorebook handbook", mode: "roleplay", characterIds: [] });
    await chats.createMessage({ chatId: chat!.id, role: "user", content: "We walk down to the harbor at dusk." });
    const recursionBook = (await mari.executeAction({
      action: "lorebook.create",
      lorebookId: "harbor-town",
      data: {
        name: "Harbor Town",
        recursive: true,
        entries: [
          { name: "Harbor", content: "The Gilded Gull tavern sits on the harbor.", keys: ["harbor"] },
          { name: "The Gilded Gull", content: "Smoke, fiddles, cheap rum.", keys: ["Gilded Gull"] },
          { name: "Fog law", content: "Fog rises every dusk.", constant: true, keys: [] },
        ],
      },
    })) as Result;
    assert.equal(recursionBook.ok, true, `the recursion fixture book failed: ${recursionBook.error ?? ""}`);
    // Entries saved inside a create get generated ids; the handbook says to read them back.
    const listed = (await mari.executeAction({ action: "lorebook.entries", lorebookId: "harbor-town" })) as Result;
    const idOf = Object.fromEntries(
      ((listed.output?.items ?? []) as Array<{ id: string; name: string }>).map((row) => [row.name, row.id]),
    );
    assert.ok(!["Harbor", "The Gilded Gull", "Fog law"].includes(idOf.Harbor!), "an embedded entry id is generated");
    const scan = async (entryId: string) =>
      (
        (await mari.executeAction({
          action: "lorebook.testScan",
          lorebookId: "harbor-town",
          chatId: chat!.id,
          entryId,
        })) as Result
      ).output as { status?: string; activationSources?: string[]; matchedKeys?: string[]; triggeredBy?: string[] };
    const harbor = await mari.executeAction({ action: "lorebook.getEntry", entryId: idOf.Harbor });
    assert.equal(
      String((harbor.output as Record<string, unknown>).preventRecursion),
      "true",
      "preventRecursion defaults to true",
    );
    assert.notEqual(
      (await scan(idOf["The Gilded Gull"]!)).status,
      "activated",
      "recursion on the book alone triggers nothing",
    );

    const opened = (await mari.executeAction({
      action: "lorebook.updateEntry",
      entryId: idOf.Harbor,
      patch: { preventRecursion: false },
      apply: true,
    })) as Result;
    assert.equal(opened.ok, true);
    const gull = await scan(idOf["The Gilded Gull"]!);
    assert.equal(gull.status, "activated", "preventRecursion:false on the triggering entry lets it trigger others");
    assert.deepEqual(gull.activationSources, ["recursive"]);
    assert.deepEqual(gull.triggeredBy, [idOf.Harbor], "triggeredBy names the entry whose content holds the key");

    // Over-firing: testScan with an entryId names the source and the key that matched.
    const fired = await scan(idOf.Harbor!);
    assert.equal(fired.status, "activated");
    assert.deepEqual(fired.activationSources, ["keyword"]);
    assert.deepEqual(fired.matchedKeys, ["harbor"], "matchedKeys shows the key that fired it");
    assert.deepEqual((await scan(idOf["Fog law"]!)).activationSources, ["constant"], "a constant entry says so");
    for (const phrase of ["`preventRecursion` is inverted and defaults to `true`", "Why an entry fires too often"]) {
      assert.ok(skill.content.includes(phrase), `the handbook teaches: ${phrase}`);
    }
  } finally {
    await db._fileStore.close();
  }
} finally {
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(dir, { recursive: true, force: true });
}

console.log("Professor Mari lorebook handbook regression passed.");
