// #7827: the character authoring traps are all silent — the wrong storage location, a `null`
// "clear" that is dropped, and a read-back that proves persistence rather than intent. This executes
// the handbook's example (the whole card in one create, then an About Me patch) and pins that every
// field lands where the app reads it. The traps run here as fixtures, never as example lines she could
// copy: a null probe changes nothing, and a name-only placeholder saves, which is why the handbook forbids it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../../packages/server/src/db/file-backed-store.js";
import { loadBuiltinSkills } from "../../../packages/server/src/services/professor-mari/builtin-skills.js";
import { MariDbService } from "../../../packages/server/src/services/mari-db/mari-db.service.js";

type Card = {
  comment?: string;
  data?: Record<string, unknown> & { extensions?: Record<string, unknown> & { aboutMe?: string } };
};
type Result = { ok?: boolean; mode?: string; error?: string; output?: unknown; readBack?: { status?: string } };

const dir = mkdtempSync(join(tmpdir(), "marinara-mari-characters-handbook-"));
process.env.FILE_STORAGE_DIR = dir;

try {
  const { skills } = await loadBuiltinSkills();
  const skill = skills.find((entry) => entry.id === "builtin-characters");
  assert.ok(skill, "the characters handbook ships with the app");

  const commands = skill.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{"action"'))
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    commands.map((command) => command.action),
    ["character.create", "character.update", "character.get"],
    "the example is the whole-card create, the About Me patch and the read-back — no probe line",
  );
  assert.equal(commands[2].field, undefined, "character.get has no field selector");
  assert.equal(commands[0].apply, undefined, "the create relies on creates writing by default");
  for (const field of ["name", "description", "personality", "firstMes", "backstory", "appearance", "aboutMe"]) {
    assert.ok(commands[0].data[field], `the create carries the full card, including ${field}`);
  }

  const db = await createFileNativeDB();
  try {
    const mari = new MariDbService(db);
    const run = async (index: number) => (await mari.executeAction(commands[index]!)) as Result;
    const readCard = async (): Promise<Card> => {
      const result = await run(2);
      assert.equal(result.ok, true);
      const output = result.output as Record<string, unknown>;
      return (output.character as Card) ?? (output as Card);
    };

    const created = await run(0);
    assert.equal(created.ok, true, `character.create failed: ${String(created.error ?? "")}`);
    assert.equal(created.readBack?.status, "verified", "a create without apply writes and verifies");
    // A model that learned "fields go in data" nests the search query; the read must still resolve,
    // because the refusal cost two dead retries live (#7949).
    const searched = (await mari.executeAction({
      action: "character.search",
      data: { query: String((commands[0]!.data as Record<string, unknown>).name) },
    })) as Result;
    assert.equal(searched.ok, true, `character.search with data.query failed: ${String(searched.error ?? "")}`);

    // A card named with quotes must be findable by the name a user types, quotes included:
    // JSON.stringify escapes them, so the old raw-substring filter missed its own card.
    const name = String((commands[0]!.data as Record<string, unknown>).name);
    const quoted = (await mari.executeAction({ action: "character.search", query: `"${name}"` })) as Result;
    assert.equal(quoted.ok, true);
    assert.equal((quoted.output as unknown[]).length, 1, "a quoted search finds the card it names");

    // A hallucinated slug is refused with the real shape and the lookup, not a bare "not found".
    const bogus = (await mari.executeAction({
      action: "character.update",
      characterId: "elspeth-macrae",
      data: { summary: "x" },
    })) as Result;
    assert.equal(bogus.ok, false);
    assert.match(String(bogus.error), /No character has the id "elspeth-macrae"/);
    assert.match(String(bogus.error), /character\.search/);

    const card = await readCard();
    const sent = commands[0].data;
    assert.equal(card.data?.description, sent.description);
    assert.equal(card.data?.personality, sent.personality);
    assert.equal(card.data?.first_mes, sent.firstMes, "firstMes is stored as first_mes");
    assert.equal(card.data?.extensions?.backstory, sent.backstory, "backstory lives under extensions");
    assert.equal(card.data?.extensions?.appearance, sent.appearance, "appearance lives under extensions");
    assert.equal(card.data?.extensions?.aboutMe, sent.aboutMe, "aboutMe lives under extensions");
    assert.equal(card.comment, sent.comment, "comment is the row column");

    const patched = await run(1);
    assert.equal(patched.ok, true, `the About Me patch failed: ${String(patched.error ?? "")}`);
    const expected = String(commands[1].patch.aboutMe);
    assert.equal((await readCard()).data?.extensions?.aboutMe, expected, "the About Me patch landed");

    // Fixture, not an example line: null is not a clear — it is dropped before the patch is built.
    const probe = (await mari.executeAction({
      action: "character.update",
      characterId: commands[0].characterId,
      patch: { aboutMe: null },
      reason: "Probe: null is not a clear",
      apply: true,
    })) as Result;
    assert.notEqual(probe.ok, true, "a null-only patch is refused, not applied");
    assert.match(String(probe.error), /character\.update needs a patch field such as/u);
    assert.equal((await readCard()).data?.extensions?.aboutMe, expected, "the null probe cleared nothing");

    // Fixture: only `name` is enforced, so a placeholder saves and verifies. The handbook forbids it.
    const placeholder = (await mari.executeAction({
      action: "character.create",
      data: { name: "Placeholder" },
    })) as Result;
    assert.equal(placeholder.ok, true, "a name-only create is accepted — the handbook is the only guard");
    assert.ok(skill.content.includes("never make one"), "the handbook forbids the name-only placeholder");

    // Linking is bidirectional, so the form has to be in both handbooks: asking from the character side
    // used to reach a sentence that named the command without its shape, and she guessed positional args.
    const lorebookSkill = skills.find((entry) => entry.id === "builtin-lorebook");
    assert.ok(lorebookSkill, "the lorebook handbook ships too");
    const linkForm = "link-character <lorebook-id> --character <character-id> --apply";
    assert.ok(skill.content.includes(linkForm), "the characters handbook names the linking CLI and its flag form");
    assert.ok(lorebookSkill.content.includes(linkForm), "the lorebook handbook names the same form");
  } finally {
    await db._fileStore.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("Professor Mari characters handbook regression passed.");
