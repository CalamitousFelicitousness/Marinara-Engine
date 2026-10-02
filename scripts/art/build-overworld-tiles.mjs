#!/usr/bin/env node
// ──────────────────────────────────────────────
// The overworld's tiles (worldgen W8), drawn in code: every ground look, the settlement markers by
// size, a place in ruins and the party, for each setting family, from that family's palette. Shading,
// not outlines. Deterministic: the same script always writes the same pixels.
//
//   pnpm art:overworld   (node scripts/art/build-overworld-tiles.mjs)
//
// The Engine's own base set, replacing the placeholder tiles W8 began with (the user, 2026-10-02: our
// own base assets, and community asset packs later in the same format). Change the art here and rerun;
// the world-overworld lane checks the committed images are this script's.
//
// Writes packages/client/public/overworld/<family>.png (16 px tiles, 8 to a row) and the tile map
// packages/client/src/lib/overworld-atlases.json (a tile id to the indices of its variants).
// ──────────────────────────────────────────────
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const ROOT = process.env.OVERWORLD_TILES_OUT ?? join(dirname(fileURLToPath(import.meta.url)), "../..");
const T = 16;
const COLUMNS = 8;

// ── Pixels ──

const hex = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
const tile = () => new Uint8ClampedArray(T * T * 4);
function px(t, x, y, colour, alpha = 255) {
  if (!colour || x < 0 || y < 0 || x >= T || y >= T) return;
  const [r, g, b] = typeof colour === "string" ? hex(colour) : colour;
  const i = (Math.floor(y) * T + Math.floor(x)) * 4;
  if (alpha >= 255) {
    t.set([r, g, b, 255], i);
    return;
  }
  const a = alpha / 255;
  const under = t[i + 3] / 255;
  const out = a + under * (1 - a);
  if (out === 0) return;
  t[i] = (r * a + t[i] * under * (1 - a)) / out;
  t[i + 1] = (g * a + t[i + 1] * under * (1 - a)) / out;
  t[i + 2] = (b * a + t[i + 2] * under * (1 - a)) / out;
  t[i + 3] = out * 255;
}
const rect = (t, x, y, w, h, colour, alpha) => {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px(t, xx, yy, colour, alpha);
};
const fill = (t, colour) => rect(t, 0, 0, T, T, colour);
/** A sprite from rows of characters, each a palette role (or "." for nothing). */
function sprite(t, x0, y0, rows, colours) {
  rows.forEach((row, y) => [...row].forEach((c, x) => c !== "." && px(t, x0 + x, y0 + y, colours[c])));
}

// A number 0..1 for (x, y) and the nth thing drawn: the same tile always draws the same way.
function noise(x, y, n) {
  let h = Math.imul(x * 374761393 + y * 668265263 + n * 2246822519, 3266489917) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}
const speckle = (t, colour, count, seed, size = 1) => {
  for (let i = 0; i < count; i++)
    rect(
      t,
      Math.floor(noise(seed, i, 1) * (T - size + 1)),
      Math.floor(noise(seed, i, 2) * (T - size + 1)),
      size,
      size,
      colour,
    );
};

// ── Palettes: the colours each family is drawn in, by role ──

