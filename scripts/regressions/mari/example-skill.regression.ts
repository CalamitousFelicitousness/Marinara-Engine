// The example Professor Mari skill is seeded once, disabled, and never comes back after a delete.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mari-example-skill-"));
const savedDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dir;
const { ProfessorMariWorkspaceSkillsService } =
  await import("../../../packages/server/src/services/professor-mari/workspace-skills.service.js");
const { renderMariSkillsPrompt } =
  await import("../../../packages/server/src/services/professor-mari/mari-skills-prompt.js");

try {
  const service = new ProfessorMariWorkspaceSkillsService();
  // Two first calls at once still seed one skill.
  const [{ skills }] = await Promise.all([service.list(), new ProfessorMariWorkspaceSkillsService().list()]);
  // Shipped skills come first and are always on; the example is a normal user skill after them.
  const builtinIds = [
    "builtin-characters",
    "builtin-decisions",
    "builtin-extensions",
    "builtin-home-widgets",
    "builtin-lorebook",
    "builtin-onboarding",
    "builtin-presets",
    "builtin-repair",
    "builtin-themes",
  ];
  assert.deepEqual(
    skills.map((skill) => skill.id),
    [...builtinIds, "ask-before-building"],
  );
  const example = skills.find((skill) => skill.id === "ask-before-building");
  assert.equal(example?.enabled, false, "the example ships disabled");
  assert.match(example!.content, /`suggestions`/);
  const rendered = renderMariSkillsPrompt(skills);
  assert.ok(rendered && !rendered.includes("ask-before-building"), "a disabled example adds nothing to the prompt");

  await service.delete("ask-before-building");
  assert.deepEqual(
    (await service.list()).skills.map((skill) => skill.id),
    builtinIds,
    "a deleted example is not seeded again",
  );
} finally {
  if (savedDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = savedDataDir;
  rmSync(dir, { recursive: true, force: true });
}
