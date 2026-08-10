import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedDefaultPreset } from "../../packages/server/src/db/seed.js";
import { createFileNativeDB } from "../../packages/server/src/db/file-backed-store.js";
import { createPromptsStorage } from "../../packages/server/src/services/storage/prompts.storage.js";
import { isStockMarinaraUniversalPreset } from "../../packages/shared/src/types/prompt.js";

const dir = mkdtempSync(join(tmpdir(), "marinara-stock-preset-"));
process.env.FILE_STORAGE_DIR = dir;
const db = await createFileNativeDB();

try {
  const storage = createPromptsStorage(db);
  await seedDefaultPreset(db);
  const original = (await storage.list()).find(isStockMarinaraUniversalPreset);
  assert.ok(original, "a fresh profile receives the stock Marinara universal preset");

  const originalDescription = original.description;
  await storage.update(original.id, { description: "My customized universal preset" });
  await seedDefaultPreset(db);

  const afterCustomization = await storage.list();
  const restored = afterCustomization.find(isStockMarinaraUniversalPreset);
  const editableCopy = afterCustomization.find((preset) => preset.name === "Marinara's Universal Preset (Copy)");
  assert.equal(restored?.description, originalDescription, "startup restores the bundled stock preset contents");
  assert.equal(
    editableCopy?.description,
    "My customized universal preset",
    "startup preserves attempted stock edits in an editable copy",
  );
  assert.equal(editableCopy?.systemKey, "", "editable copies do not inherit the reserved stock identity");

  assert.ok(restored && editableCopy, "both the restored stock preset and editable copy exist");
  const matchingUserPreset = await storage.create({
    name: "Marinara's Universal Preset",
    author: "Marinara",
    description: "User-owned matching preset",
  });
  assert.ok(matchingUserPreset, "the matching-name user preset fixture is created");
  await storage.setDefault(editableCopy.id);
  await storage.remove(restored.id);
  await seedDefaultPreset(db);

  const afterDeletion = await storage.list();
  assert.equal(
    afterDeletion.filter(isStockMarinaraUniversalPreset).length,
    1,
    "startup recovers a deleted stock preset",
  );
  assert.equal(
    afterDeletion.find((preset) => preset.id === matchingUserPreset.id)?.systemKey,
    "",
    "a user preset with matching editable fields is never claimed as stock",
  );
  assert.equal(
    afterDeletion.find((preset) => preset.id === editableCopy.id)?.isDefault,
    "true",
    "recovering the stock preset preserves the user's chosen default",
  );
} finally {
  await db._fileStore.close();
  rmSync(dir, { recursive: true, force: true });
}

console.info("Stock preset protection regression checks passed.");
