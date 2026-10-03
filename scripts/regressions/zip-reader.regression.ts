/**
 * The strict zip reader every archive the Engine did not make goes through (capability packages,
 * repository archives, .charx and .marinara files).
 *
 * What is pinned here:
 *   - Zips the Engine meets read as before: adm-zip's own, `git archive`'s (a comment, folders), and
 *     ones with data descriptors (sizes left out of the local records), extra fields and gaps.
 *   - A dishonest archive is refused before anything in it is read: entries sharing one stretch of
 *     data (so a size budget over the declared sizes could be spent many times over), a stored entry
 *     whose two sizes differ, a local record that is not its directory record's, a record hidden past
 *     the count, data running into the directory, ZIP64, split and encrypted archives, trailing bytes.
 *   - Reading an entry takes a cap, refuses an entry over it unread, stops inflating at the declared
 *     size (a bomb that claims to be small is refused fast and small), and checks the CRC.
 *   - The callers: a package or repository archive that shares data is refused, and a .charx whose
 *     card.json claims or unpacks past its limit is refused instead of read.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import AdmZip from "adm-zip";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-zip-reader-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";

const { readZip, ZipReadError } = await import("../../packages/server/src/lib/zip-reader.js");
const { validatePackageArchiveEntries } =
  await import("../../packages/server/src/services/capability-packages/package-manager.service.js");
const { parseCustomAgentRepositoryContents } =
  await import("../../packages/server/src/services/agents/custom-agent-repositories.service.js");
const { importCharX, inspectCharX } =
  await import("../../packages/server/src/services/import/st-character.importer.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { importRoutes } = await import("../../packages/server/src/routes/import.routes.js");
const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify") as typeof import("fastify").default;
const multipart = requireServer("@fastify/multipart");

// ── A zip, byte by byte, so every field can be what a hostile one would make it ──
type Entry = {
  name: string;
  data?: Buffer;
  /** 0 stored, 8 deflated. */
  method?: number;
  /** The size the directory claims, when it lies. */
  declared?: number;
  flags?: number;
  /** The Unix type and mode. */
  mode?: number;
  /** What the directory says made the archive (high byte 3 is Unix, 0 is DOS). */
  madeBy?: number;
  /** Where the directory says its local record is, when it lies. */
  offset?: number;
  /** The name beside the data, when it is not the directory's. */
  localName?: string;
  localExtra?: Buffer;
  /** The checksum the records claim, when it lies. */
  crc?: number;
  /** The packed bytes as they are, instead of `data` packed by `method`. */
  body?: Buffer;
  /** Sizes and checksum left out of the local record and written after the data instead. */
  descriptor?: boolean;
};
type Shape = { count?: number; comment?: string; gap?: Buffer; trailing?: Buffer; directoryPad?: Buffer };
function localRecord(entry: Entry): Buffer {
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
  local.writeUInt16LE((entry.flags ?? 0) | (entry.descriptor ? 8 : 0), 6);
  local.writeUInt16LE(method, 8);
  if (!entry.descriptor) {
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
  }
  local.writeUInt16LE(localName.length, 26);
  local.writeUInt16LE(localExtra.length, 28);
  const parts = [local, localName, localExtra, body];
  if (entry.descriptor) {
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(body.length, 8);
    descriptor.writeUInt32LE(size, 12);
    parts.push(descriptor);
  }
  return Buffer.concat(parts);
}
function rawZip(entries: Entry[], shape: Shape = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 8;
    const body = entry.body ?? (method === 8 ? deflateRawSync(data) : data);
    const record = localRecord(entry);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.madeBy ?? 0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE((entry.flags ?? 0) | (entry.descriptor ? 8 : 0), 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(entry.crc ?? crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.declared ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(entry.offset ?? offset, 42);
    if (entry.offset === undefined) {
      locals.push(record);
      offset += record.length;
    }
    centrals.push(central, name);
  }
  if (shape.gap) {
    locals.push(shape.gap);
    offset += shape.gap.length;
  }
  const directory = Buffer.concat(centrals);
  const pad = shape.directoryPad ?? Buffer.alloc(0);
  const comment = Buffer.from(shape.comment ?? "");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(shape.count ?? entries.length, 8);
  end.writeUInt16LE(shape.count ?? entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, pad, end, comment, shape.trailing ?? Buffer.alloc(0)]);
}
const refusal = (zip: Buffer) => {
  try {
    readZip(zip);
  } catch (error) {
    assert.ok(error instanceof ZipReadError, `a ZipReadError, not ${String(error)}`);
    return (error as Error).message;
  }
  return assert.fail("refused");
};
const readRefusal = (zip: Buffer, name: string, cap: number) => {
  const file = readZip(zip).find((entry) => entry.name === name)!;
  try {
    file.read(cap);
  } catch (error) {
    assert.ok(error instanceof ZipReadError, `a ZipReadError, not ${String(error)}`);
    return (error as Error).message;
  }
  return assert.fail("read refused");
};
const text = (value: string) => Buffer.from(value, "utf8");
/** The archive with one field rewritten: `at` counts from the end record, the first directory record
 *  or the first local record. */
