// ──────────────────────────────────────────────
// Avatar generation: the mesh-avatar layer builder in JavaScript
// ──────────────────────────────────────────────
// A port of mesh-avatar-studio's tools/build-layers.py and build-sprites.py (MIT, shinshin86) to plain
// typed-array pixel work, with sharp only decoding and encoding PNGs: no Python, OpenCV or GPU. It cuts
// each eye into its ball, lash, lower-lid and crease layers, fills the hole they leave in the base
// picture, and cuts drawn closed-eye and open-mouth pictures into sprites. Hands, hanging accessories,
// buns and hair strands are not built: the rig leaves those optional groups out, so the avatar's hair
// moves with its head.
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { getSharp } from "../../image/sharp-runtime.js";
import type { MeshRig } from "./mesh-rig-layout.js";

type Point = [number, number];
type Mask = Uint8Array;
type Rect = [number, number, number, number];

/** RGBA pixels of a whole picture or of a work area cut from one (origin `x`, `y` in the picture). */
interface Pixels {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8Array;
}

export interface MeshLayerSource {
  png: Buffer;
  width: number;
  height: number;
}

export type MeshAvatarFiles = Map<string, Buffer>;

const LUMA = [0.3, 0.59, 0.11] as const;
/** Room around an eye for the skin samples and the fill around the hole. */
const WORK_MARGIN = 40;
/** Relaxation steps of the skin fill; it starts from the skin colour, so it settles quickly. */
const MEMBRANE_ITERATIONS = 200;

// ── Pixel helpers ──

async function decodeRgba(png: Buffer): Promise<Pixels> {
  const sharp = await getSharp();
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { x: 0, y: 0, width: info.width, height: info.height, data: new Uint8Array(data) };
}

async function encodePng(pixels: Pixels, channels: 1 | 4 = 4): Promise<Buffer> {
  const sharp = await getSharp();
  return sharp(Buffer.from(pixels.data.buffer, pixels.data.byteOffset, pixels.data.length), {
    raw: { width: pixels.width, height: pixels.height, channels },
  })
    .png()
    .toBuffer();
}

function crop(image: Pixels, x: number, y: number, width: number, height: number): Pixels {
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const from = ((y - image.y + row) * image.width + (x - image.x)) * 4;
    data.set(image.data.subarray(from, from + width * 4), row * width * 4);
  }
  return { x, y, width, height, data };
}

function workArea(image: Pixels, points: readonly Point[], margin: number): Pixels {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)) - margin);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - margin);
  const x1 = Math.min(image.width, Math.ceil(Math.max(...xs)) + margin + 1);
  const y1 = Math.min(image.height, Math.ceil(Math.max(...ys)) + margin + 1);
  return crop(image, x0, y0, x1 - x0, y1 - y0);
}

/** Pixels whose centre lies inside the polygon (given in picture coordinates). */
function polygonMask(area: Pixels, polygon: readonly Point[]): Mask {
  const mask = new Uint8Array(area.width * area.height);
  for (let row = 0; row < area.height; row += 1) {
    const y = area.y + row + 0.5;
    const crossings: number[] = [];
    for (let i = 0; i < polygon.length; i += 1) {
      const [ax, ay] = polygon[i]!;
      const [bx, by] = polygon[(i + 1) % polygon.length]!;
      if ((ay <= y && y < by) || (by <= y && y < ay)) crossings.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.ceil(crossings[i]! - 0.5 - area.x));
      const to = Math.min(area.width - 1, Math.floor(crossings[i + 1]! - 0.5 - area.x));
      for (let col = from; col <= to; col += 1) mask[row * area.width + col] = 1;
    }
  }
  return mask;
}

