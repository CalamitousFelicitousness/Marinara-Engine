/**
 * Ruleset package zips (RM): imported as data, never as a package, never run.
 *
 *   - A zip of exactly a manifest, a ruleset.json and its catalogs/<id>.json files is read in memory,
 *     checked whole and kept under `local/<id>` with its catalog files; anything else in a zip refuses it,
 *     each with the reason: other files, odd paths, directories that hold anything, links, encryption,
 *     unread compression, sizes that lie or overflow, shared bytes, more entries than a ruleset has,
 *     text that is not UTF-8, a manifest that is more than a ruleset's (code, permissions, other
 *     contributions, files that are not the zip's), a ruleset or catalog that does not read or carries
 *     more than a ruleset ($comment essays, a foreign $schema), catalogs not the ruleset's.
 *   - A dry run keeps nothing; the import follows privilege and the import policy.
 *   - A version is its ruleset AND its catalogs: the same text with another catalog is a conflict; a
 *     catalog file is kept once whatever versions name it, and goes with the last of them; one version
 *     no game pins can be removed alone.
 *   - Play reads a stored catalog file like a package's; the JSON import still refuses catalog files.
 *   - An editor checks a ruleset (or a zip) without saving it, with issues where they point and the least
 *     capability API a package of it needs, and reads an installed ruleset's files from its source.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import { parseRulesetCatalogFile, parseRulesetDefinition } from "../../packages/shared/src/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-ruleset-packages-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";

// ── A zip, byte by byte, so every field can be what a hostile one would make it ──
type Entry = {
  name: string;
  data?: Buffer;
  /** 0 stored, 8 deflated, anything else. */
  method?: number;
  /** The size the directory claims, when it lies. */
  declared?: number;
  flags?: number;
  attr?: number;
  /** Where the directory says its local record is, when it lies. */
  offset?: number;
  /** The name beside the data, when it is not the directory's. */
  localName?: string;
  /** Bytes in the local record's extra field. */
  localExtra?: Buffer;
  /** The checksum the records claim, when it lies. */
  crc?: number;
  /** The packed bytes as they are, instead of `data` packed by `method`. */
  body?: Buffer;
};
type ZipShape = {
  /** Bytes before the first record. */
  prefix?: Buffer;
  /** The entry count the end record claims. */
  count?: number;
  comment?: string;
  /** Bytes between the last record and the directory. */
  gap?: Buffer;
};
function rawZip(entries: Entry[], shape: ZipShape = {}): Buffer {
  const locals: Buffer[] = shape.prefix ? [shape.prefix] : [];
  const centrals: Buffer[] = [];
  let offset = shape.prefix?.length ?? 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const localName = Buffer.from(entry.localName ?? entry.name, "utf8");
    const localExtra = entry.localExtra ?? Buffer.alloc(0);
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 8;
    const body = entry.body ?? (method === 8 ? deflateRawSync(data) : data);
    const crc = entry.crc ?? crc32(data);
    const size = entry.declared ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.attr ?? 0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(entry.offset ?? offset, 42);
    locals.push(local, localName, localExtra, body);
    centrals.push(central, name);
    offset += 30 + localName.length + localExtra.length + body.length;
  }
  if (shape.gap) {
    locals.push(shape.gap);
    offset += shape.gap.length;
  }
  const directory = Buffer.concat(centrals);
  const comment = Buffer.from(shape.comment ?? "");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(shape.count ?? entries.length, 8);
  end.writeUInt16LE(shape.count ?? entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, end, comment]);
}

