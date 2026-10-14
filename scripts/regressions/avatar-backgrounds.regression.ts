/**
 * 2D avatars never show a background. From a sprite drawn on a flat, opaque background:
 *   - the sprite's cut-out is made once by the sprite background cleanup and stored in the avatar's own
 *     folder; the sprite file stays byte for byte as it was, and a sprite that already has a see-through
 *     background is used as it is (no copy);
 *   - the AI remover is used when it is the configured engine, and the built-in cleaner when it is missing,
 *     fails or is turned off (Lite and Termux);
 *   - blink and talk pictures are drawn on the cut-out and come back with exactly its outline, whether the
 *     image model fills the background in or leaves it see-through, and saving stores the cut-out as their
 *     base, so a blink never flickers a background or a halo;
 *   - a PNGTuber Plus costume drawn on a background of its own is stored as cut-outs whose talk and blink
 *     pictures keep the base's edge wherever they don't change;
 *   - a mesh avatar's layers are cut from the cut-out, so its base picture has no background;
 *   - the avatar shows a sprite face as its cut-out (GET /sprite-cutouts/:label), an already see-through or
 *     animated sprite as the sprite itself, and saved avatar files are never rewritten when they load.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plusSave, plusSprite } from "./fixtures/avatar-2d-fixtures.js";

const dataDir = mkdtempSync(join(tmpdir(), "marinara-avatar-backgrounds-"));
process.env.DATA_DIR = dataDir;
process.env.FILE_STORAGE_DIR = join(dataDir, "storage");
process.env.NODE_ENV = "test";
process.env.MARINARA_LITE = "true";
process.env.IMAGE_LOCAL_URLS_ENABLED = "true";
process.env.LOG_LEVEL = "silent";
// No AI remover unless a test sets one up.
process.env.BACKGROUNDREMOVER_DISABLED = "true";

const requireServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
const Fastify = requireServer("fastify");
const AdmZip = requireServer("adm-zip");
const { getDB } = await import("../../packages/server/src/db/connection.js");
const { characterDataSchema } = await import("../../packages/shared/src/index.js");
const { createCharactersStorage } = await import("../../packages/server/src/services/storage/characters.storage.js");
const { createConnectionsStorage } = await import("../../packages/server/src/services/storage/connections.storage.js");
const { getSharp } = await import("../../packages/server/src/services/image/sharp-runtime.js");
const { avatarOwnerDir, readAvatarConfig, writeAvatarFiles, updateAvatarConfig } =
  await import("../../packages/server/src/services/avatars/storage.js");
const { avatarCutout, avatarSpriteCutout, spriteCutoutPath } =
  await import("../../packages/server/src/services/avatars/cutouts.js");
const { readAvatarSourceSprite } =
  await import("../../packages/server/src/services/avatars/generation/generation-context.js");
const { generatePngtuberVariants, savePngtuberVariants } =
  await import("../../packages/server/src/services/avatars/generation/pngtuber-variants.js");
const { generateMeshRig } = await import("../../packages/server/src/services/avatars/generation/mesh-rig.js");
const { pngtuberImporter } = await import("../../packages/server/src/services/avatars/formats/pngtuber.js");
const { avatarModelsRoutes } = await import("../../packages/server/src/routes/avatar-models.routes.js");
const sharp = await getSharp();

// ── Fixtures: a front-facing bust, on a flat background and as a cut-out ──
const SKIN = "rgb(242,201,168)";
function bustSvg(background: string | null, mouthOpen = false) {
  const eye = (cx: number) =>
    `<ellipse cx="${cx}" cy="285" rx="30" ry="14" fill="#fff"/><circle cx="${cx}" cy="285" r="11" fill="rgb(59,109,179)"/>` +
    `<circle cx="${cx}" cy="285" r="5" fill="#111"/><path d="M${cx - 34} 284 Q${cx} 260 ${cx + 34} 284" stroke="#222" stroke-width="4" fill="none"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="720">
    ${background ? `<rect width="600" height="720" fill="${background}"/>` : ""}
    <rect x="120" y="540" width="360" height="200" rx="60" fill="#3a5fa0"/>
    <rect x="262" y="440" width="76" height="130" fill="${SKIN}"/>
    <ellipse cx="300" cy="250" rx="190" ry="210" fill="#5a3a22"/>
    <ellipse cx="300" cy="300" rx="130" ry="160" fill="${SKIN}"/>
    <rect x="220" y="240" width="62" height="8" rx="4" fill="#4a2f1c"/><rect x="318" y="240" width="62" height="8" rx="4" fill="#4a2f1c"/>
    ${eye(250)}${eye(350)}
    ${mouthOpen ? `<ellipse cx="300" cy="397" rx="18" ry="11" fill="#7a2a2a"/>` : `<path d="M275 395 Q300 400 325 395" stroke="#a04848" stroke-width="3" fill="none"/>`}
  </svg>`);
}
const opaqueBust = await sharp(bustSvg("#ffffff")).png().toBuffer();
const cutoutBust = await sharp(bustSvg(null)).png().toBuffer();
const goodLayout = {
  headBox: [110, 40, 490, 470],
  faceBox: [170, 140, 430, 460],
  eyes: [
    { opening: [321, 272, 379, 298], region: [310, 255, 390, 308] },
    { opening: [221, 272, 279, 298], region: [210, 255, 290, 308] },
  ],
  brows: [
    [318, 238, 380, 250],
    [220, 238, 282, 250],
  ],
  nose: [300, 340],
  mouth: { left: [275, 395], right: [325, 395], box: [272, 388, 328, 402] },
  neck: [300, 490],
};

async function rgba(png: Buffer) {
  return sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
async function alphaAt(png: Buffer, x: number, y: number) {
  const { data, info } = await rgba(png);
  return data[(y * info.width + x) * 4 + 3]!;
}
async function alphaChannel(png: Buffer) {
  return sharp(png).ensureAlpha().extractChannel(3).raw().toBuffer();
}
/** Corners and the face's middle: see-through around the bust, solid on it. */
async function assertCutout(png: Buffer, what: string) {
  for (const [x, y] of [
    [2, 2],
    [597, 2],
    [2, 600],
    [597, 717],
    [40, 360],
  ] as const) {
    assert.equal(await alphaAt(png, x, y), 0, `${what}: the background at ${x},${y} is see-through`);
  }
  for (const [x, y] of [
    [300, 330],
    [300, 600],
    [250, 285],
  ] as const) {
    assert.equal(await alphaAt(png, x, y), 255, `${what}: the bust at ${x},${y} stays solid`);
  }
}
const dataUrlPng = (url: string) => Buffer.from(url.slice(url.indexOf(",") + 1), "base64");