const PALETTES = {
  fantasy: {
    grass: "#6aa84f",
    grassLight: "#8cc265",
    grassDark: "#4f8a3c",
    leaf: "#3f8a3a",
    leafLight: "#5fae4c",
    leafDark: "#2c6630",
    trunk: "#6b4a2b",
    soil: "#9b7a4a",
    soilDark: "#7a5c36",
    crop: "#c9b458",
    cropDark: "#8fa443",
    sand: "#e0cc8e",
    sandDark: "#c8b06e",
    snow: "#eef3f7",
    snowShade: "#c9d6e2",
    rock: "#8f8a80",
    rockLight: "#b3ada2",
    rockDark: "#6a655d",
    water: "#3f78b8",
    waterLight: "#6a9fd6",
    waterDeep: "#2d5a94",
    wall: "#efe2c2",
    wallShade: "#cdbd98",
    roof: "#b5523b",
    roofShade: "#8a3a2a",
    door: "#5a3b22",
    stone: "#a8a294",
    stoneDark: "#7c776b",
    accent: "#d9b44a",
    skin: "#f1c9a5",
    hair: "#5a3b22",
    cloak: "#3a6fd8",
    cloakShade: "#28509e",
  },
  wuxia: {
    grass: "#7aaa5a",
    grassLight: "#9cc47a",
    grassDark: "#5c8c46",
    leaf: "#3d7a52",
    leafLight: "#5c9c6a",
    leafDark: "#2a5a3c",
    trunk: "#5a4a3a",
    soil: "#a08a62",
    soilDark: "#7e6a48",
    crop: "#a8c46a",
    cropDark: "#7aa04c",
    sand: "#d8c89a",
    sandDark: "#bca878",
    snow: "#eef2f0",
    snowShade: "#c4d0cc",
    rock: "#7c8488",
    rockLight: "#a4acae",
    rockDark: "#565e64",
    water: "#4a8a9c",
    waterLight: "#78b0bc",
    waterDeep: "#336a7c",
    wall: "#efe6d2",
    wallShade: "#cfc2a6",
    roof: "#3a5a5a",
    roofShade: "#24403e",
    door: "#a8322a",
    stone: "#b0aa9c",
    stoneDark: "#86806f",
    accent: "#c8402e",
    skin: "#f0caa4",
    hair: "#1e1a18",
    cloak: "#e9e4d6",
    cloakShade: "#bdb6a2",
  },
  modern: {
    grass: "#78ac58",
    grassLight: "#98c476",
    grassDark: "#5a8c42",
    leaf: "#4a8c48",
    leafLight: "#6aac5c",
    leafDark: "#336a34",
    trunk: "#6a5038",
    soil: "#a48a5c",
    soilDark: "#826a42",
    crop: "#c4b85a",
    cropDark: "#8eac48",
    sand: "#e2d0a0",
    sandDark: "#c8b47e",
    snow: "#f0f4f8",
    snowShade: "#cad6e2",
    rock: "#8e8c88",
    rockLight: "#b2b0aa",
    rockDark: "#686660",
    water: "#3c7ec4",
    waterLight: "#6aa6e0",
    waterDeep: "#2a5e9c",
    wall: "#dfe3e8",
    wallShade: "#b4bac4",
    roof: "#5a6470",
    roofShade: "#3e4650",
    door: "#3e4a5a",
    stone: "#9a9ca0",
    stoneDark: "#707276",
    accent: "#e0a83a",
    skin: "#e8bd98",
    hair: "#3a2a1e",
    cloak: "#e0a83a",
    cloakShade: "#b07e24",
  },
  jazz_age: {
    grass: "#8a9a5c",
    grassLight: "#a8b47a",
    grassDark: "#6c7c46",
    leaf: "#5a7444",
    leafLight: "#768e5a",
    leafDark: "#425632",
    trunk: "#5e4632",
    soil: "#a08660",
    soilDark: "#7c6644",
    crop: "#c4ac68",
    cropDark: "#96904e",
    sand: "#d8c49a",
    sandDark: "#baa478",
    snow: "#ece8e0",
    snowShade: "#c8c2b6",
    rock: "#8a8274",
    rockLight: "#aca492",
    rockDark: "#665e52",
    water: "#4a7088",
    waterLight: "#7096aa",
    waterDeep: "#36546a",
    wall: "#b8664a",
    wallShade: "#8e4a34",
    roof: "#4a3e36",
    roofShade: "#302822",
    door: "#2e2620",
    stone: "#a49a88",
    stoneDark: "#7a7062",
    accent: "#d8b45a",
    skin: "#ecc8a2",
    hair: "#2a2018",
    cloak: "#4a4a52",
    cloakShade: "#32323a",
  },
  scifi: {
    grass: "#3e6a6a",
    grassLight: "#548888",
    grassDark: "#2c5050",
    leaf: "#2a7a6a",
    leafLight: "#3aa08a",
    leafDark: "#1c5448",
    trunk: "#3a4a52",
    soil: "#5a5662",
    soilDark: "#42404a",
    crop: "#4ac0a8",
    cropDark: "#2e8a7a",
    sand: "#a89a86",
    sandDark: "#8a7c6a",
    snow: "#dfeaf2",
    snowShade: "#b4c4d2",
    rock: "#6a6e7a",
    rockLight: "#8e94a2",
    rockDark: "#4a4e58",
    water: "#24546e",
    waterLight: "#3a86a4",
    waterDeep: "#173c52",
    wall: "#cfe4ee",
    wallShade: "#94b0c0",
    roof: "#7ae0f0",
    roofShade: "#3aa8c0",
    door: "#1e2a36",
    stone: "#7a808c",
    stoneDark: "#545a66",
    accent: "#f06ad8",
    skin: "#e8c8b0",
    hair: "#d8e8f0",
    cloak: "#f06ad8",
    cloakShade: "#b040a0",
  },
  wasteland: {
    grass: "#9c8c5e",
    grassLight: "#b4a676",
    grassDark: "#7c6e46",
    leaf: "#6c6a3e",
    leafLight: "#8a8650",
    leafDark: "#4e4c2c",
    trunk: "#4e3e2e",
    soil: "#a07e58",
    soilDark: "#7a5e40",
    crop: "#a89a5a",
    cropDark: "#80784a",
    sand: "#d0b484",
    sandDark: "#b09466",
    snow: "#e2ddd2",
    snowShade: "#bdb5a6",
    rock: "#857a6c",
    rockLight: "#a69a88",
    rockDark: "#5e554a",
    water: "#4e6a66",
    waterLight: "#6e8a84",
    waterDeep: "#3a504c",
    wall: "#a88a66",
    wallShade: "#806648",
    roof: "#8a5a3a",
    roofShade: "#643e28",
    door: "#3a2c20",
    stone: "#8e8676",
    stoneDark: "#665e52",
    accent: "#d86a2e",
    skin: "#dcb08c",
    hair: "#4a3424",
    cloak: "#c8743a",
    cloakShade: "#92502a",
  },
};
const SPACE = {
  space: "#0b0d1a",
  star: "#e8ecff",
  starDim: "#8a90b8",
  nebula: "#2a1c48",
  nebulaLight: "#6a4aa8",
  rock: "#7a7670",
  rockLight: "#a29e96",
  rockDark: "#4e4b47",
  well: "#06060c",
  ring: "#7a62e0",
};

