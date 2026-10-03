import assert from "node:assert/strict";
import { closeDB, getDB, type DB } from "../../packages/server/src/db/connection.js";
import { importMarinara } from "../../packages/server/src/services/import/marinara.importer.js";
import { importSTLorebook } from "../../packages/server/src/services/import/st-lorebook.importer.js";
import { createLorebooksStorage } from "../../packages/server/src/services/storage/lorebooks.storage.js";

const db = await getDB();
const lorebooks = createLorebooksStorage(db);

const envelope = (name: string) => ({
  type: "marinara_lorebook" as const,
  version: 1 as const,
  exportedAt: new Date().toISOString(),
  data: {
    lorebook: { name },
    folders: [
      { id: "old-places", name: "Places" },
      { id: "old-towns", name: "Towns", parentFolderId: "old-places" },
    ],
    entries: [{ name: "Harbor", content: "A new harbor entry", folderId: "old-towns" }],
  },
});

async function snapshot(lorebookId: string) {
  const entries = (await lorebooks.listEntries(lorebookId)) as unknown as Array<{ id: string }>;
  const folders = (await lorebooks.listFolders(lorebookId)) as unknown as Array<{ id: string }>;
  return {
    name: (await lorebooks.getById(lorebookId))!.name,
    entryIds: entries.map((entry) => entry.id).sort(),
    folderIds: folders.map((folder) => folder.id).sort(),
  };
}

try {
  const book = (await lorebooks.create({ name: "Field Notes" }))!;
  const folder = (await lorebooks.createFolder(book.id, { name: "Old folder" })) as { id: string };
  await lorebooks.createEntry({ lorebookId: book.id, name: "Kept", content: "old", folderId: folder.id });
  await lorebooks.createEntry({ lorebookId: book.id, name: "Root", content: "old root" });
  const before = await snapshot(book.id);

  // The swap is the import's first transaction; failing it must leave the replaced lorebook untouched.
  let failNextTransaction = true;
  const failingDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction" && failNextTransaction) {
        return () => {
          failNextTransaction = false;
          throw new Error("forced swap failure");
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DB;
  await assert.rejects(importMarinara(envelope("Field Notes v2"), failingDb, book.id), /forced swap failure/);
  assert.equal(failNextTransaction, false, "the forced failure was reached");
  assert.deepEqual(await snapshot(book.id), before, "a failed replace keeps the previous entries, folders and name");

  const result = await importMarinara(envelope("Field Notes v2"), db, book.id);
  assert.equal(result.success, true);
  assert.equal(result.id, book.id, "a replace keeps the lorebook id");
  const after = await snapshot(book.id);
  assert.equal(after.name, "Field Notes v2");
  assert.equal(after.entryIds.length, 1, "only the imported entry remains");
  assert.ok(!after.entryIds.some((id) => before.entryIds.includes(id)), "previous entries are gone");
  assert.equal(after.folderIds.length, 2, "only the imported folders remain");
  assert.ok(!after.folderIds.some((id) => before.folderIds.includes(id)), "previous folders are gone");

  const folders = (await lorebooks.listFolders(book.id)) as unknown as Array<{
    id: string;
    name: string;
    parentFolderId: string | null;
  }>;
  const places = folders.find((row) => row.name === "Places")!;
  const towns = folders.find((row) => row.name === "Towns")!;
  assert.equal(towns.parentFolderId, places.id, "nesting survives the replace");
  const [harbor] = (await lorebooks.listEntries(book.id)) as unknown as Array<{ folderId: string | null }>;
  assert.equal(harbor!.folderId, towns.id, "the entry lands in its imported folder");

  // A SillyTavern re-import has no folders of its own, so it leaves none of the previous ones behind.
  const stResult = await importSTLorebook(
    { name: "Field Notes ST", entries: { 0: { uid: 0, key: ["harbor"], content: "ST harbor" } } },
    db,
    { existingLorebookId: book.id },
  );
  assert.equal((stResult as { lorebookId?: string }).lorebookId, book.id);
  const stAfter = await snapshot(book.id);
  assert.equal(stAfter.entryIds.length, 1, "the ST import replaces the entries");
  assert.deepEqual(stAfter.folderIds, [], "and clears the previous folders");
} finally {
  await closeDB();
}

console.log("lorebook-import-overwrite regression passed.");
