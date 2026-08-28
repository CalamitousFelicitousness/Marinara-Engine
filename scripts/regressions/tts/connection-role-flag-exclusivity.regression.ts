// Every "this connection is the default (or fallback) for X" flag obeys two
// rules: it is unique within its category, and a row never holds both sides of
// a pair. One sweep enforces all of them, so this lane pins the behavior each
// flag pair needs rather than the shape of the code that produces it.
//
// What is easy to break and silent when broken:
//
//   Category scoping. The media categories compete by provider equality while
//   every language provider competes as one pool. Losing the provider term
//   makes an audio default steal the image default's slot; losing the pool
//   check makes two language connections both claim to be the agent default.
//
//   The exempt row. A provider change on a flagged row keeps that row's flag
//   and evicts the incumbent it just joined. Clearing every holder instead
//   silently strips the flag from the row that was being moved.
//
//   Purpose independence. Sound effects and music each own a pair, and the
//   agents pair is still the base every audio purpose falls through to.
//   Granting one must never disturb another, or splitting the lanes reconverges
//   them the first time somebody picks a music engine.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const storageRoot = await mkdtemp(join(tmpdir(), "marinara-connection-role-flags-"));
const previousDataDir = process.env.DATA_DIR;
const previousFileStorageDir = process.env.FILE_STORAGE_DIR;

