// #7999: an argument the tool could not read used to be replaced without a word. An "apply" of 0 or
// "dry-run" wrote on every create (and previewed on every update), and a limit of "ten" or 5000
// came back as the default or the maximum page. Unreadable values are refused now, and a value
// that had to be moved into range is named in the result.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storageDir = mkdtempSync(join(tmpdir(), "marinara-unreadable-arguments-"));
const previousStorageDir = process.env.FILE_STORAGE_DIR;
process.env.FILE_STORAGE_DIR = storageDir;
const { getDB, closeDB } = await import("../../../packages/server/src/db/connection.js");
try {
  const db = await getDB();
  const { MariDbService } = await import("../../../packages/server/src/services/mari-db/mari-db.service.js");
  const { WorkspaceCommands } =
    await import("../../../packages/server/src/services/professor-mari/workspace-commands.js");
  const mariDb = new MariDbService(db);
  const call = (args: Record<string, unknown>) =>
    mariDb.executeAction(args as never) as Promise<{ ok: boolean; mode: string; error?: string; output?: unknown }>;
  const count = async (action: string) => ((await call({ action })).output as unknown[]).length;

  // An unreadable apply on a create is refused and writes nothing.
  for (const apply of [0, "dry-run", null]) {
    const theme = await call({ action: "theme.create", data: { name: "Probe", css: "body{}" }, apply });
    assert.equal(theme.ok, false, `apply ${JSON.stringify(apply)} is refused`);
    assert.match(theme.error ?? "", /"apply" must be true or false \(.+\), so nothing was saved\./);
  }
  assert.equal(await count("theme.list"), 0, "no theme was created");
  // The values it can read still work, and leaving it out still creates.
  assert.equal((await call({ action: "character.create", data: { name: "Aldric" }, apply: "yes" })).ok, true);
  assert.equal((await call({ action: "character.create", data: { name: "Elsie" } })).ok, true);
  assert.equal(await count("character.list"), 2);

  // An unreadable apply on an update is refused instead of previewing as a success.
  const aldric = ((await call({ action: "character.list" })).output as Array<{ id: string; name: string }>).find(
    (row) => row.name === "Aldric",
  )!.id;
  const update = await call({ action: "character.update", id: aldric, patch: { description: "x" }, apply: "preview" });
  assert.equal(update.ok, false);
  assert.match(update.error ?? "", /"apply" must be true or false \(got "preview"\)/);

  // A limit or offset that is not a number is refused, naming the key.
  const ten = await call({ action: "character.list", limit: "ten" });
  assert.equal(ten.ok, false);
  assert.match(ten.error ?? "", /"limit" must be a number \(got "ten"\)/);
  const offset = await call({ action: "skill.list", offset: {} });
  assert.match(offset.error ?? "", /"offset" must be a number/);
  assert.equal(((await call({ action: "character.list", limit: "1" })).output as unknown[]).length, 1);

  // Through the tool, a lowered limit is named before the result.
  const commands = new WorkspaceCommands({ db } as never, () => ({
    permissionsMode: "auto",
    manualSilentMutationBlocked: false,
    askLatchSilentMutationBlocked: false,
    decisionContext: null,
  }));
  let n = 0;
  const run = (name: string, args: Record<string, unknown>) =>
    commands.executeWorkspaceCommand(
      { id: `call-${++n}`, name, arguments: args },
      new AbortController().signal,
      [],
      () => {},
      [],
    );
  const big = await run("app_data", { action: "character.list", limit: 5000 });
  assert.equal(big.success, true);
  assert.match(
    big.output,
    /^"limit" 5000 is above this read's maximum, so 1000 was used: this may not be everything\./,
  );
  const zero = await run("app_data", { action: "character.list", limit: 0 });
  assert.match(zero.output, /^"limit" 0 is below 1, so the default 50 was used\./);
  const plain = await run("app_data", { action: "character.list", limit: 10 });
  assert.doesNotMatch(plain.output, /"limit"/, "an in-range limit adds no note");

  // addSection says where the section landed: injectionOrder never places it (T10, round 2).
  await run("app_data", { action: "skill.get", id: "builtin-presets" });
  const preset = await run("app_data", { action: "preset.create", data: { name: "Placement" }, apply: true });
  assert.equal(preset.success, true, preset.output);
  const presetId = (await mariDb.executeAction({ action: "preset.list" } as never)).output as {
    id: string;
    name: string;
  }[];
  const placementId = presetId.find((row) => row.name === "Placement")?.id;
  assert.ok(placementId, "the preset was created");
  await run("app_data", {
    action: "preset.addSection",
    presetId: placementId,
    data: { name: "Chat History" },
    apply: true,
  });
  const weather = await run("app_data", {
    action: "preset.addSection",
    presetId: placementId,
    data: { name: "Weather", injectionOrder: 850 },
    apply: true,
  });
  assert.equal(weather.success, true, weather.output);
  assert.match(
    weather.output,
    /^"Weather" was added as the last section, after "Chat History". "injectionOrder" does not move it. To place it elsewhere, send preset.update with the whole "sectionOrder"./,
  );
  const dryRun = await run("app_data", {
    action: "preset.addSection",
    presetId: placementId,
    data: { name: "Unsaved" },
    apply: false,
  });
  assert.doesNotMatch(dryRun.output, /was added as the last section/, "a dry run adds no placement note");

  // The workspace tools follow the same rule.
  const read = await run("read", { path: "package.json", limit: 5000 });
  assert.equal(read.success, true);
  assert.match(read.output, /^"limit" 5000 is outside 1-2000, so 2000 was used\.\nFile: /);
  const badRead = await run("read", { path: "package.json", limit: "ten" });
  assert.equal(badRead.success, false);
  assert.match(badRead.output, /"limit" must be a number from 1 to 2000 \(got "ten"\)\. Leave it out to use 2000\./);
} finally {
  await closeDB();
  if (previousStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousStorageDir;
  rmSync(storageDir, { recursive: true, force: true });
}

console.log("Professor Mari unreadable arguments regression passed.");