const patched = (zip: Buffer, where: "end" | "directory" | "local", at: number, value: number, bytes: 2 | 4) => {
  const copy = Buffer.from(zip);
  const end = copy.length - 22;
  const base = where === "end" ? end : where === "directory" ? copy.readUInt32LE(end + 16) : 0;
  if (bytes === 2) copy.writeUInt16LE(value, base + at);
  else copy.writeUInt32LE(value, base + at);
  return copy;
};

try {
  // ── Zips the Engine meets read as before ──
  const made = new AdmZip();
  made.addFile("manifest.json", text('{"id":"x"}'));
  made.addFile("art/", Buffer.alloc(0));
  made.addFile("art/tile.png", Buffer.alloc(5000, 7));
  // Listed in its directory's order (adm-zip sorts it).
  const madeFiles = new Map(readZip(made.toBuffer()).map((file) => [file.name, file]));
  assert.deepEqual([...madeFiles.values()].map((file) => [file.name, file.isDirectory]).sort(), [
    ["art/", true],
    ["art/tile.png", false],
    ["manifest.json", false],
  ]);
  assert.equal(madeFiles.get("manifest.json")!.read(1024).toString("utf8"), '{"id":"x"}');
  assert.deepEqual(madeFiles.get("art/tile.png")!.read(5000), Buffer.alloc(5000, 7));

  // `git archive` (a repository archive is one): its comment is the commit, and its folders are listed.
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const gitZip = execFileSync("git", ["archive", "--format=zip", "HEAD", "--", "package.json", "docs/FAQ.md"], {
    cwd: repoRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  const gitFiles = readZip(gitZip);
  for (const path of ["package.json", "docs/FAQ.md"]) {
    const file = gitFiles.find((entry) => entry.name === path);
    assert.ok(file, `${path} is in the git archive`);
    assert.equal(
      file.read(16 * 1024 * 1024).toString("utf8"),
      execFileSync("git", ["show", `HEAD:${path}`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
    );
  }
  assert.ok(
    gitFiles.some((entry) => entry.name === "docs/" && entry.isDirectory),
    "folders are listed",
  );

  // Data descriptors, extra fields, a gap before the directory and a comment.
  const loose = readZip(
    rawZip(
      [
        { name: "a.txt", data: text("first"), descriptor: true },
        { name: "b.txt", data: text("second"), method: 0, localExtra: Buffer.alloc(9, 1) },
        { name: "empty.txt", body: Buffer.alloc(0) },
        // An empty file as JSZip, fflate and Python write it: a two-byte deflate stream for nothing.
        { name: "empty-deflated.txt", body: Buffer.from([3, 0]) },
      ],
      { gap: Buffer.alloc(7), comment: "0123456789abcdef0123456789abcdef01234567" },
    ),
  );
  assert.deepEqual(
    loose.map((file) => file.read(100).toString("utf8")),
    ["first", "second", "", ""],
  );
  assert.equal(
    readZip(rawZip([{ name: "link", data: text("target"), method: 0, mode: 0o120777 }]))[0]!.isSymlink,
    true,
    "a link is reported, never followed",
  );
  assert.equal(
    readZip(rawZip([{ name: "link", data: text("target"), method: 0, mode: 0o120777, madeBy: 0x0014 }]))[0]!.isSymlink,
    true,
    "whatever the archive says made it",
  );

  // ── A dishonest archive is refused before anything in it is read ──
  const big = Buffer.alloc(1024 * 1024, 3);
  // Many directory records naming one local record: a budget over the declared sizes would be spent
  // once per record.
  const shared = rawZip([
    { name: "data.bin", data: big, method: 0 },
    ...Array.from({ length: 50 }, () => ({ name: "data.bin", data: big, method: 0, offset: 0 })),
  ]);
  assert.match(refusal(shared), /shares its data/);
  // One entry's local record inside another's stored data (a zip inside a zip).
  const inner = localRecord({ name: "b.bin", data: big, method: 0 });
  const nested = rawZip([
    { name: "a.bin", data: inner, method: 0 },
    { name: "b.bin", data: big, method: 0, offset: 30 + "a.bin".length },
  ]);
  assert.match(refusal(nested), /shares its data/);
  // A stored entry that declares less than it holds.
  assert.match(refusal(rawZip([{ name: "a.bin", data: big, method: 0, declared: 10 }])), /says two different sizes/);
  assert.match(refusal(rawZip([{ name: "a.txt", data: text("x"), localName: "b.txt" }])), /named or packed one way/);
  const one = rawZip([{ name: "a.txt", data: text("x") }]);
  assert.match(
    refusal(patched(one, "local", 8, 0, 2)),
    /named or packed one way/,
    "the local method is the directory's",
  );
  // Split across disks: by the end record, or by an entry's own starting disk.
  assert.match(refusal(patched(one, "end", 4, 1, 2)), /split across disks/);
  assert.match(refusal(patched(one, "end", 6, 1, 2)), /split across disks/);
  assert.match(refusal(patched(one, "directory", 34, 1, 2)), /split across disks/);
  // ZIP64, by any of its marks.
  assert.match(refusal(patched(one, "end", 16, 0xffffffff, 4)), /ZIP64/);
  assert.match(refusal(patched(one, "directory", 42, 0xffffffff, 4)), /ZIP64/);
  assert.match(refusal(patched(one, "directory", 20, 0xffffffff, 4)), /ZIP64/);
  // A record past the count, hidden from a reader that trusts the count.
  assert.match(
    refusal(
      rawZip(
        [
          { name: "a.txt", data: text("x") },
          { name: "b.txt", data: text("y") },
        ],
        { count: 1 },
      ),
    ),
    /holds more than its entries/,
  );
  assert.match(
    refusal(rawZip([{ name: "a.txt", data: text("x") }], { directoryPad: Buffer.alloc(4) })),
    /directory is not where it says/,
  );
  assert.match(refusal(rawZip([{ name: "a.txt", data: text("x"), flags: 1 }])), /encrypted/);
  assert.match(refusal(rawZip([{ name: "a.txt", data: text("x"), declared: 0xffffffff }])), /ZIP64/);
  assert.match(
    refusal(rawZip([{ name: "a.txt", data: text("x") }], { trailing: Buffer.alloc(3) })),
    /has data after its end/,
  );
  assert.match(refusal(text("not a zip at all")), /not a zip/);
  assert.match(refusal(Buffer.alloc(0)), /not a zip/);
  // Data running into the directory.
  const overrun = rawZip([{ name: "a.bin", data: Buffer.alloc(64), method: 0 }]);
  overrun.writeUInt32LE(5000, 18); // the local size is not read; the directory's is
  const directoryAt = overrun.readUInt32LE(overrun.length - 22 + 16);
  overrun.writeUInt32LE(5000, directoryAt + 20);
  overrun.writeUInt32LE(5000, directoryAt + 24);
  assert.match(refusal(overrun), /runs into its directory/);

  // ── Reading takes a cap and stops at the declared size ──
  assert.match(readRefusal(made.toBuffer(), "art/tile.png", 4999), /over the 4999-byte limit/);
  const bombBody = deflateRawSync(Buffer.alloc(50 * 1024 * 1024));
  const before = process.memoryUsage().arrayBuffers;
  assert.match(
    readRefusal(
      rawZip([{ name: "card.json", body: bombBody, data: Buffer.alloc(100), declared: 100 }]),
      "card.json",
      1024,
    ),
    /bigger than it says/,
  );
  assert.ok(process.memoryUsage().arrayBuffers - before < 16 * 1024 * 1024, "refused without holding it all");
  assert.match(readRefusal(rawZip([{ name: "a.txt", data: text("hello"), crc: 1 }]), "a.txt", 100), /damaged/);
  // Shorter than it says, its checksum made to match what it holds: still not the size it says.
  assert.match(
    readRefusal(
      rawZip([{ name: "a.txt", body: deflateRawSync(text("hello")), data: text("hello"), declared: 10 }]),
      "a.txt",
      100,
    ),
    /not the size it says/,
  );
  assert.match(
    readRefusal(rawZip([{ name: "a.txt", data: text("hello"), method: 12, body: text("hello") }]), "a.txt", 100),
    /compressed in a way/,
  );

  // ── The callers ──
  assert.throws(() => validatePackageArchiveEntries(shared), /shares its data/);
  assert.throws(
    () => validatePackageArchiveEntries(rawZip([{ name: "client.js", data: text("/etc/passwd"), mode: 0o120777 }])),
    /links are not allowed/,
  );
  const repositoryShared = rawZip([
    { name: "repo-main/agents.json", data: text("[]"), method: 0 },
    ...Array.from({ length: 5 }, () => ({ name: "repo-main/agents.json", data: text("[]"), method: 0, offset: 0 })),
  ]);
  assert.throws(() => parseCustomAgentRepositoryContents(repositoryShared), /shares its data/);
  const card = { spec: "chara_card_v3", data: { name: "Zip Card", description: "", first_mes: "" } };
  const charx = new AdmZip();
  charx.addFile("card.json", text(JSON.stringify(card)));
  assert.equal(inspectCharX(charx.toBuffer()).success, true, "a .charx reads as before");
  // card.json claiming more than any upload may hold (no byte cap of a card's own, #5625), or unpacking
  // past what it claims.
  const claimsHuge = inspectCharX(
    rawZip([{ name: "card.json", body: deflateRawSync(text("{}")), data: text("{}"), declared: 300 * 1024 * 1024 }]),
  );
  assert.equal(claimsHuge.success, false);
  assert.match(String(claimsHuge.error), /over the \d+-byte limit/);
  const unpacksHuge = inspectCharX(
    rawZip([{ name: "card.json", body: bombBody, data: Buffer.alloc(100), declared: 100 }]),
  );
  assert.equal(unpacksHuge.success, false);
  assert.match(String(unpacksHuge.error), /bigger than it says/);
  // A damaged image is no image: the card still imports, as one whose image is missing does.
  const damagedIcon = rawZip([
    {
      name: "card.json",
      data: text(
        JSON.stringify({
          ...card,
          data: {
            ...card.data,
            name: "Damaged Icon",
            assets: [{ type: "icon", uri: "embeded://assets/icon.png", name: "main", ext: "png" }],
          },
        }),
      ),
    },
    { name: "assets/icon.png", data: Buffer.alloc(64, 9), crc: 1 },
  ]);
  const imported = await importCharX(damagedIcon, await getDB());
  assert.equal(imported.success, true, JSON.stringify(imported));
  // A card.json that is not JSON is a failed import, said, never a thrown error.
  const notJson = await importCharX(rawZip([{ name: "card.json", data: text("{ not json") }]), await getDB());
  assert.equal(notJson.success, false);
  assert.match(String(notJson.error), /card\.json is not valid JSON/);

  // ── A .marinara package through its route: a dishonest one, or one with a damaged avatar, is a 400 ──
  const app = Fastify();
  app.decorate("db", await getDB());
  await app.register(multipart);
  await app.register(importRoutes, { prefix: "/api/import" });
  const uploadPackage = (bytes: Buffer) => {
    const boundary = `zip-${Date.now().toString(36)}`;
    return app.inject({
      method: "POST",
      url: "/api/import/marinara-package",
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.marinara"\r\nContent-Type: application/octet-stream\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    });
  };
  try {
    const persona = text(JSON.stringify({ type: "marinara_persona", version: 1, data: { name: "Zip Persona" } }));
    const honest = await uploadPackage(rawZip([{ name: "data.json", data: persona }]));
    assert.equal(honest.statusCode, 200, honest.body);
    const dishonest = await uploadPackage(
      rawZip([
        { name: "data.json", data: persona, method: 0 },
        { name: "avatar.png", data: persona, method: 0, offset: 0 },
      ]),
    );
    assert.equal(dishonest.statusCode, 400, dishonest.body);
    assert.match(dishonest.json().error, /Could not read \.marinara package/);
    const damagedAvatar = await uploadPackage(
      rawZip([
        { name: "data.json", data: persona },
        { name: "avatar.png", data: Buffer.alloc(64, 9), crc: 1 },
      ]),
    );
    assert.equal(damagedAvatar.statusCode, 400, damagedAvatar.body);
    assert.match(damagedAvatar.json().error, /Could not read \.marinara package: .*damaged/);
  } finally {
    await app.close();
  }

  console.log("zip-reader: ok");
} finally {
  await closeDB();
  rmSync(dataDir, { recursive: true, force: true });
}