// ── Ground ──

function ground(p, base, light, dark, seed, density = 1) {
  const t = tile();
  fill(t, p[base]);
  speckle(t, p[light], Math.round(7 * density), seed);
  speckle(t, p[dark], Math.round(5 * density), seed + 50);
  return t;
}
function tuft(t, x, y, p) {
  px(t, x, y + 1, p.grassDark);
  px(t, x + 1, y, p.grassLight);
  px(t, x + 2, y + 1, p.grassDark);
}
function roundTree(t, x, y, p) {
  sprite(t, x, y, [".llL.", "lLLLd", "lLLLd", ".dLd.", "..t..", "..t.."], {
    l: p.leafLight,
    L: p.leaf,
    d: p.leafDark,
    t: p.trunk,
  });
  px(t, x + 1, y + 6, p.grassDark);
  px(t, x + 3, y + 6, p.grassDark);
}
function pine(t, x, y, p) {
  sprite(t, x, y, ["..l..", ".lLd.", "..L..", ".lLd.", "lLLLd", "..t.."], {
    l: p.leafLight,
    L: p.leaf,
    d: p.leafDark,
    t: p.trunk,
  });
}
function bareTree(t, x, y, p) {
  sprite(t, x, y, ["t...t", ".t.t.", "..t..", "..t..", "..t.."], { t: p.trunk });
}
function mound(t, x, y, p, w = 9) {
  for (let row = 0; row < 4; row++) {
    const half = Math.round((w / 2) * Math.sqrt(1 - ((3 - row) / 4) ** 2));
    for (let dx = -half; dx <= half; dx++)
      px(t, x + dx, y + row, row === 3 ? p.leafDark : dx < 0 ? p.grassLight : p.grassDark);
  }
  px(t, x - 1, y, p.grassLight);
}
function peak(t, x, y, p, h = 10) {
  for (let row = 0; row < h; row++) {
    const half = Math.floor(row * 0.6);
    for (let dx = -half; dx <= half; dx++) px(t, x + dx, y + row, dx <= 0 ? p.rockLight : p.rockDark);
    if (row < 3) for (let dx = -half; dx <= half; dx++) px(t, x + dx, y + row, dx <= 0 ? p.snow : p.snowShade);
  }
}
function waves(t, crest, seed, count = 2) {
  for (let i = 0; i < count; i++) {
    const x = 1 + Math.floor(noise(seed, i, 3) * 10);
    const y = 2 + Math.floor(noise(seed, i, 4) * 11);
    rect(t, x, y, 3, 1, crest);
    rect(t, x + 3, y - 1, 2, 1, crest);
  }
}
function house(t, x, y, p, style, w = 6, h = 4) {
  // A shadow on the ground, the wall with a shaded side, the roof in the family's style, a door.
  rect(t, x + 1, y + h + 2, w, 1, "#000000", 70);
  rect(t, x, y + 2, w, h, p.wall);
  rect(t, x + w - 1, y + 2, 1, h, p.wallShade);
  px(t, x + Math.floor(w / 2), y + h + 1, p.door);
  px(t, x + Math.floor(w / 2), y + h, p.door);
  if (style === "gable") {
    rect(t, x - 1, y + 1, w + 2, 1, p.roofShade);
    rect(t, x, y, w, 1, p.roof);
    rect(t, x + 1, y - 1, w - 2, 1, p.roof);
  } else if (style === "pagoda") {
    rect(t, x - 1, y + 1, w + 2, 1, p.roof);
    px(t, x - 2, y, p.roof);
    px(t, x + w + 1, y, p.roof);
    rect(t, x, y, w, 1, p.roofShade);
    rect(t, x + 1, y - 1, w - 2, 1, p.roof);
  } else if (style === "flat") {
    rect(t, x, y + 1, w, 1, p.roof);
    rect(t, x, y + 2, w, 1, p.roofShade);
  } else if (style === "dome") {
    rect(t, x + 1, y, w - 2, 1, p.roof);
    rect(t, x, y + 1, w, 1, p.roof);
    rect(t, x + w - 2, y, 1, 2, p.roofShade);
  } else if (style === "tent") {
    for (let row = 0; row < h + 2; row++) {
      const half = Math.floor(row / 2);
      rect(t, x + Math.floor(w / 2) - half, y + row, half * 2 + 1, 1, row % 2 ? p.roof : p.roofShade);
    }
  }
}
function tower(t, x, y, p, style) {
  // The landmark of a big place: a keep, a pagoda, a tower block, a spire, a fort.
  rect(t, x + 1, y + 12, 6, 1, "#000000", 70);
  if (style === "pagoda") {
    for (const [dy, w] of [
      [0, 4],
      [3, 6],
      [6, 8],
    ]) {
      rect(t, x + (8 - w) / 2, y + dy + 1, w, 2, p.wall);
      rect(t, x + (8 - w) / 2 - 1, y + dy, w + 2, 1, p.roof);
    }
    rect(t, x + 3, y + 9, 2, 3, p.door);
    rect(t, x + 1, y + 9, 6, 3, p.wall);
    rect(t, x + 3, y + 10, 2, 2, p.door);
    return;
  }
  if (style === "flat") {
    rect(t, x + 1, y, 6, 12, p.wall);
    rect(t, x + 5, y, 2, 12, p.wallShade);
    for (let wy = 1; wy < 11; wy += 2) for (let wx = 2; wx < 6; wx += 2) px(t, x + wx, y + wy, p.roofShade);
    rect(t, x + 1, y, 6, 1, p.roof);
    return;
  }
  if (style === "dome") {
    rect(t, x + 3, y, 2, 4, p.wallShade);
    px(t, x + 3, y, p.accent);
    rect(t, x + 1, y + 4, 6, 2, p.roof);
    rect(t, x, y + 6, 8, 6, p.wall);
    rect(t, x + 6, y + 6, 2, 6, p.wallShade);
    rect(t, x + 3, y + 9, 2, 3, p.door);
    return;
  }
  // A keep (fantasy, the 1920s' town hall, the wasteland's fort), crenellated.
  rect(t, x + 1, y + 2, 6, 10, p.stone);
  rect(t, x + 5, y + 2, 2, 10, p.stoneDark);
  for (let cx = x + 1; cx < x + 7; cx += 2) px(t, cx, y + 1, p.stone);
  rect(t, x + 3, y + 9, 2, 3, p.door);
  px(t, x + 3, y + 5, p.door);
  if (style === "gable") (rect(t, x + 3, y - 2, 1, 3, p.trunk), rect(t, x + 4, y - 2, 2, 1, p.accent));
}