// ── A ruleset package: the ember-roads example, its first catalog in its own file ──
const example = JSON.parse(
  readFileSync(new URL("../../docs/examples/rulesets/ember-roads.json", import.meta.url), "utf8"),
) as Record<string, any>;
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
type Docs = { ruleset: Record<string, any>; catalogs: Record<string, Record<string, unknown>> };
function packageDocs(edit?: (docs: Docs) => void): Docs {
  const ruleset = structuredClone(example);
  ruleset.id = "ember-roads-house";
  const [first] = ruleset.catalogs as Array<Record<string, any>>;
  const catalogs = { [first.id]: { schemaVersion: 1, catalog: first.id, entries: first.entries } };
  delete first.entries;
  first.asset = `catalogs/${first.id}.json`;
  const docs = { ruleset, catalogs };
  edit?.(docs);
  return docs;
}
type Manifest = Record<string, any>;
function packageEntries(docs: Docs, manifestEdit?: (manifest: Manifest) => void, extra: Entry[] = []): Entry[] {
  const files: Entry[] = [
    { name: "ruleset.json", data: Buffer.from(JSON.stringify(docs.ruleset, null, 2)) },
    ...Object.entries(docs.catalogs).map(([id, catalog]) => ({
      name: `catalogs/${id}.json`,
      data: Buffer.from(JSON.stringify(catalog)),
    })),
  ];
  const manifest: Manifest = {
    schemaVersion: 2,
    id: "ember-roads-house",
    name: "Ember Roads (house)",
    version: "1.0.0",
    description: "",
    engine: { min: "2.4.0", maxExclusive: "3.0.0" },
    kind: ["ruleset"],
    entrypoints: {},
    contributions: { assets: { paths: files.map((file) => file.name) } },
    files: files.map((file) => ({ path: file.name, sha256: sha256(file.data!), bytes: file.data!.length })),
    permissions: [],
    restartRequired: false,
    capabilityApi: { major: 1, minor: 78 },
    builtAgainst: { engineVersion: "2.4.6", engineCommit: "0".repeat(40) },
  };
  manifestEdit?.(manifest);
  return [{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) }, ...files, ...extra];
}
const zipOf = (docs: Docs, manifestEdit?: (manifest: Manifest) => void, extra: Entry[] = []) =>
  rawZip(packageEntries(docs, manifestEdit, extra));
/** A package whose ruleset.json is exactly this text, its manifest listing it truly. */
function zipOfTexts(rulesetText: string, catalogs: Docs["catalogs"]): Buffer {
  const entries = packageEntries({ ruleset: packageDocs().ruleset, catalogs });
  const data = Buffer.from(rulesetText);
  const manifest = JSON.parse(entries[0]!.data!.toString("utf8")) as Manifest;
  const listed = manifest.files.find((file: { path: string }) => file.path === "ruleset.json");
  listed.sha256 = sha256(data);
  listed.bytes = data.length;
  return rawZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    { name: "ruleset.json", data },
    ...entries.slice(2),
  ]);
}
const firstCatalog = (example.catalogs as Array<{ id: string; entries: unknown[] }>)[0]!;

const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { setCustomAgentImportsEnabled } =
  await import("../../packages/server/src/services/agents/custom-agent-import-policy.service.js");
const { gameRulesetsRoutes } = await import("../../packages/server/src/routes/game-rulesets.routes.js");
const { capabilityPackagesRoutes } = await import("../../packages/server/src/routes/capability-packages.routes.js");
const { gameRulesetCatalogs } = await import("../../packages/server/src/db/schema/index.js");
const { readRulesetPackageZip } = await import("../../packages/server/src/services/game/ruleset-package-zip.js");
const { createChatsStorage } = await import("../../packages/server/src/services/storage/chats.storage.js");
const { loadRulesetCatalogEntries } =
  await import("../../packages/server/src/services/game/ruleset-catalog.service.js");
const { readRulesetRegistry } = await import("../../packages/server/src/services/game/ruleset-registry.service.js");