/** Pixels inside a rotated ellipse (mesh-avatar's mouth area). */
function ellipseMask(area: Pixels, e: { cx: number; cy: number; rx: number; ry: number; angle: number }): Mask {
  const mask = new Uint8Array(area.width * area.height);
  const cos = Math.cos(e.angle);
  const sin = Math.sin(e.angle);
  for (let row = 0; row < area.height; row += 1) {
    for (let col = 0; col < area.width; col += 1) {
      const dx = area.x + col + 0.5 - e.cx;
      const dy = area.y + row + 0.5 - e.cy;
      const u = (dx * cos + dy * sin) / e.rx;
      const v = (-dx * sin + dy * cos) / e.ry;
      if (u * u + v * v <= 1) mask[row * area.width + col] = 1;
    }
  }
  return mask;
}

/** Square max filter of the given radius (OpenCV dilate with a (2r+1)² kernel). */
function dilate(mask: Mask, width: number, height: number, radius: number): Mask {
  if (radius <= 0) return mask.slice();
  const horizontal = new Uint8Array(mask.length);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      let on = 0;
      for (let k = Math.max(0, col - radius); k <= Math.min(width - 1, col + radius) && !on; k += 1) {
        on = mask[row * width + k]!;
      }
      horizontal[row * width + col] = on;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      let on = 0;
      for (let k = Math.max(0, row - radius); k <= Math.min(height - 1, row + radius) && !on; k += 1) {
        on = horizontal[k * width + col]!;
      }
      out[row * width + col] = on;
    }
  }
  return out;
}

function erode(mask: Mask, width: number, height: number, radius: number): Mask {
  return not(dilate(not(mask), width, height, radius));
}

function not(mask: Mask): Mask {
  return mask.map((value) => (value ? 0 : 1));
}

function and(...masks: Mask[]): Mask {
  return masks[0]!.map((value, i) => (value && masks.every((mask) => mask[i]) ? 1 : 0));
}

function or(...masks: Mask[]): Mask {
  return masks[0]!.map((_, i) => (masks.some((mask) => mask[i]) ? 1 : 0));
}

function luma(data: ArrayLike<number>, offset: number): number {
  return data[offset]! * LUMA[0] + data[offset + 1]! * LUMA[1] + data[offset + 2]! * LUMA[2];
}