function grounds(p) {
  const g = (seed, density) => ground(p, "grass", "grassLight", "grassDark", seed, density);
  const water = (base, light, seed) => {
    const t = tile();
    fill(t, p[base]);
    waves(t, p[light], seed);
    return t;
  };
  return {
    grass: [1, 2, 3, 4].map((s) => {
      const t = g(s);
      if (s % 2) tuft(t, 3 + s, 6 + s, p);
      return t;
    }),
    plains: [5, 6].map((s) => {
      const t = ground(p, "grassLight", "sandDark", "grass", s, 0.8);
      tuft(t, 4 + s, 9, p);
      return t;
    }),
    farmland: [7, 8].map((s) => {
      const t = tile();
      fill(t, p.soil);
      for (let y = 1; y < T; y += 3) rect(t, 0, y, T, 1, s === 7 ? p.crop : p.cropDark);
      for (let y = 2; y < T; y += 3) rect(t, 0, y, T, 1, p.soilDark);
      return t;
    }),
    forest: [9, 10, 11, 12].map((s) => {
      const t = ground(p, "grassDark", "leafDark", "leaf", s, 0.6);
      const kinds = s % 2 ? [roundTree, pine, roundTree] : [pine, roundTree, pine];
      kinds[0](t, Math.floor(noise(s, 0, 5) * 3), 0, p);
      kinds[1](t, 9 + Math.floor(noise(s, 1, 5) * 2), 2 + Math.floor(noise(s, 2, 5) * 2), p);
      kinds[2](t, 4 + Math.floor(noise(s, 3, 5) * 3), 9, p);
      return t;
    }),
    hills: [13, 14, 15, 16].map((s) => {
      const t = g(s, 0.7);
      // Half the hill cells are open slope between the mounds, so a range of hills does not repeat.
      if (s === 13) mound(t, 7, 7, p, 11);
      else if (s === 14) mound(t, 4, 10, p, 7);
      else tuft(t, 3 + (s % 3) * 3, 6 + (s % 2) * 4, p);
      return t;
    }),
    marsh: [17, 18].map((s) => {
      const t = ground(p, "grassDark", "grass", "leafDark", s, 0.8);
      rect(t, 2 + (s % 3), 4, 5, 2, p.water);
      rect(t, 8, 10 - (s % 2), 6, 2, p.water);
      for (const x of [3, 9, 13]) rect(t, x, 8 + (s % 2), 1, 3, p.leafDark);
      return t;
    }),
    paddies: [19, 20].map((s) => {
      const t = tile();
      fill(t, p.soil);
      rect(t, 1, 1, 14, 14, p.water);
      for (let y = 3; y < 14; y += 3)
        for (let x = 2 + (y % 2); x < 14; x += 2) px(t, x, y, s === 19 ? p.cropDark : p.crop);
      rect(t, 1, 1, 14, 1, p.waterLight);
      return t;
    }),
    bamboo: [21, 22].map((s) => {
      const t = g(s, 0.5);
      for (let i = 0; i < 4; i++) {
        const x = 2 + i * 4 + Math.floor(noise(s, i, 6) * 2);
        const top = Math.floor(noise(s, i, 7) * 4);
        rect(t, x, top, 1, T - top, p.leaf);
        for (let y = top + 3; y < T; y += 4) px(t, x, y, p.leafDark);
        px(t, x + 1, top + 2, p.leafLight);
        px(t, x - 1, top + 5, p.leafLight);
      }
      return t;
    }),
    scrub: [23, 24].map((s) => {
      const t = ground(p, "sand", "sandDark", "soil", s, 0.7);
      sprite(t, 3 + (s % 4), 5, [".lL.", "lLLd", ".dd."], { l: p.leafLight, L: p.leaf, d: p.leafDark });
      sprite(t, 10, 10 - (s % 3), [".L.", "LLd"], { L: p.leaf, d: p.leafDark });
      return t;
    }),
    desert: [25, 26, 27].map((s) => {
      const t = ground(p, "sand", "sandDark", "sandDark", s, 0.4);
      for (let x = 2; x < 13; x++) px(t, x, 5 + Math.round(Math.sin((x + s) / 2)), p.sandDark);
      if (s === 26) sprite(t, 9, 7, [".L.", "LLL", ".L.", ".L."], { L: p.cropDark });
      return t;
    }),
    snow: [28, 29].map((s) => {
      const t = ground(p, "snow", "snowShade", "snowShade", s, 0.6);
      if (s === 29) pine(t, 6, 5, p);
      return t;
    }),
    suburb: [30, 31, 32].map((s) => {
      const t = g(s, 0.5);
      rect(t, 0, 7, T, 2, p.stone);
      house(t, 1 + (s % 2), 1, p, "gable", 5, 3);
      house(t, 9, 10, p, s === 31 ? "flat" : "gable", 5, 3);
      return t;
    }),
    city: [33, 34, 35, 36].map((s) => {
      const t = tile();
      fill(t, p.stoneDark);
      for (const [x, y, w, h] of [
        [1, 1, 6, 6],
        [9, 1, 6, 6],
        [1, 9, 6, 6],
        [9, 9, 6, 6],
      ]) {
        const tall = noise(s, x, y) > 0.5;
        rect(t, x, y, w, h, tall ? p.roof : p.wall);
        rect(t, x + w - 1, y, 1, h, tall ? p.roofShade : p.wallShade);
        rect(t, x, y + h - 1, w, 1, tall ? p.roofShade : p.wallShade);
      }
      return t;
    }),
    industry: [37, 38].map((s) => {
      const t = tile();
      fill(t, p.soilDark);
      rect(t, 1, 5, 9, 8, p.stone);
      rect(t, 1, 5, 9, 1, p.stoneDark);
      for (let x = 1; x < 10; x += 3) rect(t, x, 4, 2, 1, p.stoneDark);
      rect(t, 11, 2 + (s % 2), 2, 11, p.rockDark);
      px(t, 12, 1 + (s % 2), p.rockLight);
      px(t, 13, 0 + (s % 2), p.rockLight);
      return t;
    }),
    slums: [39, 40].map((s) => {
      const t = ground(p, "soil", "soilDark", "soilDark", s, 0.5);
      for (let i = 0; i < 5; i++) {
        const x = Math.floor(noise(s, i, 8) * 12);
        const y = Math.floor(noise(s, i, 9) * 12);
        rect(t, x, y, 4, 3, [p.roof, p.stone, p.wallShade, p.rock][i % 4]);
        rect(t, x, y + 2, 4, 1, p.soilDark);
      }
      return t;
    }),
    wasteland: [41, 42].map((s) => {
      const t = ground(p, "soil", "sandDark", "soilDark", s, 0.6);
      let x = 2 + (s % 4);
      for (let y = 3; y < 13; y++) {
        px(t, x, y, p.soilDark);
        x += noise(s, y, 10) > 0.5 ? 1 : -1;
      }
      return t;
    }),
    ruins: [43, 44].map((s) => {
      const t = ground(p, "soil", "sandDark", "soilDark", s, 0.4);
      rect(t, 2, 4, 1, 8, p.stone);
      rect(t, 2, 11, 9, 1, p.stone);
      rect(t, 3, 4, 1, 3 + (s % 3), p.stoneDark);
      rect(t, 10, 8, 1, 4, p.stoneDark);
      speckle(t, p.stone, 4, s + 90);
      return t;
    }),
    dead_forest: [45, 46].map((s) => {
      const t = ground(p, "soil", "sandDark", "soilDark", s, 0.5);
      bareTree(t, 2 + (s % 3), 2, p);
      bareTree(t, 9, 8, p);
      return t;
    }),
    space: [47, 48, 49].map((s) => {
      const t = tile();
      fill(t, SPACE.space);
      speckle(t, SPACE.starDim, 3, s);
      speckle(t, SPACE.star, 1 + (s % 2), s + 30);
      return t;
    }),
    nebula: [50, 51].map((s) => {
      const t = tile();
      fill(t, SPACE.nebula);
      speckle(t, SPACE.nebulaLight, 6, s, 2);
      speckle(t, SPACE.star, 2, s + 30);
      return t;
    }),
    asteroids: [52, 53, 54].map((s) => {
      const t = tile();
      fill(t, SPACE.space);
      speckle(t, SPACE.starDim, 2, s);
      sprite(t, 3 + (s % 5), 4 + (s % 4), [".lL.", "lLLd", "LLdd", ".dd."], {
        l: SPACE.rockLight,
        L: SPACE.rock,
        d: SPACE.rockDark,
      });
      return t;
    }),
    sea: [55, 56].map((s) => water("waterDeep", "water", s)),
    lake: [57, 58].map((s) => water("water", "waterLight", s)),
    toxic_water: [59].map((s) => {
      const t = tile();
      fill(t, "#5a7a2a");
      waves(t, "#9cc43a", s);
      speckle(t, "#c4e05a", 3, s + 9);
      return t;
    }),
    mountains: [60, 61].map((s) => {
      const t = g(s, 0.5);
      peak(t, 7 + (s % 2), 3, p, 11);
      if (s === 61) peak(t, 12, 8, p, 6);
      return t;
    }),
    craters: [62].map((s) => {
      const t = ground(p, "soil", "sandDark", "soilDark", s, 0.5);
      rect(t, 4, 5, 7, 5, p.soilDark);
      rect(t, 5, 4, 5, 1, p.sandDark);
      rect(t, 5, 6, 5, 3, p.rockDark);
      return t;
    }),
    gravity_well: [63].map(() => {
      const t = tile();
      fill(t, SPACE.well);
      for (let a = 0; a < 32; a++)
        px(t, 8 + Math.cos((a / 32) * Math.PI * 2) * 6, 8 + Math.sin((a / 32) * Math.PI * 2) * 6, SPACE.ring);
      px(t, 7, 7, SPACE.starDim);
      return t;
    }),
  };
}

