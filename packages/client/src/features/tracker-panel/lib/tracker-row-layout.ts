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