function maxChannelDifference(data: ArrayLike<number>, offset: number, colour: ArrayLike<number>, colourOffset = 0) {
  return Math.max(
    Math.abs(data[offset]! - colour[colourOffset]!),
    Math.abs(data[offset + 1]! - colour[colourOffset + 1]!),
    Math.abs(data[offset + 2]! - colour[colourOffset + 2]!),
  );
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * (p / 100);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

/** Per-channel median colour of the selected pixels. */
function medianColour(image: Pixels, select: (index: number) => boolean): [number, number, number] | null {
  const channels: [number[], number[], number[]] = [[], [], []];
  for (let i = 0; i < image.width * image.height; i += 1) {
    if (!select(i)) continue;
    for (let c = 0; c < 3; c += 1) channels[c]!.push(image.data[i * 4 + c]!);
  }
  if (!channels[0].length) return null;
  return channels.map((values) => percentile(values, 50)) as [number, number, number];
}

/** Local skin colour from the brighter half of the opaque ring around a region, and how far a pixel
 *  may differ from it and still count as skin (build-layers.py skin_samples). */
function skinSamples(area: Pixels, region: Mask): { colour: [number, number, number]; tolerance: number } {
  const ring = and(dilate(region, area.width, area.height, 12), not(region));
  const lumas: number[] = [];
  for (let i = 0; i < ring.length; i += 1)
    if (ring[i] && area.data[i * 4 + 3]! > 200) lumas.push(luma(area.data, i * 4));
  if (!lumas.length) throw new MeshLayerError("There's no skin around an eye to fill the eye with.");
  const threshold = percentile(lumas, 55);
  const isLight = (i: number) => !!ring[i] && area.data[i * 4 + 3]! > 200 && luma(area.data, i * 4) >= threshold;
  const colour = medianColour(area, isLight)!;
  const spreads: number[] = [];
  for (let i = 0; i < ring.length; i += 1) if (isLight(i)) spreads.push(maxChannelDifference(area.data, i * 4, colour));
  return { colour, tolerance: Math.max(22, Math.min(60, percentile(spreads, 50) * 3)) };
}

/** Continues the surrounding skin shading into a hole by relaxing it towards the average of its
 *  neighbours (build-layers.py fill_skin's membrane solve). Returns RGB for the whole work area.
 *  ponytail: a smooth fill, so a lid painted over the filled hole shows flat shading with no texture;
 *  fine for anime-style skin. Upgrade: masked inpainting once the image path accepts an edit mask. */
function fillSkin(area: Pixels, hole: Mask): Float32Array {
  const { width, height, data } = area;
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) for (let c = 0; c < 3; c += 1) rgb[i * 3 + c] = data[i * 4 + c]!;
  if (!hole.some(Boolean)) return rgb;
  const { colour, tolerance } = skinSamples(area, hole);
  const skin = new Uint8Array(width * height);
  for (let i = 0; i < skin.length; i += 1) {
    skin[i] = !hole[i] && data[i * 4 + 3]! > 200 && maxChannelDifference(data, i * 4, colour) < tolerance ? 1 : 0;
  }
  const solve = or(hole, and(dilate(hole, width, height, 8), not(skin)));
  // Each solved pixel's neighbours (3x3, clipped at the edge), listed once so the loop below only adds.
  const pixels: number[] = [];
  const neighbours: number[] = [];
  const starts: number[] = [0];
  for (let i = 0; i < solve.length; i += 1) {
    if (!solve[i]) continue;
    for (let c = 0; c < 3; c += 1) rgb[i * 3 + c] = colour[c]!;
    const col = i % width;
    const row = (i - col) / width;
    for (let r = Math.max(0, row - 1); r <= Math.min(height - 1, row + 1); r += 1) {
      for (let k = Math.max(0, col - 1); k <= Math.min(width - 1, col + 1); k += 1) neighbours.push(r * width + k);
    }
    pixels.push(i);
    starts.push(neighbours.length);
  }
  let current = rgb;
  let next = rgb.slice();
  for (let iteration = 0; iteration < MEMBRANE_ITERATIONS; iteration += 1) {
    for (let p = 0; p < pixels.length; p += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      for (let n = starts[p]!; n < starts[p + 1]!; n += 1) {
        const at = neighbours[n]! * 3;
        red += current[at]!;
        green += current[at + 1]!;
        blue += current[at + 2]!;
      }
      const count = starts[p + 1]! - starts[p]!;
      const at = pixels[p]! * 3;
      next[at] = red / count;
      next[at + 1] = green / count;
      next[at + 2] = blue / count;
    }
    [current, next] = [next, current];
  }
  return current;
}

/** Fraction (0..1) of each pixel's 3x3 neighbourhood that is in the mask: a one-pixel soft edge. */
function softEdge(mask: Mask, width: number, height: number): Float32Array {
  const out = new Float32Array(mask.length);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const r = Math.min(height - 1, Math.max(0, row + dy));
          const k = Math.min(width - 1, Math.max(0, col + dx));
          sum += mask[r * width + k]!;
        }
      }
      out[row * width + col] = sum / 9;
    }
  }
  return out;
}

/** The pixels of `area` with alpha scaled by `alpha` (0..1), cut to what is visible plus `pad`. An empty
 *  result is one transparent pixel at the picture's corner, like build-layers.py crop_layer. */
