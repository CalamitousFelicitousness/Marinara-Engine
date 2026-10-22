// #7827: Home widget creates are dry runs unless apply:true — the opposite of every other create,
// and the single most likely thing for Mari to get wrong. This executes the handbook's example (list,
// applied create, list) and pins that the create makes exactly one card. The dry run runs here as a
// fixture, never as an example line she could copy as a "preview round": it saves nothing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../../packages/server/src/db/file-backed-store.js";
import { loadBuiltinSkills } from "../../../packages/server/src/services/professor-mari/builtin-skills.js";
import { MariDbService } from "../../../packages/server/src/services/mari-db/mari-db.service.js";

type Output = { widgets?: Array<{ title?: string }> } | Array<{ title?: string }>;

const dir = mkdtempSync(join(tmpdir(), "marinara-mari-widgets-handbook-"));
process.env.FILE_STORAGE_DIR = dir;

try {
  const { skills } = await loadBuiltinSkills();
  const skill = skills.find((entry) => entry.id === "builtin-home-widgets");
  assert.ok(skill, "the home widgets handbook ships with the app");

  const commands = skill.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{"action"'))
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    commands.map((command) => command.action),
    ["home_widget.list", "home_widget.create", "home_widget.list"],
    "the example is read, applied create, read back — no dry-run line",
  );
  assert.equal(commands[1].apply, true, "the example's create is applied");
  assert.ok(
    skill.content.includes("set `awaitingAuthorization: true` so Marinara holds the create for the user's Accept"),
    "a create is held for the user's Accept, in Auto mode too",
  );

  const db = await createFileNativeDB();
  try {
    const mari = new MariDbService(db);

    const widgetsOf = (output: Output) => (Array.isArray(output) ? output : (output.widgets ?? []));

    const before = await mari.executeAction(commands[0]!);
    assert.equal(before.ok, true);
    assert.equal(widgetsOf(before.output as Output).length, 0, "the catalog starts empty");

    // Fixture: the same create without apply is a dry run that saves nothing.
    const previewCommand = { ...commands[1]! };
    delete previewCommand.apply;
    const preview = await mari.executeAction(previewCommand);
    assert.equal(preview.ok, true);
    assert.equal(preview.mode, "dry-run", "a create without apply saves nothing");

    const applied = await mari.executeAction(commands[1]!);
    assert.equal(applied.ok, true);

    const listed = await mari.executeAction(commands[2]!);
    const widgets = widgetsOf(listed.output as Output);
    assert.equal(widgets.length, 1, "only the applied create made a card");
    assert.equal(widgets[0]?.title, "Field Formula");
  } finally {
    await db._fileStore.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("Professor Mari home widgets handbook regression passed.");
