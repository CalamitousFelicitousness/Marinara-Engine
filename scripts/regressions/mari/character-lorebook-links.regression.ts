// A card's lorebooks are not on its row: attachments live in `lorebook_character_links` and the
// book it owns is `lorebooks.characterId`. `character.get` exposes both, so a reader (Professor
// Mari's onboarding handbook included) can find the lore a card brings without a raw DB read.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileNativeDB } from "../../../packages/server/src/db/file-backed-store.js";
import { characters } from "../../../packages/server/src/db/schema/characters.js";
import { lorebookCharacterLinks, lorebooks } from "../../../packages/server/src/db/schema/lorebooks.js";
import { MariDbService } from "../../../packages/server/src/services/mari-db/mari-db.service.js";

const previousFileStorageDir = process.env.FILE_STORAGE_DIR;
const dir = mkdtempSync(join(tmpdir(), "marinara-mari-character-lorebooks-"));
process.env.FILE_STORAGE_DIR = dir;

try {
  const db = await createFileNativeDB();
  try {
    const stamp = "2026-01-01T00:00:00.000Z";
    await db.insert(characters).values({
      id: "char-a",
      data: JSON.stringify({ name: "Simulator" }),
      comment: "",
      createdAt: stamp,
      updatedAt: stamp,
    });
    await db.insert(lorebooks).values({
      id: "book-linked",
      name: "Simulator's Lorebook",
      description: "Earth-Prime locations, power systems, magic, character tiers.",
      createdAt: stamp,
      updatedAt: stamp,
    });
    await db.insert(lorebooks).values({
      id: "book-owned",
      name: "Card Book",
      description: "Ships inside the card.",
      characterId: "char-a",
      createdAt: stamp,
      updatedAt: stamp,
    });
    await db.insert(lorebooks).values({
      id: "book-other",
      name: "Someone Else",
      description: "Belongs to another card.",
      characterId: "char-b",
      createdAt: stamp,
      updatedAt: stamp,
    });
    await db
      .insert(lorebookCharacterLinks)
      .values({ id: "link-1", lorebookId: "book-linked", characterId: "char-a", createdAt: stamp });

    const mari = new MariDbService(db);
    const got = await mari.executeAction({ action: "character.get", characterId: "char-a" });
    assert.equal(got.ok, true);

    const output = got.output as {
      data?: { name?: string };
      lorebooks?: Array<{ id: string; name: string; description: string; attached: string }>;
    };
    assert.equal(output.data?.name, "Simulator", "the card itself still comes back");
    assert.deepEqual(
      output.lorebooks,
      [
        // Sorted by name, and the other card's book is not included.
        {
          id: "book-owned",
          name: "Card Book",
          description: "Ships inside the card.",
          attached: "owned",
        },
        {
          id: "book-linked",
          name: "Simulator's Lorebook",
          description: "Earth-Prime locations, power systems, magic, character tiers.",
          attached: "linked",
        },
      ],
      "both the linked book and the card's own book are reported, nothing else",
    );

    // A card with no books reports an empty list, not a missing field.
    await db.insert(characters).values({
      id: "char-bare",
      data: JSON.stringify({ name: "Bare" }),
      comment: "",
      createdAt: stamp,
      updatedAt: stamp,
    });
    // A model that reads `lorebooks` off a card will try to write it back; refuse with the CLI route
    // instead of dropping the field (a live 12b did exactly this three times, #7949).
    const wrongLink = await mari.executeAction({
      action: "character.update",
      characterId: "char-a",
      data: { lorebooks: [] },
    });
    assert.equal(wrongLink.ok, false, "character.update refuses a lorebook link instead of ignoring it");
    assert.match(String(wrongLink.error), /mari lorebooks link-character <lorebook-id> --character char-a --apply/);
    // A live 12b read "run … in bash" as an instruction for the user and printed the command instead.
    assert.match(
      String(wrongLink.error),
      /you run it yourself: send .* with your bash tool\. Sent alone, a mari command runs outside the sandbox\. Do not hand the command to the user/,
    );

    // The same shape every namespace now uses: kind, id, "ids are generated", and the finder.
    const missingBook = await mari.executeAction({
      action: "lorebook.update",
      lorebookId: "elsies-world",
      data: { name: "x" },
    });
    assert.equal(missingBook.ok, false);
    assert.match(String(missingBook.error), /No lorebook has the id "elsies-world"/);
    assert.match(String(missingBook.error), /lorebook\.list/);

    const bare = await mari.executeAction({ action: "character.get", characterId: "char-bare" });
    assert.deepEqual((bare.output as { lorebooks?: unknown[] }).lorebooks, []);

    // #7949: an unknown id says so (a 12b sent a name and read a bare null as "no lorebooks").
    const missing = await mari.executeAction({ action: "character.get", characterId: "nope" });
    assert.equal(missing.ok, false);
    assert.match(String((missing as { error?: unknown }).error), /No character has the id "nope"/);
  } finally {
    await db._fileStore.close();
  }
} finally {
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  rmSync(dir, { recursive: true, force: true });
}

console.log("Professor Mari character lorebooks regression passed.");