function cropLayer(area: Pixels, alpha: (index: number) => number, pad: number): { pixels: Pixels; rect: Rect } {
  const layer: Pixels = { ...area, data: area.data.slice() };
  let x0 = area.width;
  let y0 = area.height;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < area.width * area.height; i += 1) {
    const value = Math.round(layer.data[i * 4 + 3]! * Math.max(0, Math.min(1, alpha(i))));
    layer.data[i * 4 + 3] = value;
    if (!value) continue;
    const col = i % area.width;
    const row = (i - col) / area.width;
    x0 = Math.min(x0, col);
    x1 = Math.max(x1, col);
    y0 = Math.min(y0, row);
    y1 = Math.max(y1, row);
  }
  if (x1 < 0) return { pixels: { x: 0, y: 0, width: 1, height: 1, data: new Uint8Array(4) }, rect: [0, 0, 1, 1] };
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(area.width - 1, x1 + pad);
  y1 = Math.min(area.height - 1, y1 + pad);
  const pixels = crop(layer, area.x + x0, area.y + y0, x1 - x0 + 1, y1 - y0 + 1);
  return { pixels, rect: [pixels.x, pixels.y, pixels.width, pixels.height] };
}

export class MeshLayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshLayerError";
  }
}

// ── Eyes ──

function interpolate(x: number, xs: readonly number[], ys: readonly number[]): number {
  if (x <= xs[0]!) return ys[0]!;
  for (let i = 1; i < xs.length; i += 1) {
    if (x <= xs[i]!) return ys[i - 1]! + ((ys[i]! - ys[i - 1]!) * (x - xs[i - 1]!)) / (xs[i]! - xs[i - 1]!);
  }
  return ys[ys.length - 1]!;
}

interface EyeLayers {
  hole: Mask;
  area: Pixels;
  ball: Mask;
  lines: Record<"lash" | "low" | "crease", { mask: Mask; ink: [number, number, number] }>;
}

/** Sorts an eye's pixels into eye ball, lash, lower lid and crease (build-layers.py eye_classes). */
function classifyEye(image: Pixels, eye: MeshRig["eyes"][number], index: number): EyeLayers {
  const area = workArea(image, eye.roi, WORK_MARGIN);
  const { width, height, data } = area;
  const core = polygonMask(area, eye.opening);
  const region = polygonMask(area, eye.roi);
  const opaque = data.filter((_, i) => i % 4 === 3).map((value) => (value > 0 ? 1 : 0));
  if (!and(core, opaque).some(Boolean))
    throw new MeshLayerError(`Eye ${index + 1} is on an empty part of the picture.`);
  const estimate = fillSkin(area, region);
  const skin = new Uint8Array(width * height);
  for (let i = 0; i < skin.length; i += 1) skin[i] = maxChannelDifference(data, i * 4, estimate, i * 3) < 22 ? 1 : 0;
  const ink = and(region, not(skin), not(core), opaque);

  const samples = Array.from(
    { length: eye.top.length },
    (_, i) => eye.x0 + ((eye.x1 - eye.x0) * i) / (eye.top.length - 1),
  );
  const corePixels: number[] = [];
  for (let i = 0; i < core.length; i += 1) if (core[i] && opaque[i]) corePixels.push(luma(data, i * 4));
  const whiteThreshold = percentile(corePixels, 85);
  const whiteColour = medianColour(area, (i) => !!core[i] && !!opaque[i] && luma(data, i * 4) >= whiteThreshold)!;
  const regionLumas: number[] = [];
  const estimateLumas: number[] = [];
  for (let i = 0; i < region.length; i += 1) {
    if (!region[i]) continue;
    estimateLumas.push(luma(estimate, i * 3));
    if (opaque[i]) regionLumas.push(luma(data, i * 4));
  }
  const dark = percentile(regionLumas, 10);
  const light = percentile(estimateLumas, 50);

  const white = new Uint8Array(width * height);
  const lash = new Uint8Array(width * height);
  const low = new Uint8Array(width * height);
  const crease = new Uint8Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const y = area.y + row;
    for (let col = 0; col < width; col += 1) {
      const i = row * width + col;
      const x = area.x + col;
      const pixelLuma = luma(data, i * 4);
      white[i] = maxChannelDifference(data, i * 4, whiteColour) < 20 && pixelLuma > luma(estimate, i * 3) ? 1 : 0;
      if (!ink[i] || white[i]) continue;
      const insideX = x >= eye.x0 && x <= eye.x1;
      const top = interpolate(x, samples, eye.top);
      const cornerLine = interpolate(x, [eye.x0, eye.x1], [eye.top[0]!, eye.top[eye.top.length - 1]!]);
      const upper = insideX ? y <= top + 3 : y <= cornerLine + 2;
      if (insideX && y < top - 9 && pixelLuma > (light + dark) / 2) crease[i] = 1;
      else if (upper) lash[i] = 1;
      else low[i] = 1;
    }
  }

  let taken = erode(core, width, height, 1);
  const grownRegion = dilate(region, width, height, 2);
  const skinColour = skinSamples(area, region).colour;
  const lines = {} as EyeLayers["lines"];
  for (const [part, mask] of [
    ["lash", lash],
    ["low", low],
    ["crease", crease],
  ] as const) {
    const darkest = percentile(
      Array.from(mask.keys()).flatMap((i) => (mask[i] && data[i * 4 + 3]! > 200 ? [luma(data, i * 4)] : [])),
      10,
    );
    const inkColour =
      medianColour(area, (i) => !!mask[i] && data[i * 4 + 3]! > 200 && luma(data, i * 4) <= darkest) ?? skinColour;
    const grown = and(dilate(mask, width, height, 2), not(taken), grownRegion);
    lines[part] = { mask: grown, ink: inkColour };
    taken = or(taken, grown);
  }
  const ball = dilate(core, width, height, 1);
  const stray = and(ink, white, not(ball));
  const near = and(dilate(core, width, height, 7), not(core));
  return { area, ball, lines, hole: or(taken, core, stray, and(white, near)) };
}

