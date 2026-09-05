// A profile import must accept the marker files the app itself writes.
//
// seed-game-assets.ts drops an empty `.native` file into every bundled
// game-asset directory on boot, so every export carries them. The import
// validator classifies everything under `game-assets/sprites/` as an image, so
// it refused the marker and failed the entire import with "Profile asset
// game-assets/sprites/.native is not a supported image file". Nothing the user
// did produced that file, and nothing they could do would remove it: the next
// boot writes it back.
//
// The allowance is bounded by size. An empty file cannot be served as anything;
// a non-empty one under the same name is not a marker and stays refused, so the
// exemption cannot be used to smuggle content past the image check.
//
// Implementation is upstream's (#5587). Upstream's
// profile-import-asset-security lane pins the flat game-assets/sprites/
// case; this one pins the root and nested-depth marker paths.
//
// Since #5625 a per-asset validation failure is reported rather than thrown:
// the staged file is removed, the path lands in `skipped`, and the rest of the
// profile still restores. Refusal is therefore asserted as absence from
// `assets` plus a reason in `skipped`, not as a rejected promise.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  stageProfileImportAssets,
  cleanupStagedProfileAssets,
} from "../../packages/server/src/services/import/profile-import-assets.ts";

const root = await mkdtemp(join(tmpdir(), "marinara-profile-native-marker-"));

const stageOne = (path: string, contents: Buffer) =>
  stageProfileImportAssets(root, [{ path, expectedSize: contents.byteLength, read: () => contents }], 10 * 1024 * 1024);

try {
  // ── The marker imports ──
  for (const path of [
    "game-assets/sprites/.native",
    "game-assets/.native",
    "game-assets/music/combat/.native",
  ]) {
    const staged = await stageOne(path, Buffer.alloc(0));
    assert.equal(staged.assets.length, 1, `${path}: an empty marker must import`);
    await cleanupStagedProfileAssets(staged);
  }

  // ── A non-empty file under that name is not a marker ──
  {
    const staged = await stageOne("game-assets/sprites/.native", Buffer.from("GIF89a totally an image"));
    assert.equal(staged.assets.length, 0, "content hiding under the marker name must not import");
    assert.match(
      staged.skipped[0]?.message ?? "",
      /not a supported image file/u,
      "content hiding under the marker name is still checked as an image",
    );
    await cleanupStagedProfileAssets(staged);
  }

  // ── Real images still have to be real ──
  {
    const staged = await stageOne("game-assets/sprites/pretend.png", Buffer.from("not actually a png"));
    assert.equal(staged.assets.length, 0, "the image check is untouched for everything else");
    await cleanupStagedProfileAssets(staged);
  }

  console.info("Profile import native marker regression passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
