// New tracker stat bars get a random color inside a readable band.
//
// Every color must be `#rrggbb` (preset and learned-row schemas validate it, and
// `<input type="color">` accepts nothing else), and every roll must stay inside
// the saturation and lightness band so no bar comes out near-black or washed out.

import assert from "node:assert/strict";
import { hslToHex, randomStatColor } from "../../packages/client/src/lib/random-stat-color.js";

assert.equal(hslToHex(0, 100, 50), "#ff0000");
assert.equal(hslToHex(120, 100, 50), "#00ff00");
assert.equal(hslToHex(240, 100, 50), "#0000ff");
assert.equal(hslToHex(0, 0, 50), "#808080");
assert.equal(hslToHex(-120, 100, 50), "#0000ff", "negative hues wrap");
assert.equal(hslToHex(270, 50, 75), "#bf9fdf");

const realRandom = Math.random;
Math.random = () => 0;
try {
  assert.equal(randomStatColor(), "#d74242", "the band's lower bounds: hue 0, saturation 65, lightness 55");
} finally {
  Math.random = realRandom;
}

const seen = new Set<string>();
for (let roll = 0; roll < 500; roll++) {
  const color = randomStatColor();
  assert.match(color, /^#[0-9a-f]{6}$/u);
  seen.add(color);

  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r!, g!, b!);
  const min = Math.min(r!, g!, b!);
  const lightness = (max + min) / 2;
  const saturation = (max - min) / (1 - Math.abs(2 * lightness - 1));
  assert.ok(lightness >= 0.545 && lightness <= 0.655, `${color} lightness ${lightness} is outside 55-65`);
  assert.ok(saturation >= 0.64 && saturation <= 0.86, `${color} saturation ${saturation} is outside 65-85`);
}
assert.ok(seen.size > 400, "rolls vary rather than repeating a few colors");

console.log("random-stat-color regression passed.");