/** The lid layer that reproduces the picture where it lies over the filled skin, so soft line edges
 *  keep their anti-aliasing without a halo of the old eye (build-layers.py unblend). */
function unblendLine(area: Pixels, under: Float32Array, mask: Mask, ink: readonly number[]): Pixels {
  const out: Pixels = { ...area, data: new Uint8Array(area.data.length) };
  const edge = softEdge(mask, area.width, area.height);
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    let a = 0;
    for (let c = 0; c < 3; c += 1) {
      const skin = under[i * 3 + c]!;
      a = Math.max(a, (skin - area.data[i * 4 + c]!) / Math.max(skin - ink[c]!, 1));
    }
    a = Math.max(0, Math.min(1, a));
    for (let c = 0; c < 3; c += 1) {
      const skin = under[i * 3 + c]!;
      out.data[i * 4 + c] = Math.max(0, Math.min(255, (area.data[i * 4 + c]! - skin * (1 - a)) / Math.max(a, 1e-3)));
    }
    out.data[i * 4 + 3] = Math.round(a * 255 * Math.min(1, edge[i]! * 1.6));
  }
  return out;
}

export interface BuiltMeshLayers {
  files: MeshAvatarFiles;
  rects: Record<string, Rect>;
  build: string;
}

/** Builds `built/` for a rig whose eyes carry their sampled curves: base.png with the eyes taken out and
 *  the holes filled, an empty hairmask.png, the four layers of each eye and layers.json. */