// ── Settlements, ruins and the party ──

const STYLE = {
  fantasy: { house: "gable", landmark: "gable" },
  wuxia: { house: "pagoda", landmark: "pagoda" },
  modern: { house: "flat", landmark: "flat" },
  jazz_age: { house: "gable", landmark: "flat" },
  scifi: { house: "dome", landmark: "dome" },
  wasteland: { house: "tent", landmark: "keep" },
};

function markers(p, style) {
  const tiers = [tile(), tile(), tile(), tile()];
  house(tiers[0], 5, 6, p, style.house);
  house(tiers[1], 1, 8, p, style.house, 5, 3);
  house(tiers[1], 8, 4, p, style.house);
  house(tiers[2], 1, 9, p, style.house, 5, 3);
  house(tiers[2], 9, 9, p, style.house, 5, 3);
  house(tiers[2], 5, 2, p, style.house);
  tower(tiers[3], 4, 2, p, style.landmark);
  house(tiers[3], 0, 10, p, style.house, 4, 3);
  house(tiers[3], 12, 10, p, style.house, 4, 3);
  const ruin = tile();
  rect(ruin, 3, 6, 1, 7, p.stone);
  rect(ruin, 3, 12, 9, 1, p.stone);
  rect(ruin, 11, 9, 1, 3, p.stoneDark);
  rect(ruin, 4, 6, 2, 1, p.stoneDark);
  speckle(ruin, p.stoneDark, 5, 77);
  rect(ruin, 2, 13, 11, 1, "#000000", 60);
  return { tiers, ruin };
}