try {
  process.env.DATA_DIR = storageRoot;
  process.env.FILE_STORAGE_DIR = join(storageRoot, "storage");

  const [dbModule, connectionsModule, schemaModule, queryModule] = await Promise.all([
    import("../../../packages/server/src/db/connection.js"),
    import("../../../packages/server/src/services/storage/connections.storage.js"),
    import("../../../packages/server/src/db/schema/index.js"),
    import("../../../packages/server/src/db/file-query.js"),
  ]);

  const db = await dbModule.getDB();
  const connections = connectionsModule.createConnectionsStorage(db);

  type RoleFlags = {
    defaultForAgents: string;
    fallbackForAgents: string;
    defaultForSfx: string;
    fallbackForSfx: string;
    defaultForMusic: string;
    fallbackForMusic: string;
  };

  const flagsOf = async (id: string): Promise<RoleFlags> => {
    const row = (await connections.getById(id)) as unknown as RoleFlags | null;
    assert.ok(row, `connection ${id} must still exist`);
    return {
      defaultForAgents: row.defaultForAgents,
      fallbackForAgents: row.fallbackForAgents,
      defaultForSfx: row.defaultForSfx,
      fallbackForSfx: row.fallbackForSfx,
      defaultForMusic: row.defaultForMusic,
      fallbackForMusic: row.fallbackForMusic,
    };
  };

  const makeAudio = async (name: string, extra: Record<string, unknown> = {}) =>
    (await connections.create({
      name,
      provider: "audio",
      apiKey: `${name}-key`,
      baseUrl: "",
      model: "",
      audioSource: "elevenlabs",
      ...extra,
    } as never))!;

  const make = async (name: string, provider: string, extra: Record<string, unknown> = {}) =>
    (await connections.create({ name, provider, apiKey: "", baseUrl: "", model: "", ...extra } as never))!;

  // ── The agents pair scopes by provider for media categories ──
  const audioA = await makeAudio("Audio A", { defaultForAgents: true });
  const imageDefault = await make("Image", "image_generation", { defaultForAgents: true });
  {
    // Two categories, one flag name: granting it for images must not disturb audio.
    assert.equal((await flagsOf(audioA.id)).defaultForAgents, "true", "audio keeps its default when images take one");
    assert.equal((await flagsOf(imageDefault.id)).defaultForAgents, "true", "the image default is set");
  }

  const audioB = await makeAudio("Audio B");
  await connections.update(audioB.id, { defaultForAgents: true } as never);
  {
    assert.equal((await flagsOf(audioB.id)).defaultForAgents, "true", "the new audio default holds the flag");
    assert.equal((await flagsOf(audioA.id)).defaultForAgents, "false", "the previous audio default is evicted");
    assert.equal((await flagsOf(imageDefault.id)).defaultForAgents, "true", "another category keeps its own default");
  }

  // ── Language competes as one pool, not by provider equality ──
  const openai = await make("OpenAI", "openai", { defaultForAgents: true });
  const anthropic = await make("Anthropic", "anthropic", { defaultForAgents: true });
  {
    assert.equal((await flagsOf(anthropic.id)).defaultForAgents, "true", "the newest language default holds the flag");
    assert.equal(
      (await flagsOf(openai.id)).defaultForAgents,
      "false",
      "a different language provider still competes for the same slot",
    );
    assert.equal((await flagsOf(audioB.id)).defaultForAgents, "true", "language never evicts the audio default");
    assert.equal((await flagsOf(imageDefault.id)).defaultForAgents, "true", "language never evicts the image default");
  }

  // ── Default and fallback are opposite answers on one row ──
  {
    await connections.update(audioB.id, { fallbackForAgents: true } as never);
    const flags = await flagsOf(audioB.id);
    assert.equal(flags.fallbackForAgents, "true", "the row takes the fallback side");
    assert.equal(flags.defaultForAgents, "false", "and releases the default side");
  }

  // ── A grant of both sides in one payload leaves neither ──
  // Each side clears the other, and the second clear wins. Pinned because it is
  // observable, not because it is desirable.
  {
    const both = await makeAudio("Both Sides", { defaultForAgents: true, fallbackForAgents: true });
    const flags = await flagsOf(both.id);
    assert.equal(flags.defaultForAgents, "false", "a contradictory payload takes no default");
    assert.equal(flags.fallbackForAgents, "false", "a contradictory payload takes no fallback");
  }

  // ── A provider change carries the flag into its new category ──
  {
    const mover = await make("Mover", "openai", { defaultForAgents: true });
    assert.equal((await flagsOf(mover.id)).defaultForAgents, "true", "the language default is set");
    await connections.update(mover.id, { provider: "image_generation" } as never);
    assert.equal(
      (await flagsOf(mover.id)).defaultForAgents,
      "true",
      "a row moving categories keeps the flag it already held",
    );
    assert.equal(
      (await flagsOf(imageDefault.id)).defaultForAgents,
      "false",
      "and evicts the incumbent in the category it joined",
    );
  }

  // ── A provider change that stays in the category keeps the flag ──
  // The sweep runs before the row's own provider write, so the row is still one
  // of the holders it is about to clear, and nothing re-sets a flag the payload
  // never named. Exempting the row is what keeps re-saving a connection from
  // silently dropping the default it already held.
  {
    const staysLanguage = await make("Stays Language", "openai", { defaultForAgents: true });
    await connections.update(staysLanguage.id, { provider: "anthropic" } as never);
    assert.equal(
      (await flagsOf(staysLanguage.id)).defaultForAgents,
      "true",
      "a language row switching providers keeps the default it held",
    );

    const staysImage = await make("Stays Image", "image_generation", { defaultForAgents: true });
    await connections.update(staysImage.id, { provider: "image_generation" } as never);
    assert.equal(
      (await flagsOf(staysImage.id)).defaultForAgents,
      "true",
      "an image row re-saving its provider keeps the default it held",
    );
  }

  // ── Purpose pairs are unique among audio connections ──
  const sfxA = await makeAudio("Sfx A", { defaultForSfx: true });
  const sfxB = await makeAudio("Sfx B", { defaultForSfx: true });
  {
    assert.equal((await flagsOf(sfxB.id)).defaultForSfx, "true", "the newest sfx default holds the flag");
    assert.equal((await flagsOf(sfxA.id)).defaultForSfx, "false", "the previous sfx default is evicted");
  }

  // ── Purposes are independent of each other and of the base pair ──
  {
    const base = await flagsOf(audioA.id);
    assert.equal(base.defaultForAgents, "false", "precondition: audio A lost the base default earlier");
    await connections.update(audioA.id, { defaultForAgents: true } as never);
    await connections.update(sfxB.id, { defaultForMusic: true } as never);

    const music = await flagsOf(sfxB.id);
    assert.equal(music.defaultForMusic, "true", "the music default is set");
    assert.equal(music.defaultForSfx, "true", "taking the music lane leaves the sound effect lane alone");
    assert.equal(
      (await flagsOf(audioA.id)).defaultForAgents,
      "true",
      "a purpose default never evicts the base audio default",
    );

    await connections.update(sfxA.id, { defaultForAgents: true } as never);
    const purposeHolder = await flagsOf(sfxB.id);
    assert.equal(purposeHolder.defaultForSfx, "true", "the base default never evicts a sound effect default");
    assert.equal(purposeHolder.defaultForMusic, "true", "the base default never evicts a music default");
  }

  // ── Each purpose pair is mutually exclusive within itself ──
  {
    await connections.update(sfxB.id, { fallbackForSfx: true } as never);
    const flags = await flagsOf(sfxB.id);
    assert.equal(flags.fallbackForSfx, "true", "the row takes the sfx fallback side");
    assert.equal(flags.defaultForSfx, "false", "and releases the sfx default side");
    assert.equal(flags.defaultForMusic, "true", "while the music lane is untouched");
  }

  // ── Purpose flags belong to audio connections only ──
  {
    const notAudio = await make("Language", "openai", { defaultForSfx: true, fallbackForMusic: true } as never);
    const flags = await flagsOf(notAudio.id);
    assert.equal(flags.defaultForSfx, "false", "a language connection cannot claim the sound effect lane");
    assert.equal(flags.fallbackForMusic, "false", "a language connection cannot claim the music lane");
  }

  // ── Leaving the audio category releases every purpose flag ──
  {
    const leaver = await makeAudio("Leaver", { defaultForSfx: true, defaultForMusic: true });
    await connections.update(leaver.id, { provider: "openai" } as never);
    const flags = await flagsOf(leaver.id);
    assert.equal(flags.defaultForSfx, "false", "a row that stops being audio cannot answer for sound effects");
    assert.equal(flags.defaultForMusic, "false", "a row that stops being audio cannot answer for music");
    assert.equal(flags.fallbackForSfx, "false", "including the fallback sides");
    assert.equal(flags.fallbackForMusic, "false", "including the fallback sides");
  }

  // ── The getters answer per purpose, and answer nothing when unclaimed ──
  // Fresh rows, because a getter that read the wrong column would still find
  // something as long as some row held any purpose flag.
  {
    const sfxDefaultRow = await makeAudio("Getter Sfx Default", { defaultForSfx: true });
    const musicDefaultRow = await makeAudio("Getter Music Default", { defaultForMusic: true });
    const sfxFallbackRow = await makeAudio("Getter Sfx Fallback", { fallbackForSfx: true });
    assert.equal(
      (await connections.getDefaultForAudioPurpose("sfx"))?.id,
      sfxDefaultRow.id,
      "the sfx default getter finds the row holding that flag",
    );
    assert.equal(
      (await connections.getDefaultForAudioPurpose("music"))?.id,
      musicDefaultRow.id,
      "each purpose reads its own column",
    );
    assert.equal(
      (await connections.getFallbackForAudioPurpose("sfx"))?.id,
      sfxFallbackRow.id,
      "the fallback getter reads the fallback column, not the default one",
    );
    assert.equal(
      await connections.getFallbackForAudioPurpose("music"),
      null,
      "an unclaimed lane resolves to nothing rather than to another lane's row",
    );
  }

  // ── A copy is a new connection, not a second holder of the same roles ──
  {
    const original = await makeAudio("Original", {
      defaultForAgents: true,
      defaultForSfx: true,
      fallbackForMusic: true,
      audioSoundEffects: true,
      audioMusic: true,
    });
    const copy = (await connections.duplicate(original.id))!;
    const flags = await flagsOf(copy.id);
    for (const [field, value] of Object.entries(flags)) {
      assert.equal(value, "false", `a duplicate must not inherit ${field}`);
    }
    const copiedRow = (await connections.getById(copy.id)) as unknown as {
      audioSoundEffects: string;
      audioMusic: string;
    };
    assert.equal(copiedRow.audioSoundEffects, "true", "capability is a property of the engine, so a copy keeps it");
    assert.equal(copiedRow.audioMusic, "true", "capability is a property of the engine, so a copy keeps it");
    assert.equal((await flagsOf(original.id)).defaultForSfx, "true", "and the original keeps its roles");
  }

  // ── A quarantined import never answers as a default ──
  {
    const quarantined = await makeAudio("Quarantined", { defaultForMusic: true });
    await db
      .update(schemaModule.apiConnections)
      .set({ profileImportReviewRequired: "true" })
      .where(queryModule.eq(schemaModule.apiConnections.id, quarantined.id));
    assert.equal(
      await connections.getDefaultForAudioPurpose("music"),
      null,
      "a connection awaiting review cannot be resolved as a purpose default",
    );
  }

  console.info("Connection role flag exclusivity regression passed.");
} finally {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousFileStorageDir === undefined) delete process.env.FILE_STORAGE_DIR;
  else process.env.FILE_STORAGE_DIR = previousFileStorageDir;
  await rm(storageRoot, { recursive: true, force: true });
}
