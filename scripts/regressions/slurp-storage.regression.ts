import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "../../packages/server/src/db/file-query.js";
import { fileTable, text } from "../../packages/server/src/db/file-schema.js";

// These separate table instances model the definitions bundled by the
// downloadable Slurp package. Engine must resolve them by registered name.
const packageSlurpAccounts = fileTable("slurp_accounts", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  entityId: text("entity_id").notNull(),
  handle: text("handle").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
const packageSlurpPosts = fileTable("slurp_posts", {
  id: text("id").primaryKey(),
  authorAccountId: text("author_account_id").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

const storageDir = mkdtempSync(join(tmpdir(), "marinara-slurp-storage-"));
process.env.FILE_STORAGE_DIR = storageDir;
const { createFileNativeDB } = await import("../../packages/server/src/db/file-backed-store.js");

let fileDb = await createFileNativeDB();
try {
  const now = new Date().toISOString();
  await fileDb
    .insert(packageSlurpAccounts)
    .values({
      id: "slurp-creator",
      kind: "character",
      entityId: "character-1",
      handle: "slurp_creator",
      displayName: "Slurp Creator",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  await fileDb
    .insert(packageSlurpPosts)
    .values({
      id: "slurp-post",
      authorAccountId: "slurp-creator",
      content: "Package-owned storage proof",
      createdAt: now,
      updatedAt: now,
    })
    .run();
} finally {
  await fileDb._fileStore.close();
}

assert.equal(existsSync(join(storageDir, "tables", "slurp_accounts.json")), true);
assert.equal(existsSync(join(storageDir, "tables", "slurp_posts.json")), true);

fileDb = await createFileNativeDB();
try {
  assert.equal(
    (await fileDb.select().from(packageSlurpPosts).where(eq(packageSlurpPosts.id, "slurp-post"))).at(0)?.content,
    "Package-owned storage proof",
  );
  await fileDb.delete(packageSlurpAccounts).where(eq(packageSlurpAccounts.id, "slurp-creator")).run();
  assert.equal((await fileDb.select().from(packageSlurpPosts)).length, 0, "deleting a Creator cascades to its posts");
} finally {
  await fileDb._fileStore.close();
  rmSync(storageDir, { recursive: true, force: true });
}

process.stdout.write("Slurp package-owned storage regression passed.\n");