try {
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameRulesetsRoutes, { prefix: "/api/game-rulesets" });
  await app.register(capabilityPackagesRoutes, { prefix: "/api/capability-packages" });
  try {
    const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({ method: "POST", url: `/api/game-rulesets${url}`, payload: payload as never, headers });
    const importZip = (zip: Buffer, dryRun?: boolean) =>
      post("/import-package", { zip: zip.toString("base64"), ...(dryRun ? { dryRun } : {}) });
    const refusal = (zip: Buffer) => {
      const read = readRulesetPackageZip(zip);
      assert.equal(read.ok, false, "refused");
      return (read as { issues: string[] }).issues.join(" | ");
    };
    const storedCatalogs = async () => ((await db.select().from(gameRulesetCatalogs)) as unknown[]).length;

    // ── What a zip may hold, and nothing else ──
    const good = zipOf(packageDocs());
    assert.equal(readRulesetPackageZip(good).ok, true, refusal.toString());
    assert.match(refusal(Buffer.from("not a zip at all")), /not a zip/);
    assert.match(refusal(Buffer.alloc(8 * 1024 * 1024 + 1)), /over the 8388608-byte limit/);
    const many = rawZip(
      Array.from({ length: 15 }, (_, n) => ({ name: `catalogs/c${n}.json`, data: Buffer.from("{}") })),
    );
    assert.match(refusal(many), /15 entries; a ruleset package has at most 14/);
    for (const name of [
      "payload.js",
      "../ruleset.json",
      "catalogs/../x.json",
      "/ruleset.json",
      "Catalogs/x.json",
      "catalogs/X.json",
      "catalogs/a b.json",
      "README.md",
      "catalogs/nested/x.json",
    ]) {
      assert.match(
        refusal(zipOf(packageDocs(), undefined, [{ name, data: Buffer.from("{}") }])),
        /is not a file a ruleset package has/,
        name,
      );
    }
    assert.match(
      refusal(zipOf(packageDocs(), undefined, [{ name: "evil.exe/", data: Buffer.from("MZ") }])),
      /"evil.exe\/" is not a file/,
    );
    assert.match(refusal(zipOf(packageDocs(), undefined, [{ name: "other/", method: 0 }])), /"other\/" is not a file/);
    assert.equal(
      readRulesetPackageZip(zipOf(packageDocs(), undefined, [{ name: "catalogs/", method: 0 }])).ok,
      true,
      "an empty catalogs/ is fine",
    );
    assert.match(
      refusal(zipOf(packageDocs(), undefined, [{ name: "catalogs/", data: Buffer.from("x"), method: 0 }])),
      /"catalogs\/" is not a file/,
    );
    const [manifestEntry, rulesetEntry, catalogEntry] = packageEntries(packageDocs());
    assert.match(
      refusal(rawZip([manifestEntry!, { ...rulesetEntry!, flags: 1 }, catalogEntry!])),
      /"ruleset.json" in the zip archive is encrypted/,
    );
    assert.match(
      refusal(rawZip([manifestEntry!, { ...rulesetEntry!, attr: (0o120777 << 16) >>> 0 }, catalogEntry!])),
      /is a link/,
    );
    assert.match(refusal(rawZip([manifestEntry!, rulesetEntry!, rulesetEntry!, catalogEntry!])), /twice|does not read/);
    assert.match(
      refusal(rawZip([manifestEntry!, { ...rulesetEntry!, method: 12 }, catalogEntry!])),
      /compressed in a way/,
    );
    // A STORED entry whose directory claims a small size returns all its bytes in adm-zip: refused (by the
    // Engine's strict zip reader, which this one reads through).
    assert.match(
      refusal(rawZip([manifestEntry!, { ...rulesetEntry!, method: 0, declared: 10 }, catalogEntry!])),
      /says two different sizes/,
    );
    // A deflated entry claiming more than its file may hold.
    assert.match(
      refusal(rawZip([manifestEntry!, rulesetEntry!, { ...catalogEntry!, declared: 2 * 1024 * 1024 }])),
      /over its 1048576-byte limit/,
    );
    // Two directory records over the same bytes.
    assert.match(refusal(rawZip([manifestEntry!, rulesetEntry!, { ...catalogEntry!, offset: 0 }])), /shares its data/);
    // A record the end count leaves out, still in the directory: refused, not skipped.
    assert.match(
      refusal(
        rawZip([manifestEntry!, rulesetEntry!, catalogEntry!, { name: "payload.js", data: Buffer.from("x") }], {
          count: 3,
        }),
      ),
      /holds more than its entries/,
    );
    // A name beside the data that is not the directory's.
    assert.match(
      refusal(rawZip([manifestEntry!, { ...rulesetEntry!, localName: "evil/run.exe" }, catalogEntry!])),
      /named or packed one way/,
    );
    // Data before the first record, inside a local extra field, or a comment after the end.
    assert.match(
      refusal(rawZip([manifestEntry!, rulesetEntry!, catalogEntry!], { prefix: Buffer.from("MZ junk") })),
      /lies beside it/,
    );
    assert.equal(
      readRulesetPackageZip(rawZip([manifestEntry!, { ...rulesetEntry!, localExtra: Buffer.alloc(8) }, catalogEntry!]))
        .ok,
      true,
      "an extra field is part of its record",
    );
    assert.match(refusal(rawZip([manifestEntry!, rulesetEntry!, catalogEntry!], { comment: "hello" })), /comment/);
    assert.match(refusal(Buffer.concat([good.subarray(0, 40), good])), /not a zip|lies beside|directory/);
    assert.match(
      refusal(rawZip([manifestEntry!, { name: "ruleset.json", data: Buffer.from([0xff, 0xfe, 0x00]) }, catalogEntry!])),
      /not UTF-8/,
    );
    assert.match(refusal(rawZip([manifestEntry!, { ...rulesetEntry!, crc: 12345 }, catalogEntry!])), /damaged/);
    // Data no entry names, between the last record and the directory.
    assert.match(
      refusal(rawZip([manifestEntry!, rulesetEntry!, catalogEntry!], { gap: Buffer.from("payload") })),
      /data no entry names/,
    );
    // A deflated entry that grows far past the size it declares stops inflating at that size: 50 MB of
    // zeros packed into about 50 KB, under a record that claims 100 bytes.
    const bomb = deflateRawSync(Buffer.alloc(50 * 1024 * 1024));
    assert.ok(bomb.length < 1024 * 1024, "a bomb small enough to pass the caps");
    const bombed = rawZip([
      manifestEntry!,
      rulesetEntry!,
      { name: catalogEntry!.name, method: 8, body: bomb, data: Buffer.alloc(100) },
    ]);
    assert.match(refusal(bombed), /bigger than it says/);

    // ── The shared parsers guard their own shape, whatever reads them (a package's installed files too) ──
    const plainDefinition = parseRulesetDefinition(packageDocs().ruleset);
    assert.ok(plainDefinition.ok, JSON.stringify(plainDefinition).slice(0, 300));
    const startedParse = Date.now();
    const bombRead = parseRulesetCatalogFile(plainDefinition.definition, firstCatalog.id, {
      schemaVersion: 1,
      catalog: firstCatalog.id,
      entries: Array.from({ length: 300_000 }, () => ({})),
    });
    assert.ok(
      !bombRead.ok && /more than any part of a ruleset has/.test(bombRead.issues[0]!),
      JSON.stringify(bombRead).slice(0, 200),
    );
    assert.ok(Date.now() - startedParse < 3000, "refused before the schema reads every item");
    let nested: unknown = [];
    for (let depth = 0; depth < 5000; depth++) nested = [nested];
    const deepRead = parseRulesetDefinition({ ...packageDocs().ruleset, deep: nested });
    assert.ok(
      !deepRead.ok && /nested deeper than a ruleset ever is/.test(deepRead.issues[0]!),
      "never a stack overflow",
    );

    // ── A manifest that is a ruleset's and nothing more ──
    const manifestRefusal = (edit: (manifest: Manifest) => void) => refusal(zipOf(packageDocs(), edit));
    assert.match(
      manifestRefusal((m) => (m.kind = ["ruleset", "agent"])),
      /of the kind ruleset alone/,
    );
    assert.match(
      manifestRefusal((m) => (m.entrypoints = { client: "client.js" })),
      /no entrypoints \(no code\)/,
    );
    assert.match(
      manifestRefusal((m) => (m.permissions = ["routes"])),
      /asks for no permissions/,
    );
    assert.match(
      manifestRefusal((m) => (m.localizations = { fr: { name: "x" } })),
      /no localizations/,
    );
    assert.match(
      manifestRefusal((m) => (m.restartRequired = true)),
      /needs no restart/,
    );
    assert.match(
      manifestRefusal((m) => (m.contributions.slots = ["chat-settings"])),
      /contributes its assets and nothing else/,
    );
    assert.match(
      manifestRefusal((m) => m.contributions.assets.paths.pop()),
      /its assets are not/,
    );
    assert.match(
      manifestRefusal((m) => (m.files[0].sha256 = "0".repeat(64))),
      /is not the file it lists/,
    );
    assert.match(
      manifestRefusal((m) => m.files.pop()),
      /its files are not|must be listed in the package file manifest/,
    );
    assert.match(
      manifestRefusal((m) => (m.id = "Not An Id")),
      /manifest.json id/,
    );
    assert.match(refusal(rawZip(packageEntries(packageDocs()).slice(1))), /no manifest.json/);

    // ── The ruleset and its catalogs, read strictly, and nothing more than a ruleset ──
    assert.match(refusal(zipOf(packageDocs((docs) => delete docs.ruleset.sheet))), /ruleset.json/);
    assert.match(
      refusal(zipOf(packageDocs((docs) => (docs.ruleset.combat = { $comment: "x".repeat(2001) })))),
      /^ruleset\.json combat\.\$comment: a \$comment is a note of at most 2000/,
    );
    // A note as long as the cap reads, and every example the docs ship travels as a package (their
    // notes run to 878 characters; 5e-2014's to 1,016).
    assert.ok(readRulesetPackageZip(zipOf(packageDocs((docs) => (docs.ruleset.$comment = "x".repeat(2000))))).ok);
    const examplesDir = new URL("../../docs/examples/rulesets/", import.meta.url);
    for (const file of readdirSync(examplesDir).filter((name) => name.endsWith(".json"))) {
      const ruleset = JSON.parse(readFileSync(new URL(file, examplesDir), "utf8")) as Record<string, unknown>;
      const read = readRulesetPackageZip(zipOf({ ruleset, catalogs: {} }));
      assert.ok(read.ok, `${file}: ${JSON.stringify(read).slice(0, 300)}`);
    }
    assert.match(
      refusal(zipOf(packageDocs((docs) => (docs.ruleset.$schema = "https://evil.example/s.json")))),
      /\$schema may only name/,
    );
    assert.equal(
      readRulesetPackageZip(
        zipOf(
          packageDocs(
            (docs) =>
              (docs.ruleset.$schema =
                "https://raw.githubusercontent.com/Pasta-Devs/Marinara-Engine/staging/docs/extending/ruleset.schema.json"),
          ),
        ),
      ).ok,
      true,
      "the Engine's own schema",
    );
    assert.match(
      refusal(
        zipOf(
          packageDocs((docs) => ((docs.catalogs[firstCatalog.id] as { entries: unknown[] }).entries = [{ nope: 1 }])),
        ),
      ),
      new RegExp(`catalogs/${firstCatalog.id}.json`),
    );
    assert.match(
      refusal(
        zipOf(packageDocs((docs) => (docs.catalogs.extra = { schemaVersion: 1, catalog: "extra", entries: [] }))),
      ),
      /not a catalog the ruleset names/,
    );
    assert.match(refusal(zipOf(packageDocs((docs) => delete docs.catalogs[firstCatalog.id]))), /no catalogs\//);
    // Nesting deeper than a ruleset is, and a list longer than any it has: refused before the schema
    // reads them, never a crash or a long stall.
    const plainText = JSON.stringify(packageDocs().ruleset);
    const deepText = plainText.replace('"coverage":{', `"coverage":{"deep":${"[".repeat(5000)}${"]".repeat(5000)},`);
    assert.match(refusal(zipOfTexts(deepText, packageDocs().catalogs)), /nested deeper than a ruleset ever is/);
    const started = Date.now();
    assert.match(
      refusal(
        zipOf(
          packageDocs(
            (docs) =>
              ((docs.catalogs[firstCatalog.id] as { entries: unknown[] }).entries = Array.from(
                { length: 300_000 },
                () => ({}),
              )),
          ),
        ),
      ),
      /300000 items, more than any part/,
    );
    assert.ok(Date.now() - started < 3000, "refused before the schema reads every item");
    // A repeated key: only what was read is kept, never the bytes the parse dropped (a 200 KB $comment
    // the last, short one hides).
    const rulesetText = JSON.stringify(packageDocs().ruleset);
    const hidden = `{"$comment":"${"x".repeat(200_000)}","$comment":"short",${rulesetText.slice(1)}`;
    const twiceRead = readRulesetPackageZip(zipOfTexts(hidden, packageDocs().catalogs));
    assert.ok(twiceRead.ok, JSON.stringify(twiceRead).slice(0, 300));
    assert.ok(!twiceRead.ruleset.includes("x".repeat(1000)) && twiceRead.ruleset.length < 100_000, "kept as read");
    // Two catalog files whose ids share a beginning (sorted one way by code unit, another by a locale).
    const prefixed = zipOf(
      packageDocs((docs) => {
        const second = {
          ...structuredClone((example.catalogs as Array<Record<string, any>>)[0]),
          id: `${firstCatalog.id}_extra`,
          label: "More knacks",
        };
        delete second.entries;
        second.asset = `catalogs/${second.id}.json`;
        docs.ruleset.catalogs.push(second);
        docs.catalogs[second.id] = { schemaVersion: 1, catalog: second.id, entries: firstCatalog.entries.slice(0, 2) };
      }),
    );
    assert.equal(readRulesetPackageZip(prefixed).ok, true, refusal.name);

    // ── Imported: privileged, behind the policy, a dry run keeps nothing ──
    const untrusted = await post("/import-package", { zip: good.toString("base64") }, { host: "evil.example" });
    assert.equal(untrusted.statusCode, 421);
    await setCustomAgentImportsEnabled(db, false);
    const refusedByPolicy = await importZip(good);
    assert.equal(refusedByPolicy.statusCode, 403);
    // Its own code, so an editor tells it from the privileged gate's 403.
    assert.equal(refusedByPolicy.json().code, "custom_agent_imports_disabled");
    await setCustomAgentImportsEnabled(db, true);
    const dry = await importZip(good, true);
    assert.equal(dry.statusCode, 200, dry.body);
    assert.deepEqual(
      [dry.json().status, dry.json().rulesetId, dry.json().catalogs],
      ["checked", "local/ember-roads-house", { [firstCatalog.id]: firstCatalog.entries.length }],
    );
    assert.equal(JSON.parse(dry.json().ruleset).id, "ember-roads-house");
    assert.equal(await storedCatalogs(), 0, "a dry run keeps nothing");
    const bad = await importZip(zipOf(packageDocs(), (m) => (m.entrypoints = { server: "x.js" })));
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /no entrypoints/);
    const added = await importZip(good);
    assert.equal(added.statusCode, 200, added.body);
    assert.equal(added.json().status, "added");
    assert.equal((await importZip(good)).json().status, "unchanged");

    // ── Played: its catalog file read like a package's ──
    const listed = (await app.inject({ method: "GET", url: "/api/capability-packages/rulesets" })).json() as Array<{
      definition: { id: string };
      versions?: number[];
    }>;
    assert.ok(
      listed.some((entry) => entry.definition.id === "local/ember-roads-house"),
      JSON.stringify(listed.map((e) => e.definition.id)),
    );
    const catalog = await app.inject({
      method: "GET",
      url: `/api/capability-packages/rulesets/catalog?rulesetId=local/ember-roads-house&catalogId=${firstCatalog.id}&version=1`,
    });
    assert.equal(catalog.statusCode, 200, catalog.body);
    assert.equal(catalog.json().entries.length, firstCatalog.entries.length);
    assert.ok(catalog.headers.etag, "with a validator from its sha256");

    // ── A version is its ruleset and its catalogs ──
    const otherCatalog = zipOf(
      packageDocs(
        (docs) => ((docs.catalogs[firstCatalog.id] as { entries: unknown[] }).entries = firstCatalog.entries.slice(1)),
      ),
    );
    const conflict = await importZip(otherCatalog);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().code, "ruleset_version_conflict");
    // Version 2 keeps the catalog: stored once.
    const v2 = await importZip(zipOf(packageDocs((docs) => (docs.ruleset.version = 2))));
    assert.equal(v2.json().status, "added", v2.body);
    assert.equal(await storedCatalogs(), 1, "one catalog file for both versions");
    // Version 3 with a changed catalog: two files kept.
    const v3 = await importZip(
      zipOf(
        packageDocs((docs) => {
          docs.ruleset.version = 3;
          (docs.catalogs[firstCatalog.id] as { entries: unknown[] }).entries = firstCatalog.entries.slice(1);
        }),
      ),
    );
    assert.equal(v3.json().status, "added", v3.body);
    assert.equal(await storedCatalogs(), 2);

    // ── An editor reads them back, as written ──
    const source = await app.inject({
      method: "GET",
      url: "/api/game-rulesets/source?rulesetId=local/ember-roads-house&version=1",
    });
    assert.equal(source.statusCode, 200, source.body);
    assert.equal(JSON.parse(source.json().ruleset).id, "ember-roads-house");
    assert.deepEqual(JSON.parse(source.json().catalogs[firstCatalog.id]).entries, firstCatalog.entries);
    assert.equal(
      (await app.inject({ method: "GET", url: "/api/game-rulesets/source?rulesetId=local/nothing&version=1" }))
        .statusCode,
      404,
    );
    // ── The schema an editor builds its forms from: exactly the one the Engine publishes ──
    const schemaRead = await app.inject({ method: "GET", url: "/api/game-rulesets/schema" });
    assert.equal(schemaRead.statusCode, 200, schemaRead.body);
    assert.match(String(schemaRead.headers["content-type"]), /application\/json/);
    assert.deepEqual(
      schemaRead.json(),
      JSON.parse(readFileSync(new URL("../../docs/extending/ruleset.schema.json", import.meta.url), "utf8")),
    );

    // ── Played by a game: its catalog file through the loader every turn and fight uses ──
    const registered = (await readRulesetRegistry(db)).get("local/ember-roads-house");
    assert.ok(registered, "registered");
    const definition = registered.versions?.get(1) ?? registered.definition;
    const header = definition.catalogs!.find((each) => each.id === firstCatalog.id)!;
    const loaded = await loadRulesetCatalogEntries(null, definition, header);
    assert.ok(loaded.ok && loaded.entries.length > 0, JSON.stringify(loaded).slice(0, 300));

    // ── Another ruleset with the same catalog file: kept once, and kept while either names it ──
    const sibling = await importZip(zipOf(packageDocs((docs) => (docs.ruleset.id = "ember-roads-sibling"))));
    assert.equal(sibling.json().status, "added", sibling.body);
    assert.equal(await storedCatalogs(), 2, "the sibling shares version 1's catalog file");

    // ── A version a game plays on is not removed alone; one no game pins is ──
    const chats = createChatsStorage(db);
    const pinned = await chats.create({ name: "On version 2", mode: "game", characterIds: [] });
    await chats.patchMetadata(pinned.id, {
      gameRuleset: { id: "local/ember-roads-house", version: 2, packageId: null, options: {} },
    });
    const refusedOne = await app.inject({
      method: "DELETE",
      url: "/api/game-rulesets?rulesetId=local/ember-roads-house&version=2",
    });
    assert.equal(refusedOne.statusCode, 409);
    assert.equal(refusedOne.json().code, "ruleset_in_use");

    // ── One version no game pins goes alone; the last version takes its catalog file with it ──
    const removeOne = await app.inject({
      method: "DELETE",
      url: "/api/game-rulesets?rulesetId=local/ember-roads-house&version=3",
    });
    assert.equal(removeOne.statusCode, 200, removeOne.body);
    assert.equal(await storedCatalogs(), 1, "the changed catalog went with version 3");
    assert.equal(
      (await app.inject({ method: "DELETE", url: "/api/game-rulesets?rulesetId=local/ember-roads-house&version=3" }))
        .statusCode,
      404,
    );
    // Every version, the game on one of them confirmed: the file stays while the sibling names it.
    const removeAll = await app.inject({
      method: "DELETE",
      url: "/api/game-rulesets?rulesetId=local/ember-roads-house&force=true",
    });
    assert.deepEqual([removeAll.json().removed, removeAll.json().games], [2, 1]);
    assert.equal(await storedCatalogs(), 1, "the sibling still names the shared file");
    const siblingCatalog = await app.inject({
      method: "GET",
      url: `/api/capability-packages/rulesets/catalog?rulesetId=local/ember-roads-sibling&catalogId=${firstCatalog.id}&version=1`,
    });
    assert.equal(siblingCatalog.statusCode, 200, siblingCatalog.body);
    await app.inject({ method: "DELETE", url: "/api/game-rulesets?rulesetId=local/ember-roads-sibling" });
    assert.equal(await storedCatalogs(), 0, "and goes with the last version that names it");

    // ── The JSON import still keeps its catalogs inline ──
    const asJson = await post("/import", { definition: JSON.stringify(packageDocs().ruleset) });
    assert.equal(asJson.statusCode, 400);
    assert.match(asJson.json().error, /carries its catalogs inline, as "entries", or comes as a package zip/);

    // ── Checked without saving: issues where they point, the least capability API ──
    const checked = await post("/check", { definition: JSON.stringify(example) });
    assert.equal(checked.statusCode, 200, checked.body);
    assert.equal(checked.json().ok, true);
    assert.ok(checked.json().capabilityApi.minor >= 20, JSON.stringify(checked.json().capabilityApi));
    const broken = structuredClone(example);
    broken.sheet.skills[0].ability = "nope";
    const brokenCheck = (await post("/check", { definition: JSON.stringify(broken) })).json();
    assert.equal(brokenCheck.ok, false);
    assert.ok(
      brokenCheck.issues.some((issue: { path: string }) => issue.path.startsWith("sheet.skills.0")),
      JSON.stringify(brokenCheck.issues),
    );
    const zipCheck = (await post("/check", { zip: good.toString("base64") })).json();
    assert.equal(zipCheck.ok, true);
    assert.deepEqual(Object.keys(zipCheck.catalogs), [firstCatalog.id], "a zip comes back read");
    // Reading a package costs work: only the Engine's own pages may ask.
    assert.equal(
      (await post("/check", { definition: JSON.stringify(example) }, { host: "evil.example" })).statusCode,
      421,
    );
    const zipRefused = (await post("/check", { zip: many.toString("base64") })).json();
    assert.equal(zipRefused.ok, false);
    assert.equal((await post("/check", { zip: "not base64 !!" })).statusCode, 400);
    assert.equal(await storedCatalogs(), 0, "checking keeps nothing");
  } finally {
    await app.close();
    await closeDB();
  }
  console.log("Ruleset package zips: read whole or refused, kept as data with their catalog files, never run.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