function party(p) {
  const t = tile();
  rect(t, 5, 14, 6, 1, "#000000", 90);
  sprite(t, 5, 1, ["..hh..", ".hssh.", "..ss..", ".cCCc.", "cCCCCc", "cCCCCc", ".cCCc.", ".l..l.", ".l..l."], {
    h: p.hair,
    s: p.skin,
    c: p.cloakShade,
    C: p.cloak,
    l: p.trunk,
  });
  // A light rim on the cloak's lit side, so the party reads on any ground.
  for (let y = 5; y < 9; y++) px(t, 5, y, "#ffffff", 90);
  return t;
}

// ── PNG ──

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── Atlases ──

const maps = {};
const outDir = join(ROOT, "packages/client/public/overworld");
mkdirSync(outDir, { recursive: true });
for (const [family, p] of Object.entries(PALETTES)) {
  const tiles = [];
  const ids = {};
  const add = (id, images) => {
    ids[id] = images.map((image) => tiles.push(image) - 1);
  };
  for (const [look, images] of Object.entries(grounds(p))) add(look, images);
  const { tiers, ruin } = markers(p, STYLE[family]);
  tiers.forEach((image, tier) => add(`marker${tier}`, [image]));
  add("ruin", [ruin]);
  add("party", [party(p)]);
  const rows = Math.ceil(tiles.length / COLUMNS);
  const width = COLUMNS * T;
  const atlas = new Uint8ClampedArray(width * rows * T * 4);
  tiles.forEach((image, index) => {
    const ox = (index % COLUMNS) * T;
    const oy = Math.floor(index / COLUMNS) * T;
    for (let y = 0; y < T; y++) atlas.set(image.subarray(y * T * 4, (y + 1) * T * 4), ((oy + y) * width + ox) * 4);
  });
  writeFileSync(join(outDir, `${family}.png`), png(width, rows * T, atlas));
  maps[family] = { columns: COLUMNS, tiles: ids };
}
mkdirSync(join(ROOT, "packages/client/src/lib"), { recursive: true });
writeFileSync(join(ROOT, "packages/client/src/lib/overworld-atlases.json"), `${JSON.stringify(maps, null, 2)}\n`);
console.log(`Overworld tiles: ${Object.keys(maps).length} families written.`);
