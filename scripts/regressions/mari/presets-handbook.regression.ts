// #7827: the shipped presets handbook's worked example must actually run, and it must prove the two
// rules the old block got wrong: `sectionOrder` decides inclusion, and a one-section edit through
// `preset.updateSection` leaves the rest of the order intact.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../../packages/server/src/db/file-backed-store.js";
import { loadBuiltinSkills } from "../../../packages/server/src/services/professor-mari/builtin-skills.js";
import { MariDbService } from "../../../packages/server/src/services/mari-db/mari-db.service.js";

const dir = mkdtempSync(join(tmpdir(), "marinara-mari-presets-handbook-"));
process.env.FILE_STORAGE_DIR = dir;

try {
  const { skills } = await loadBuiltinSkills();
  const skill = skills.find((entry) => entry.id === "builtin-presets");
  assert.ok(skill, "the presets handbook ships with the app");

  const commands = skill.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{"action"'))
    .map((line) => JSON.parse(line));
  assert.equal(commands.length, 6, "the worked example has six executable lines");

  const db = await createFileNativeDB();
  try {
    const mari = new MariDbService(db);
    const run = async (index: number) => await mari.executeAction(commands[index]);
    const order = (output) => output.sectionOrder;

    const created = await run(0);
    assert.equal(created.ok, true, "preset.create failed: " + (created.error ?? ""));

    const first = await run(1);
    assert.equal(first.ok, true);
    assert.deepEqual(order(first.output), ["s-card", "s-main"], "sectionOrder lists both sections");

    assert.equal((await run(2)).ok, true, "preset.addChoiceBlock failed");

    const updated = await run(3);
    assert.equal(updated.ok, true, "preset.updateSection failed");

    const section = await run(4);
    assert.equal(section.ok, true);
    assert.match(String(section.output.content), /\{\{pace\}\}/, "the section now reads the new choice");

    const final = await run(5);
    assert.equal(final.ok, true);
    assert.deepEqual(order(final.output), ["s-card", "s-main"], "the single-section edit kept the order");
  } finally {
    await db._fileStore.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("Professor Mari presets handbook regression passed.");
