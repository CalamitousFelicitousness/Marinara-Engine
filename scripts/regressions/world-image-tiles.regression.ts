/**
 * Image tile packs (tile pack v2, Pixelforge image tiles).
 *
 *   - A pack is PNG sheets on a grid of cells (a multiple of 16 pixels) and every tile a rect of whole
 *     cells in one of them: one cell, or a sprite of several. A sheet that is not a whole, undamaged PNG
 *     of its stated size, a rect past its sheet's edge, an unknown sheet, two sheets with one id, a cell
 *     size that is no multiple of 16, sheets over 16 megapixels together or over 6 MB are refused; a tile
 *     the Engine does not draw is left out and noted. Drawn (v1) packs read as before.
 *   - The library keeps an image pack like a drawn one (saved, imported, exported, chosen), its sheets
 *     re-encoded by the Engine where it can; the list says which packs are images; an image pack keeps
 *     its newest eight versions.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TILE_PACK_IMAGE_MAX_BYTES,
  parseTilePack,
  pngDataUrlCheck,
  type ImageTilePack,
  type TilePack,
} from "../../packages/shared/src/index.js";
import { imageTilePack, pngBytes, pngDataUrl } from "./fixtures/image-tile-pack.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-image-tiles-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.LOG_LEVEL = "silent";
const { default: Fastify } = await import("../../packages/server/node_modules/fastify/fastify.js");
const { getDB, closeDB } = await import("../../packages/server/src/db/connection.js");
const { gameTilePacksRoutes } = await import("../../packages/server/src/routes/game-tile-packs.routes.js");
const { IMAGE_PACK_VERSIONS_KEPT } =
  await import("../../packages/server/src/services/storage/game-tile-packs.storage.js");

const refused = (input: unknown, pattern: RegExp, label: string) => {
  const read = parseTilePack(input);
  assert.ok(!read.ok, `${label}: refused`);
  assert.ok(
    read.issues.some((issue) => pattern.test(issue)),
    `${label}: ${JSON.stringify(read.issues)}`,
  );
};

try {
  // ── The format ──
  const good = parseTilePack(imageTilePack());
  assert.ok(good.ok, JSON.stringify(!good.ok && good.issues));
  assert.equal(good.pack.tilePackVersion, 2);
  assert.ok(parseTilePack(JSON.stringify(imageTilePack())).ok, "read from a file's text");
  const sheet = imageTilePack().sheets[0]!;
  assert.deepEqual(pngDataUrlCheck(sheet.png), { width: 192, height: 96 }, "its size from its header");

  // A sheet's PNG checked whole without decoding it.
  const bytes = Buffer.from(sheet.png.slice("data:image/png;base64,".length), "base64");
  const damaged = Buffer.from(bytes);
  damaged[40] = damaged[40]! ^ 0xff;
  assert.match((pngDataUrlCheck(pngDataUrl(damaged)) as { issue: string }).issue, /damaged/);
  assert.match((pngDataUrlCheck(pngDataUrl(bytes.subarray(0, bytes.length - 6))) as { issue: string }).issue, /ends/);
  assert.match(
    (pngDataUrlCheck(pngDataUrl(Buffer.concat([bytes, Buffer.from([0])]))) as { issue: string }).issue,
    /after its end/,
  );
  assert.match((pngDataUrlCheck("data:image/png;base64,R0lGODlhAQABAAAAACw=") as { issue: string }).issue, /not a PNG/);
  const withSheet = (png: string, width = 192, height = 96) =>
    imageTilePack({ sheets: [{ id: "town", png, width, height }] });
  refused(withSheet(pngDataUrl(damaged)), /damaged/, "a damaged sheet");
  refused(withSheet(sheet.png, 192, 144), /is 192 x 96, not 192 x 144/, "a sheet of another size");
  refused(withSheet("data:image/jpeg;base64,AAAA"), /PNG data URL/, "not a PNG");
  refused(
    imageTilePack({ tiles: { house: [{ sheet: "town", x: 3, y: 0, w: 2, h: 2 }] } }),
    /reaches past the edge/,
    "a sprite past its sheet's edge",
  );
  refused(imageTilePack({ tiles: { grass: [{ sheet: "nope", x: 0, y: 0 }] } }), /no sheet "nope"/, "an unknown sheet");
  refused(imageTilePack({ sheets: [sheet, sheet] }), /Two sheets are called "town"/, "two sheets, one id");
  refused(imageTilePack({ tileSize: 40 }), /multiple of 16/, "a cell of 40 pixels");
  refused(imageTilePack({ tileSize: 112 }), /tileSize/, "a cell larger than 96");
  refused(
    imageTilePack({ tiles: { grass: [{ sheet: "town", x: 0, y: 0, w: 9 }] } }),
    /w/,
    "a sprite wider than eight cells",
  );
  // 16 megapixels across all sheets: five of 2048 x 2048 (about 21) is too many.
  const wide = pngDataUrl(pngBytes(2048, 2048, () => [0, 0, 0, 0]));
  refused(
    imageTilePack({
      sheets: Array.from({ length: 5 }, (_, at) => ({ id: `s${at}`, png: wide, width: 2048, height: 2048 })),
      tiles: { grass: [{ sheet: "s0", x: 0, y: 0 }] },
    }),
    /16,777,216 pixels/,
    "sheets over 16 megapixels",
  );
  // Over 6 MB of sheets.
  const noisy = pngBytes(1000, 1000, (x, y) => [(x * 7919 + y * 104729) % 251, (x * y) % 253, (x ^ y) % 255, 255]);
  const heavy = pngDataUrl(noisy);
  assert.ok(
    heavy.length < TILE_PACK_IMAGE_MAX_BYTES && heavy.length * 2 > TILE_PACK_IMAGE_MAX_BYTES,
    `${heavy.length}`,
  );
  refused(
    imageTilePack({
      sheets: Array.from({ length: 2 }, (_, at) => ({ id: `s${at}`, png: heavy, width: 1000, height: 1000 })),
      tiles: { grass: [{ sheet: "s0", x: 0, y: 0 }] },
    }),
    /The sheets are larger than a tile pack can be/,
    "sheets over 6 MB",
  );
  // Sheets just under the cap: the whole file (names and tiles beside them) is still read.
  const near = pngBytes(48, 48, () => [1, 2, 3, 255]);
  const base64For = (bytes: number) => Math.ceil(bytes / 3) * 4;
  const padTo = TILE_PACK_IMAGE_MAX_BYTES - 100 - "data:image/png;base64,".length;
  let pad = Math.floor((padTo * 3) / 4) - near.length - 20;
  while (base64For(pngBytes(48, 48, () => [1, 2, 3, 255], pad).length) + 22 > TILE_PACK_IMAGE_MAX_BYTES) pad -= 3;
  const full = imageTilePack({
    sheets: [{ id: "town", png: pngDataUrl(pngBytes(48, 48, () => [1, 2, 3, 255], pad)), width: 48, height: 48 }],
    tiles: { grass: [{ sheet: "town", x: 0, y: 0 }] },
  });
  const fullText = JSON.stringify(full, null, 2);
  assert.ok(fullText.length > TILE_PACK_IMAGE_MAX_BYTES, `(the file is over the sheets' cap: ${fullText.length})`);
  assert.ok(parseTilePack(fullText).ok, "a file whose sheets are within the cap reads");
  // A drawn pack has no whole-building sprite: left out and noted.
  const drawnHouse = parseTilePack({
    tilePackVersion: 1,
    id: "drawn-house",
    name: "Drawn",
    family: "fantasy",
    version: 1,
    palette: ["#336633"],
    tiles: { house: [Array.from({ length: 16 }, () => "0".repeat(16))] },
  });
  assert.ok(
    drawnHouse.ok && !("house" in drawnHouse.pack.tiles) && drawnHouse.notes.some((note) => /image pack/.test(note)),
  );
  // A tile the Engine does not draw is left out and noted.
  const extra = parseTilePack(
    imageTilePack({ tiles: { ...imageTilePack().tiles, dragon: [{ sheet: "town", x: 0, y: 0 }] } }),
  );
  assert.ok(extra.ok && !("dragon" in extra.pack.tiles) && extra.notes.some((note) => /dragon/.test(note)));
  // A drawn pack still reads, and a drawn pack over 1 MB is still refused.
  const rows = (char: string) => Array.from({ length: 16 }, () => char.repeat(16));
  const drawn: TilePack = {
    tilePackVersion: 1,
    id: "drawn",
    name: "Drawn",
    family: "fantasy",
    version: 1,
    palette: ["#336633"],
    tiles: { grass: [rows("0")] },
  };
  assert.ok(parseTilePack(drawn).ok);
  assert.ok(!parseTilePack(`${JSON.stringify(drawn)}${" ".repeat(1_000_001)}`).ok, "a drawn pack's own limit");

  // ── The library ──
  const db = await getDB();
  const app = Fastify();
  app.decorate("db", db);
  await app.register(gameTilePacksRoutes, { prefix: "/api/game-tile-packs" });
  try {
    const save = (body: unknown) =>
      app.inject({ method: "POST", url: "/api/game-tile-packs", payload: { pack: body } });
    const saved = await save(imageTilePack());
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().pack.id, "local/riverlands-art");
    const library = (await app.inject({ method: "GET", url: "/api/game-tile-packs" })).json();
    assert.deepEqual(
      library.packs.map((pack: { id: string; tilePackVersion: number }) => [pack.id, pack.tilePackVersion]),
      [["local/riverlands-art", 2]],
      "the list says it is an image pack",
    );
    const served = (
      await app.inject({ method: "GET", url: "/api/game-tile-packs/pack?id=local/riverlands-art" })
    ).json().pack as ImageTilePack;
    assert.equal(served.tilePackVersion, 2);
    assert.deepEqual(served.tiles, imageTilePack().tiles, "its tiles as saved");
    // Its sheet stored as a PNG of the same size (written again by the Engine where sharp is there).
    assert.deepEqual(pngDataUrlCheck(served.sheets[0]!.png), { width: 192, height: 96 });
    assert.equal((await save(served)).json().status, "unchanged", "saved back as it was read");
    // Imported from a file, and exported back as it is kept.
    const imported = await app.inject({
      method: "POST",
      url: "/api/game-tile-packs/import",
      payload: { definition: JSON.stringify(imageTilePack({ id: "shared-art", name: "Shared art" })) },
    });
    assert.equal(imported.statusCode, 200, imported.body);
    assert.equal(imported.json().pack.id, "local/shared-art");
    // A save that is no pack at all is refused, not an error.
    assert.equal((await app.inject({ method: "POST", url: "/api/game-tile-packs", payload: {} })).statusCode, 400);
    assert.equal((await save("text")).statusCode, 400);
    // A PNG whose structure is whole but whose pixels do not decode (its data is not compressed image
    // data) is refused where the Engine can decode sheets.
    const undecodable = Buffer.from(bytes);
    const idat = undecodable.indexOf(Buffer.from("IDAT"));
    const idatLength = undecodable.readUInt32BE(idat - 4);
    undecodable.fill(0x41, idat + 4, idat + 4 + idatLength);
    const { crc32 } = await import("node:zlib");
    undecodable.writeUInt32BE(crc32(undecodable.subarray(idat, idat + 4 + idatLength)) >>> 0, idat + 4 + idatLength);
    assert.ok(!("issue" in pngDataUrlCheck(pngDataUrl(undecodable))), "(its structure is whole)");
    const { getSharp } = await import("../../packages/server/src/services/image/sharp-runtime.js");
    const sharpHere = await getSharp().then(
      () => true,
      () => false,
    );
    assert.ok(sharpHere || process.platform === "android", "(sharp decodes here)");
    if (sharpHere) assert.equal((await save(withSheet(pngDataUrl(undecodable)))).statusCode, 400, "does not decode");
    // A damaged sheet is refused through the route as well.
    assert.equal((await save(withSheet(pngDataUrl(damaged)))).statusCode, 400);
    // Chosen for its family like any pack.
    const chosen = await app.inject({
      method: "PUT",
      url: "/api/game-tile-packs/selection",
      payload: { family: "fantasy", packId: "local/riverlands-art" },
    });
    assert.equal(chosen.statusCode, 200, chosen.body);

    // Its newest eight versions are kept.
    for (let version = 2; version <= IMAGE_PACK_VERSIONS_KEPT + 3; version++) {
      const next = await save(imageTilePack({ version, name: `Riverlands art ${version}` }));
      assert.equal(next.statusCode, 200, next.body);
    }
    const versions = (
      await db.select().from((await import("../../packages/server/src/db/schema/index.js")).gameTilePacks)
    )
      .filter((row: { packId: string }) => row.packId === "local/riverlands-art")
      .map((row: { version: number }) => row.version)
      .sort((a: number, b: number) => a - b);
    assert.deepEqual(
      versions,
      Array.from({ length: IMAGE_PACK_VERSIONS_KEPT }, (_, at) => at + 4),
      "the oldest versions dropped",
    );
    // A version older than every one kept would be dropped at once: refused, and nothing is lost.
    const tooOld = await save(imageTilePack({ version: 2, name: "Riverlands art again" }));
    assert.equal(tooOld.statusCode, 409, tooOld.body);
    assert.equal(tooOld.json().code, "tile_pack_version_too_old");
    // A drawn pack keeps every version.
    for (let version = 1; version <= IMAGE_PACK_VERSIONS_KEPT + 2; version++) await save({ ...drawn, version });
    const drawnVersions = (
      await db.select().from((await import("../../packages/server/src/db/schema/index.js")).gameTilePacks)
    ).filter((row: { packId: string }) => row.packId === "local/drawn").length;
    assert.equal(drawnVersions, IMAGE_PACK_VERSIONS_KEPT + 2, "every drawn version kept");
  } finally {
    await app.close();
    await closeDB();
  }

  console.log("World image tiles: image packs read, checked, kept and listed beside drawn ones.");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
