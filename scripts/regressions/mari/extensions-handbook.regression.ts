// #7827: the extensions handbook teaches a hash contract, and a wrong hash rule is worse than no
// handbook: it would tell Mari her edit is approved when the user must review it again, or the
// reverse. This executes the worked example against a temporary database and pins the three things
// the document claims: the create produces the documented hash, a description edit does not move it,
// and a css edit does.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../../packages/server/src/db/file-backed-store.js";
import { loadBuiltinSkills } from "../../../packages/server/src/services/professor-mari/builtin-skills.js";
import { MariDbService } from "../../../packages/server/src/services/mari-db/mari-db.service.js";

const PINNED_HASH = "sha256:677e787ceec71951f8e9fd14182ad7b3bc877b55cf0485b84948073de6242533";

const dir = mkdtempSync(join(tmpdir(), "marinara-mari-extensions-handbook-"));
process.env.FILE_STORAGE_DIR = dir;

try {
  const { skills } = await loadBuiltinSkills();
  const skill = skills.find((entry) => entry.id === "builtin-extensions");
  assert.ok(skill, "the extensions handbook ships with the app");

  const commands = skill.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{"action"'))
    .map((line) => JSON.parse(line) as { action: string });
  assert.equal(commands.length, 6, "the example is create, read, rename, read, restyle, read");

  const db = await createFileNativeDB();
  try {
    const mari = new MariDbService(db);
    const run = async (index: number) => await mari.executeAction(commands[index]!);

    const created = await run(0);
    assert.equal(created.ok, true, `personal_extension.create failed: ${String(created.error ?? "")}`);

    const drafted = await run(1);
    assert.equal(drafted.ok, true);
    assert.equal(drafted.output?.contentHash, PINNED_HASH, "the create produces the hash the handbook quotes");
    assert.equal(String(drafted.output?.enabled), "false", "a drafted extension starts disabled");
    assert.ok(
      drafted.output?.approvedHash == null || drafted.output.approvedHash === "",
      "nothing is approved before the user reviews it",
    );

    assert.equal((await run(2)).ok, true, "the description edit failed");

    const renamed = await run(3);
    assert.equal(renamed.output?.contentHash, PINNED_HASH, "changing the description does not move the hash");

    assert.equal((await run(4)).ok, true, "the css edit failed");

    const restyled = await run(5);
    assert.notEqual(restyled.output?.contentHash, PINNED_HASH, "changing css moves the hash and needs a new review");
  } finally {
    await db._fileStore.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("Professor Mari extensions handbook regression passed.");