export async function buildMeshAvatarLayers(source: MeshLayerSource, rig: MeshRig): Promise<BuiltMeshLayers> {
  const image = await decodeRgba(source.png);
  if (image.width !== rig.image.width || image.height !== rig.image.height) {
    throw new MeshLayerError("The rig and the picture are different sizes.");
  }
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i]! > 240) image.data[i] = 255;
  const base: Pixels = { ...image, data: image.data.slice() };
  const files: MeshAvatarFiles = new Map();
  const rects: Record<string, Rect> = {};

  for (const [index, eye] of rig.eyes.entries()) {
    const layers = classifyEye(image, eye, index);
    // The pixel work runs on the server's main thread; let other requests through between steps.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const area = layers.area;
    const under = fillSkin(area, layers.hole);
    const edge = softEdge(layers.hole, area.width, area.height);
    for (let i = 0; i < layers.hole.length; i += 1) {
      if (!edge[i]) continue;
      const col = i % area.width;
      const row = (i - col) / area.width;
      const at = ((area.y + row) * base.width + area.x + col) * 4;
      for (let c = 0; c < 3; c += 1) {
        base.data[at + c] = Math.round(area.data[i * 4 + c]! * (1 - edge[i]!) + under[i * 3 + c]! * edge[i]!);
      }
    }
    const ball = cropLayer(area, (i) => layers.ball[i]!, 3);
    files.set(`built/eye${index}_ball.png`, await encodePng(ball.pixels));
    rects[`eye${index}_ball`] = ball.rect;
    for (const part of ["lash", "low", "crease"] as const) {
      const line = unblendLine(area, under, layers.lines[part].mask, layers.lines[part].ink);
      const cut = cropLayer(line, () => 1, 2);
      files.set(`built/eye${index}_${part}.png`, await encodePng(cut.pixels));
      rects[`eye${index}_${part}`] = cut.rect;
    }
  }

  files.set("built/base.png", await encodePng(base));
  files.set(
    "built/hairmask.png",
    await encodePng(
      { x: 0, y: 0, width: image.width, height: image.height, data: new Uint8Array(image.width * image.height) },
      1,
    ),
  );
  const build = createHash("sha256").update(source.png).update(JSON.stringify(rig)).digest("hex").slice(0, 12);
  const layersJson = {
    version: 1,
    size: [image.width, image.height],
    build,
    layers: rects,
    eyes: rig.eyes.map(({ x0, x1, top, bot }) => ({ x0, x1, top, bot })),
  };
  files.set("built/layers.json", Buffer.from(`${JSON.stringify(layersJson, null, 2)}\n`));
  return { files, rects, build };
}

// ── Drawn variants ──

export type MeshSpriteVariant = "eyes_closed" | "mouth_a";

/** Mean premultiplied colour difference (0..255) between the drawing moved by (dx, dy) and the sprite,
 *  over the masked pixels of a work area. */
function meanDifference(drawn: Pixels, original: Pixels, mask: Mask, area: Pixels, dx = 0, dy = 0): number {
  let total = 0;
  let count = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    const col = i % area.width;
    const row = (i - col) / area.width;
    const x = area.x + col;
    const y = area.y + row;
    if (x + dx < 0 || y + dy < 0 || x + dx >= drawn.width || y + dy >= drawn.height) continue;
    const at = (y * original.width + x) * 4;
    const moved = ((y + dy) * drawn.width + x + dx) * 4;
    let worst = 0;
    for (let c = 0; c < 3; c += 1) {
      worst = Math.max(
        worst,
        Math.abs(
          (drawn.data[moved + c]! * drawn.data[moved + 3]!) / 255 -
            (original.data[at + c]! * original.data[at + 3]!) / 255,
        ),
      );
    }
    total += worst;
    count += 1;
  }
  return count ? total / count : 0;
}

/** Whether a drawing still lines up with the sprite around a region. Image models re-render the whole
 *  picture, so colours never match exactly; what matters is that no small shift matches better than
 *  none, and that the surroundings were not redrawn outright. */
function linesUp(drawn: Pixels, original: Pixels, ring: Mask, area: Pixels): boolean {
  const inPlace = meanDifference(drawn, original, ring, area);
  if (inPlace > 48) return false;
  for (let dy = -12; dy <= 12; dy += 2) {
    for (let dx = -12; dx <= 12; dx += 2) {
      if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2) continue;
      if (meanDifference(drawn, original, ring, area, dx, dy) < inPlace - 2) return false;
    }
  }
  return true;
}

