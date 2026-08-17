import assert from "node:assert/strict";
import { validateImageAssetBuffer } from "../../packages/server/src/utils/media-file-security.js";

// Regression for issue Marinara-Agents#392: v2.4.2's media-security gate started
// rejecting valid raster images whose file extension disagreed with their true
// format (Noodle stamps generated post images `.png`, but qwen-image returns
// WebP/JPEG bytes). The serve route must accept the bytes and report the detected
// Content-Type, not 404.

// WebP header: "RIFF" + 4-byte size + "WEBP".
const webpBytes = Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from("WEBP", "ascii"),
]);

const mislabeled = validateImageAssetBuffer(webpBytes, "post-image.png");
assert.notEqual(mislabeled, null, "WebP bytes named .png must validate");
assert.equal(mislabeled?.mimeType, "image/webp", "Content-Type must reflect detected format");
assert.equal(mislabeled?.isSvg, false);

// A correctly-labeled PNG still serves as image/png.
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = validateImageAssetBuffer(pngBytes, "avatar.png");
assert.equal(png?.mimeType, "image/png");

// Non-image bytes are still rejected even under a raster extension.
assert.equal(validateImageAssetBuffer(Buffer.from("hello", "ascii"), "fake.png"), null);

console.log("gallery-mislabeled-raster regression passed");
