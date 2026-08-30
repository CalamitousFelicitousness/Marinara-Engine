// Importing a name the library already holds asks rather than duplicating.
//
// Nothing in storage prevents a duplicate, so importing the same card twice has
// always produced two of it silently. This lane pins the three outcomes now on
// offer, and the one property that makes overwriting safe: the row is updated,
// not swapped, so its id survives and everything pointing at it stays attached.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-import-conflicts-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";

let app: { close(): Promise<void>; inject(options: Record<string, unknown>): Promise<any> } | null = null;

try {
  const { buildApp } = await import("../../packages/server/src/app.js");
  app = await buildApp();
  await app.ready();

  const post = async (url: string, payload: unknown) => {
    const response = await app!.inject({ method: "POST", url, payload });
    return { status: response.statusCode, body: response.json() };
  };
  const get = async (url: string) => {
    const response = await app!.inject({ method: "GET", url });
    return { status: response.statusCode, body: response.json() };
  };

  const card = (name: string, description: string) => ({
    name,
    description,
    personality: "",
    scenario: "",
    first_mes: "Hello",
    mes_example: "",
  });

  const conflictsFor = async (candidates: unknown) =>
    (await post("/api/import/name-conflicts", { candidates })).body.conflicts as Array<Record<string, unknown>>;

  const characterRows = async () => {
    const list = await get("/api/characters");
    return (Array.isArray(list.body) ? list.body : list.body.characters) as Array<Record<string, unknown>>;
  };
  // A row carries its card as a JSON string, so the name is inside it.
  const cardOf = (row: Record<string, unknown>) =>
    (typeof row.data === "string" ? JSON.parse(row.data) : (row.data ?? {})) as Record<string, unknown>;
  const namedMari = (rows: Array<Record<string, unknown>>) => rows.filter((row) => cardOf(row).name === "Mari");

  // A first import collides with nothing
  {
    assert.deepEqual(
      await conflictsFor([{ kind: "character", name: "Mari" }]),
      [],
      "an empty library conflicts with nothing",
    );
    const created = await post("/api/import/st-character", card("Mari", "original"));
    assert.equal(created.body.success, true, "the first import succeeds");
  }

  // The second one is reported, and says whether it could be undone
  {
    const [conflict] = await conflictsFor([{ kind: "character", name: "Mari", ref: "mari.json" }]);
    assert.ok(conflict, "a name already in the library is reported");
    assert.equal(conflict.kind, "character", "the kind comes back with the match");
    assert.equal(conflict.existingName, "Mari", "so does the stored spelling");
    assert.equal(conflict.ref, "mari.json", "the caller reference is echoed so it can match the answer");
    assert.equal(conflict.recoverable, true, "a character overwrite is recoverable from version history");
    assert.ok(typeof conflict.existingId === "string" && conflict.existingId, "and the row it would replace");
  }

  // Case and surrounding space are the same name to a person
  {
    const conflicts = await conflictsFor([
      { kind: "character", name: "  mari " },
      { kind: "character", name: "Mari the Second" },
    ]);
    assert.equal(conflicts.length, 1, "only the name that matches is reported");
    assert.equal(conflicts[0]?.name, "  mari ", "the incoming spelling is preserved in the answer");
  }

  // Importing anyway still makes a second one, which is what it always did
  {
    await post("/api/import/st-character", card("Mari", "second"));
    assert.equal(namedMari(await characterRows()).length, 2, "importing without answering leaves both");
  }

  // Overwriting replaces one instead of adding a third
  {
    const [conflict] = await conflictsFor([{ kind: "character", name: "Mari" }]);
    const targetId = conflict!.existingId as string;

    // A chat pointed at the character proves the row is updated rather than
    // swapped: a delete and recreate would orphan this.
    const chat = await post("/api/chats", { name: "With Mari", mode: "roleplay", characterIds: [targetId] });
    assert.equal(chat.status, 200, "a chat can be attached to the character about to be replaced");

    const replaced = await post("/api/import/st-character", { ...card("Mari", "replacement"), overwriteId: targetId });
    assert.equal(replaced.body.success, true, "the overwrite succeeds");

    const rows = await characterRows();
    assert.equal(namedMari(rows).length, 2, "overwriting replaces one rather than adding a third");

    const target = rows.find((row) => row.id === targetId);
    assert.ok(target, "the replaced row keeps its id");
    assert.equal(cardOf(target!).description, "replacement", "and carries the imported content");

    const versions = await get("/api/characters/" + targetId + "/versions");
    const versionRows = (
      Array.isArray(versions.body) ? versions.body : (versions.body.versions ?? [])
    ) as Array<Record<string, unknown>>;
    assert.ok(versionRows.length > 0, "the card it replaced is recoverable from version history");
  }

  // A target that vanished imports as new rather than failing
  {
    const orphaned = await post("/api/import/st-character", {
      ...card("Ghost", "no such target"),
      overwriteId: "character-that-does-not-exist",
    });
    assert.equal(orphaned.body.success, true, "the user asked for this card either way");
    const [conflict] = await conflictsFor([{ kind: "character", name: "Ghost" }]);
    assert.ok(conflict, "and it landed in the library");
  }

  // Lorebooks say they cannot be undone
  {
    await post("/api/import/st-lorebook", {
      name: "Field Notes",
      entries: [{ keys: ["north"], content: "The north road" }],
    });
    const [conflict] = await conflictsFor([{ kind: "lorebook", name: "Field Notes" }]);
    assert.ok(conflict, "a second lorebook of the same name is reported");
    assert.equal(conflict.recoverable, false, "and says so, because nothing snapshots a lorebook");
  }

  // Kinds do not collide with each other
  {
    const conflicts = await conflictsFor([
      { kind: "lorebook", name: "Mari" },
      { kind: "persona", name: "Field Notes" },
      { kind: "preset", name: "Mari" },
    ]);
    assert.deepEqual(conflicts, [], "a character named Mari is not a lorebook named Mari");
  }

  // A malformed request is refused rather than guessed at
  {
    const bad = await post("/api/import/name-conflicts", { candidates: "Mari" });
    assert.equal(bad.status, 400, "candidates must be a list");
    const ignored = await conflictsFor([{ kind: "chat", name: "Mari" }, { name: "Mari" }, null, { kind: "character" }]);
    assert.deepEqual(ignored, [], "entries that name no importable kind are skipped, not thrown");
  }

  console.info("Import name conflicts regression passed.");
} finally {
  await app?.close();
  rmSync(dataDir, { recursive: true, force: true });
}
