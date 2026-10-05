// Starting colors for new tracker stat bars.
//
// Always `#rrggbb`: tracker presets and the learned auto-adopt list validate
// stat colors against that pattern, and `<input type="color">` accepts nothing else.

/** Convert HSL (hue 0-360, saturation and lightness 0-100) to lowercase `#rrggbb`. */
export function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = Math.min(100, Math.max(0, saturation)) / 100;
  const l = Math.min(100, Math.max(0, lightness)) / 100;
  const h = ((hue % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const value = l - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** Saturation and lightness bands that stay vivid and legible on light and dark tracker themes. */
const SATURATION_RANGE = [65, 85] as const;
const LIGHTNESS_RANGE = [55, 65] as const;

function randomInRange([min, max]: readonly [number, number]): number {
  return min + Math.random() * (max - min);
}

/** A random color for a new or re-rolled stat bar: any hue, inside the readable band. */
export function randomStatColor(): string {
  return hslToHex(Math.random() * 360, randomInRange(SATURATION_RANGE), randomInRange(LIGHTNESS_RANGE));
}