/** Cuts the eye or mouth regions out of a drawn full-size variant into feathered sprites (build-sprites.py).
 *  A region whose surroundings don't match the sprite is skipped: the drawing moved or redrew the picture,
 *  and a sprite from it would jump on every blink. Returns the sprites it kept. */
export async function cutDrawnSprites(
  source: MeshLayerSource,
  drawn: Buffer,
  rig: MeshRig,
  variant: MeshSpriteVariant,
): Promise<{ sprites: MeshAvatarFiles; rects: Record<string, Rect>; rejected: number }> {
  const original = await decodeRgba(source.png);
  const picture = await decodeRgba(drawn);
  if (picture.width !== original.width || picture.height !== original.height) {
    throw new MeshLayerError("A drawn variant must be the sprite's size.");
  }
  const regions =
    variant === "eyes_closed"
      ? rig.eyes.map((eye, index) => {
          const area = workArea(original, eye.roi, 24);
          return {
            name: `eyes_closed_${index}`,
            area,
            mask: dilate(polygonMask(area, eye.roi), area.width, area.height, 4),
          };
        })
      : [
          (() => {
            const e = rig.mouth.area;
            const area = workArea(
              original,
              [
                [e.cx - e.rx - e.ry, e.cy - e.rx - e.ry],
                [e.cx + e.rx + e.ry, e.cy + e.rx + e.ry],
              ],
              24,
            );
            return { name: "mouth_a", area, mask: dilate(ellipseMask(area, e), area.width, area.height, 4) };
          })(),
        ];
  const sprites: MeshAvatarFiles = new Map();
  const rects: Record<string, Rect> = {};
  let rejected = 0;
  for (const { name, area, mask } of regions) {
    const ring = and(dilate(mask, area.width, area.height, 10), not(mask));
    if (!linesUp(picture, original, ring, area)) {
      rejected += 1;
      continue;
    }
    // Feather 4 px inward: each erosion step a pixel survives adds a quarter of its opacity.
    const weight = new Float32Array(mask.length);
    let layer = mask;
    for (let step = 0; step < 4; step += 1) {
      for (let i = 0; i < layer.length; i += 1) weight[i] = weight[i]! + layer[i]! / 4;
      layer = erode(layer, area.width, area.height, 1);
    }
    const drawnArea = crop(picture, area.x, area.y, area.width, area.height);
    const cut = cropLayer(drawnArea, (i) => weight[i]!, 0);
    if (cut.rect[2] <= 1 && cut.rect[3] <= 1) continue;
    sprites.set(`built/sprites/${name}.png`, await encodePng(cut.pixels));
    rects[name] = cut.rect;
  }
  return { sprites, rects, rejected };
}

/** `built/sprites/sprites.json` for the kept sprites. */
export function spritesJson(sprites: MeshAvatarFiles, rects: Record<string, Rect>): Buffer {
  const hash = createHash("sha1");
  for (const name of Object.keys(rects).sort()) hash.update(sprites.get(`built/sprites/${name}.png`) ?? "");
  return Buffer.from(
    `${JSON.stringify({ build: hash.digest("hex").slice(0, 10), layers: rects, version: 1 }, null, 2)}\n`,
  );
}

// ── The archive ──

/** A `.mavatar`: a ZIP with stored (uncompressed) entries, the manifest first. */
export function packMeshAvatar(files: MeshAvatarFiles): Buffer {
  const zip = new AdmZip();
  const names = [...files.keys()].sort((a, b) =>
    a === "avatar.json" ? -1 : b === "avatar.json" ? 1 : a.localeCompare(b),
  );
  for (const name of names) zip.addFile(name, files.get(name)!);
  for (const entry of zip.getEntries()) entry.header.method = 0;
  return zip.toBuffer();
}
