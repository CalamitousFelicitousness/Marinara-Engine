// ──────────────────────────────────────────────
// Regression: sprite pixelize post-processing (#5096)
// ──────────────────────────────────────────────
// Pins the deterministic contract: byte-stable output for identical input,
// palette quantization that only emits ramp colors, strictly binary alpha,
// seam scoring that accepts tileable fixtures and rejects seamed ones, and
// input bounds that reject before allocation.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  pixelizeImage,
  PixelizeInputError,
  PIXELIZE_MAX_INPUT_DIMENSION,
} from "../../packages/server/src/services/image/pixelize.service.js";

const requireFromServer = createRequire(new URL("../../packages/server/package.json", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharp: any = requireFromServer("sharp");

function rawImage(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer() as Promise<Buffer>;
}

async function decodeRaw(png: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function main() {
  // Noisy anti-aliased-looking gradient with soft alpha — the shape AI output has.
  const noisy = await rawImage(64, 64, (x, y) => [
    (x * 4) % 256,
    (y * 4) % 256,
    ((x + y) * 2) % 256,
    x < 4 ? 40 : 200 + ((x + y) % 40),
  ]);
  const ramp = ["#3e7a44", "#b39764", "#2e5f8a", "#f3efe2", "#22261f"];

  // 1) Determinism: identical input + options → identical bytes.
  const once = await pixelizeImage(noisy, { targetWidth: 16, palette: ramp });
  const twice = await pixelizeImage(noisy, { targetWidth: 16, palette: ramp });
  assert.ok(once.png.equals(twice.png), "pixelize must be byte-deterministic");
  assert.equal(once.report.width, 16);
  assert.equal(once.report.height, 16);
  assert.equal(once.report.paletteSize, ramp.length);

  // 2) Quantization + binary alpha: every opaque pixel is a ramp color, every
  //    alpha is exactly 0 or 255, and transparent pixels are normalized.
  const rampSet = new Set(ramp.map((c) => c.toLowerCase()));
  const decoded = await decodeRaw(once.png);
  for (let i = 0; i < decoded.data.length; i += 4) {
    const alpha = decoded.data[i + 3]!;
    assert.ok(alpha === 0 || alpha === 255, "alpha must be strictly binary");
    if (alpha === 255) {
      const hex = `#${[decoded.data[i], decoded.data[i + 1], decoded.data[i + 2]]
        .map((v) => v!.toString(16).padStart(2, "0"))
        .join("")}`;
      assert.ok(rampSet.has(hex), `opaque pixel ${hex} must be a palette color`);
    } else {
      assert.ok(
        decoded.data[i] === 0 && decoded.data[i + 1] === 0 && decoded.data[i + 2] === 0,
        "transparent pixels must be normalized to rgba(0,0,0,0)",
      );
    }
  }

  // 3) Seam scoring: a solid tile wraps perfectly; a hard vertical split does not.
  const solid = await rawImage(32, 32, () => [62, 122, 68, 255]);
  const solidResult = await pixelizeImage(solid, { targetWidth: 16, palette: ramp });
  assert.equal(solidResult.report.tileable, true, "a solid tile must score as tileable");
  const split = await rawImage(32, 32, (x) => (x < 16 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  const splitResult = await pixelizeImage(split, { targetWidth: 16 });
  assert.equal(splitResult.report.tileable, false, "a hard left/right split must fail the seam check");
  assert.ok(splitResult.report.seamScoreX < 0.5, "the X seam must score low for a split tile");
  assert.ok(splitResult.report.seamScoreY > 0.9, "the Y seam should wrap for a vertically-uniform tile");

  // 4) Input bounds reject BEFORE allocation, with the typed error.
  const oversized = await sharp({
    create: { width: PIXELIZE_MAX_INPUT_DIMENSION + 1, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    pixelizeImage(oversized, { targetWidth: 16 }),
    PixelizeInputError,
    "oversized input must be rejected with the typed input error",
  );
  await assert.rejects(pixelizeImage(noisy, { targetWidth: 0 }), PixelizeInputError);
  await assert.rejects(pixelizeImage(noisy, { targetWidth: 16, palette: ["not-a-color"] }), PixelizeInputError);

  // 5) Invalid/truncated image bytes decode to a typed error (route HTTP 400),
  //    not a bare Sharp failure (HTTP 500). Route validation can pass base64 that
  //    is not a real image; the failure can surface at metadata() (garbage) or at
  //    the decode toBuffer() (a valid header with a truncated body).
  await assert.rejects(
    pixelizeImage(Buffer.from("this is not image data, just bytes"), { targetWidth: 16 }),
    PixelizeInputError,
    "undecodable bytes must be a typed input error, not a bare 500",
  );
  await assert.rejects(
    pixelizeImage(noisy.subarray(0, noisy.length - 16), { targetWidth: 16 }),
    PixelizeInputError,
    "a truncated image (header reads, decode fails) must be a typed input error, not a bare 500",
  );

  // 6) A height DERIVED from a tall input's aspect ratio must be bounded like an
  //    explicit one: reject before allocating the oversized RGBA buffer. Here an
  //    8x1024 input with targetWidth 512 derives a 65536px height (>> the 512
  //    output bound), yet the input itself is comfortably within input bounds.
  const tall = await rawImage(8, 1024, () => [10, 20, 30, 255]);
  await assert.rejects(
    pixelizeImage(tall, { targetWidth: 512 }),
    PixelizeInputError,
    "a derived output height above the output bound must be rejected before decoding",
  );

  console.log("pixelize regression passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