// ── Providers: an image model and a vision model on one local server ──
let imageMode: "fill-background" | "see-through" = "fill-background";
let imageRequests = 0;
const provider = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  response.setHeader("content-type", "application/json");
  if (request.url?.endsWith("/chat/completions")) {
    response.end(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(goodLayout) } }] }),
    );
    return;
  }
  imageRequests += 1;
  // An edit that keeps the picture where it is (the canvas GPT Image 1 is asked for, for a 600x720 sprite),
  // with the background filled in white like most image models, or left see-through.
  const start = body.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const sent = body.subarray(start, body.indexOf(Buffer.from("IEND"), start) + 8);
  let picture = sharp(sent).resize(1024, 1536, { fit: "cover" });
  if (imageMode === "fill-background") picture = picture.flatten({ background: "#ffffff" });
  response.end(JSON.stringify({ data: [{ b64_json: (await picture.png().toBuffer()).toString("base64") }] }));
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`;

const db = await getDB();
const character = await createCharactersStorage(db).create(
  characterDataSchema.parse({ name: "Ann", description: "x" }),
);
const owner = { ownerType: "character" as const, ownerId: character!.id };
const connections = createConnectionsStorage(db);
const image = await connections.create({
  name: "Image fixture",
  provider: "image_generation",
  baseUrl: providerUrl,
  model: "gpt-image-1",
  imageService: "openai",
  imageGenerationSource: "openai",
  apiKey: "fixture",
});
const vision = await connections.create({
  name: "Vision fixture",
  provider: "custom",
  baseUrl: providerUrl,
  model: "vision",
  apiKey: "fixture",
});
const spriteDir = join(dataDir, "sprites", owner.ownerId);
mkdirSync(spriteDir, { recursive: true });
const frame = (color: string) => sharp(bustSvg(color)).resize(60, 72).png().toBuffer();
const animated = await sharp([await frame("#ffffff"), await frame("#eeeeee")], { join: { animated: true } })
  .gif()
  .toBuffer();
writeFileSync(join(spriteDir, "neutral.png"), opaqueBust);
writeFileSync(join(spriteDir, "cutout.png"), cutoutBust);
writeFileSync(join(spriteDir, "wave.gif"), animated);
const folder = join(avatarOwnerDir(owner), "pngtuber");

try {
  // ── The sprite's cut-out ──
  {
    const sprite = await readAvatarSourceSprite(owner.ownerId, "neutral");
    const cut = await avatarSpriteCutout(owner, sprite);
    await assertCutout(cut.png, "the sprite's cut-out");
    assert.equal(cut.transparent, true);
    assert.equal(cut.hash, sprite.hash, "the cut-out stays tied to the sprite version it came from");
    const stored = join(avatarOwnerDir(owner), spriteCutoutPath(sprite.hash));
    assert.deepEqual(readFileSync(stored), cut.png, "it is stored in the avatar's own folder");
    assert.deepEqual(readFileSync(join(spriteDir, "neutral.png")), opaqueBust, "the sprite itself is untouched");
    writeFileSync(stored, cutoutBust);
    assert.deepEqual(
      (await avatarSpriteCutout(owner, sprite)).png,
      cutoutBust,
      "a stored cut-out is reused, not made again",
    );
    writeFileSync(stored, cut.png);

    const already = await readAvatarSourceSprite(owner.ownerId, "cutout");
    assert.equal(await avatarSpriteCutout(owner, already), already, "a see-through sprite is used as it is");
    assert.ok(!existsSync(join(avatarOwnerDir(owner), spriteCutoutPath(already.hash))), "and gets no copy");
  }

  // ── Engines: the AI remover when configured, the built-in cleaner without it ──
  {
    const lite = await avatarCutout(opaqueBust);
    assert.equal(lite.cleaned, true);
    await assertCutout(lite.png, "the built-in cleaner (no AI remover, as on Lite and Termux)");
    if (process.platform !== "win32") {
      const tools = mkdtempSync(join(tmpdir(), "marinara-fake-bgrem-"));
      const marker = join(tools, "ran");
      const fake = join(tools, "backgroundremover");
      // Called as `backgroundremover -i <in> -o <out>`; answers with the bust's true cut-out.
      writeFileSync(join(tools, "answer.png"), cutoutBust);
      writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\ncp "${join(tools, "answer.png")}" "$4"\n`);
      chmodSync(fake, 0o755);
      const failing = join(tools, "broken");
      writeFileSync(failing, "#!/bin/sh\nexit 3\n");
      chmodSync(failing, 0o755);
      const savedPath = process.env.PATH;
      delete process.env.BACKGROUNDREMOVER_DISABLED;
      process.env.SPRITE_BACKGROUND_REMOVAL_ENGINE = "backgroundremover";
      try {
        process.env.BACKGROUNDREMOVER_COMMAND = fake;
        const ai = await avatarCutout(opaqueBust);
        assert.ok(existsSync(marker), "the AI remover runs when it is the configured engine");
        await assertCutout(ai.png, "the AI remover's cut-out");
        process.env.BACKGROUNDREMOVER_COMMAND = failing;
        await assertCutout((await avatarCutout(opaqueBust)).png, "a failing AI remover falls back to the built-in");
        delete process.env.BACKGROUNDREMOVER_COMMAND;
        const empty = join(tools, "empty");
        mkdirSync(empty);
        process.env.PATH = empty; // and none on PATH
        await assertCutout((await avatarCutout(opaqueBust)).png, "a missing AI remover falls back to the built-in");
      } finally {
        process.env.PATH = savedPath;
        delete process.env.SPRITE_BACKGROUND_REMOVAL_ENGINE;
        delete process.env.BACKGROUNDREMOVER_COMMAND;
        process.env.BACKGROUNDREMOVER_DISABLED = "true";
        rmSync(tools, { recursive: true, force: true });
      }
    }
  }

  // ── PNGTuber blink and talk pictures from the opaque sprite ──
  {
    const cut = readFileSync(
      join(avatarOwnerDir(owner), spriteCutoutPath((await readAvatarSourceSprite(owner.ownerId, "neutral")).hash)),
    );
    const cutAlpha = await alphaChannel(cut);
    const drafts = [];
    for (const mode of ["fill-background", "see-through"] as const) {
      imageMode = mode;
      const response = await generatePngtuberVariants(db, {
        owner,
        labels: ["neutral"],
        variants: ["eyes-closed", "mouth-open"],
        connectionId: image.id,
      });
      assert.equal(response.drafts.length, 2, response.failed.map((entry) => entry.error).join("; "));
      for (const draft of response.drafts) {
        const png = dataUrlPng(draft.image);
        await assertCutout(
          png,
          `a ${draft.variant} picture when the model ${mode === "fill-background" ? "fills the background" : "leaves it see-through"}`,
        );
        assert.deepEqual(
          await alphaChannel(png),
          cutAlpha,
          "it has exactly the cut-out's outline (no flicker or halo)",
        );
      }
      drafts.push(...response.drafts);
    }
    const saved = await savePngtuberVariants({
      owner,
      images: drafts
        .slice(0, 2)
        .map(({ label, variant, image, sourceHash }) => ({ label, variant, image, sourceHash })),
    });
    const layers = saved.config.kinds.pngtuber!.layers.neutral!;
    const file = (ref: { source: string } | undefined) =>
      readFileSync(join(avatarOwnerDir(owner), (ref as { path: string }).path));
    assert.deepEqual(file(layers.base), cut, "the saved base is the sprite's cut-out");
    for (const ref of [layers.eyesClosed, layers.mouthOpen]) {
      await assertCutout(file(ref), "a saved blink or talk picture");
      assert.deepEqual(await alphaChannel(file(ref)), cutAlpha);
    }
    // A kept picture that comes back with a background (a draft made before this change) is cut on save.
    const old = await savePngtuberVariants({
      owner,
      images: [{ ...drafts[0]!, image: `data:image/png;base64,${opaqueBust.toString("base64")}` }],
    });
    await assertCutout(file(old.config.kinds.pngtuber!.layers.neutral!.eyesClosed), "a kept picture with a background");
    assert.deepEqual(readFileSync(join(spriteDir, "neutral.png")), opaqueBust, "the sprite is still untouched");

    // A sprite that is already a cut-out keeps its own outline.
    imageMode = "fill-background";
    const own = await generatePngtuberVariants(db, {
      owner,
      labels: ["cutout"],
      variants: ["eyes-closed"],
      connectionId: image.id,
    });
    assert.deepEqual(await alphaChannel(dataUrlPng(own.drafts[0]!.image)), await alphaChannel(cutoutBust));
  }

  // ── A PNGTuber Plus costume drawn on a background ──
  {
    const backdrop = await sharp({ create: { width: 600, height: 720, channels: 4, background: "#ffffff" } })
      .png()
      .toBuffer();
    const talkMouth = await sharp(bustSvg(null, true))
      .extract({ left: 260, top: 380, width: 80, height: 40 })
      .png()
      .toBuffer();
    const save = plusSave([
      plusSprite(1, backdrop, { zindex: -1 }),
      plusSprite(2, cutoutBust),
      // The open mouth shows only while talking, over the closed one.
      plusSprite(3, talkMouth, { pos: "Vector2(0, 40)", showTalk: 2, zindex: 1 }),
    ]);
    const input = { owner, filename: "avatar.save", bytes: save };
    const imported = await pngtuberImporter.extract(await pngtuberImporter.validate(input), input);
    const files = new Map(imported.files.map((entry) => [entry.path, Buffer.from(entry.bytes)]));
    const set = imported.data.layers.costume_1!;
    const base = files.get((set.base as { path: string }).path)!;
    const talk = files.get((set.mouthOpen as { path: string }).path)!;
    await assertCutout(base, "an imported costume drawn on a background");
    await assertCutout(talk, "its talk picture");
    const [baseRaw, talkRaw] = [await rgba(base), await rgba(talk)];
    let differing = 0;
    for (let i = 0; i < baseRaw.data.length; i += 4) {
      const x = (i / 4) % baseRaw.info.width;
      const y = Math.floor(i / 4 / baseRaw.info.width);
      const inMouth = x >= 255 && x <= 345 && y >= 375 && y <= 425;
      if (!inMouth && baseRaw.data.readUInt32LE(i) !== talkRaw.data.readUInt32LE(i)) differing += 1;
    }
    assert.equal(differing, 0, "outside what talking changes, the talk picture is the base's cut-out exactly");
    assert.equal(await alphaAt(talk, 300, 397), 255, "the open mouth stays");
  }

  // ── A mesh avatar from the opaque sprite ──
  {
    const draft = await generateMeshRig(db, { owner, sourceLabel: "neutral", connectionId: vision.id });
    const zip = new AdmZip(Buffer.from(draft.archive, "base64"));
    const basePicture = zip.getEntry("built/base.png")!.getData() as Buffer;
    await assertCutout(basePicture, "the mesh avatar's base picture");
    const meta = await sharp(basePicture).metadata();
    assert.deepEqual([meta.width, meta.height], [600, 720]);
    assert.deepEqual(readFileSync(join(spriteDir, "neutral.png")), opaqueBust, "the sprite is untouched");
  }

  // ── What the avatar shows, and saved files stay as saved ──
  {
    const app = Fastify();
    app.decorate("db", db);
    await app.register(avatarModelsRoutes, { prefix: "/api/avatar-models" });
    await app.ready();
    const get = (label: string) =>
      app.inject({ method: "GET", url: `/api/avatar-models/character/${owner.ownerId}/sprite-cutouts/${label}?v=1` });
    const face = await get("neutral");
    assert.equal(face.statusCode, 200);
    assert.match(String(face.headers["cache-control"]), /immutable/u, "one sprite version's cut-out never changes");
    await assertCutout(face.rawPayload, "the face the avatar shows");
    assert.deepEqual((await get("cutout")).rawPayload, cutoutBust, "a see-through sprite is shown as it is");
    assert.deepEqual((await get("wave")).rawPayload, animated, "an animated sprite keeps its frames");
    assert.equal((await get("missing")).statusCode, 404);
    assert.equal((await get("..%2Fneutral")).statusCode, 400);

    // A saved PNGTuber with an opaque picture (made before cut-outs) is shown as saved, never rewritten.
    await writeAvatarFiles(owner, [{ path: "pngtuber/old-base.png", bytes: opaqueBust }]);
    await updateAvatarConfig(owner, (current) => ({
      ...current!,
      kinds: {
        ...current!.kinds,
        pngtuber: {
          ...current!.kinds.pngtuber!,
          layers: { old: { base: { source: "file", path: "pngtuber/old-base.png" } } },
        },
      },
    }));
    const before = readFileSync(join(folder, "old-base.png"));
    const served = await app.inject({
      method: "GET",
      url: `/api/avatar-models/character/${owner.ownerId}/files/pngtuber/old-base.png`,
    });
    assert.equal(served.statusCode, 200);
    await readAvatarConfig(owner);
    assert.deepEqual(readFileSync(join(folder, "old-base.png")), before, "loading a saved avatar rewrites nothing");
    await app.close();
  }
} finally {
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
}
assert.ok(imageRequests > 0);
console.log("avatar backgrounds regression passed");
