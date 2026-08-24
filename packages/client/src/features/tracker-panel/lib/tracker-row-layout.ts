// ──────────────────────────────────────────────
// Tracker row reflow
// ──────────────────────────────────────────────
// One label/value grid, shared by the compact card, the featured card, and the
// nested extras tree, so all three reflow identically and a change lands once.
//
// Narrowing costs columns, not legibility. The panel used to shrink its type
// instead, which bottomed out at ~6px labels and made a resize handle
// pointless: more width bought bigger glyphs rather than more content.
//
// Three container widths, measured against the card's own `@container`:
//
//   < 176px   stacked, label over value. Below this a label and a value cannot
//             share a line at any readable size.
//   176-259   two columns, tight label gutter.
//   >= 260px  two columns, roomy label gutter.

/** Label/value row. Stacks, then splits, as the card gets wider. */
export const TRACKER_ROW_CLASS =
  "grid min-w-0 grid-cols-1 items-start gap-x-0.5 " +
  "@min-[176px]:grid-cols-[minmax(2.05rem,0.42fr)_minmax(0,1fr)] @min-[176px]:items-center @min-[176px]:gap-x-1 " +
  "@min-[260px]:grid-cols-[minmax(2.35rem,0.42fr)_minmax(0,1fr)]";

/** Same row with a trailing control column, used in delete mode. */
export const TRACKER_ROW_WITH_ACTION_CLASS =
  "grid-cols-[minmax(0,1fr)_1.25rem] " +
  "@min-[176px]:grid-cols-[minmax(2.05rem,0.38fr)_minmax(0,1fr)_1.25rem] " +
  "@min-[260px]:grid-cols-[minmax(2.35rem,0.38fr)_minmax(0,1fr)_1.25rem]";

/**
 * Values wrap to this many lines once the card is wide enough to justify it.
 * Below the two-column threshold a value already owns the full width, so a
 * single scrolling line reads better than a stack of fragments.
 */
export const TRACKER_VALUE_CLAMP_CLASS = "@min-[260px]:line-clamp-2 @min-[260px]:whitespace-normal";

/**
 * Line budget for the character detail fields (mood, appearance, outfit).
 *
 * They used to truncate to one line unless the card also carried stats or custom
 * fields, which is backwards: the sparse card is the one with room to spare. Any
 * value longer than a word or two was cut off with no way to read it in place.
 *
 * Bounded rather than unbounded so one verbose field cannot push the rest of the
 * card out of view -- compact cards share a grid row, so a tall card makes its
 * neighbour tall too.
 *
 * Breakpoints are the card's own width, not the panel's. Compact cards sit two
 * to a row, so a 420px panel gives each card roughly 200px and lands it on the
 * middle tier; the widest tier is for single-column and featured cards. Measured
 * at ~30 characters per line on the middle tier, so six lines covers about 180
 * characters of outfit or mood.
 */
export const TRACKER_DETAIL_VALUE_CLAMP_CLASS = "line-clamp-4 @min-[176px]:line-clamp-6 @min-[260px]:line-clamp-8";

/**
 * Type scale for the character detail values: mood, appearance, outfit, thoughts.
 *
 * One scale for all four so a thought reads at the same size as the row above it.
 * Thoughts used to size themselves fluidly against their own container, with the
 * step chosen by text length, so a short thought rendered larger than a long one
 * and neither matched the fields beside them.
 *
 * Keyed on the card's container, so the compact card (two to a grid row) lands a
 * step below the featured card, which spans the panel.
 */
export const TRACKER_DETAIL_TEXT_CLASS =
  "text-[length:var(--tracker-fs-0-5625)] leading-[1.15] " +
  "@min-[176px]:text-[length:var(--tracker-fs-0-625)] @min-[260px]:text-[length:var(--tracker-fs-0-6875)]";
