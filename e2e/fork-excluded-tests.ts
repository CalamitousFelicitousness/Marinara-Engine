// Upstream tests of the Trackers window, which this fork never mounts: on a computer, trackers show only in
// the Tracker Panel (RoleplayTrackerWindow.tsx). playwright.config.ts skips them on the desktop projects
// through grepInvert; phones never had the window, so their runs stay. A renamed test runs again and fails.
const TRACKERS_WINDOW_TESTS = [
  "the default Trackers window uses a free gutter and becomes a button when the chat is narrow",
  "with the Tracker Panel off, trackers show in a Tracker window with a drawer each",
  "detached tracker lists retain their final border in every widget preset and custom gradients",
  "detached characters have one heading and readable cards that reflow",
  "Trackers reopens the selected panel and respects each chat's choice",
  "an unmoved Trackers window follows Chat position to a free gutter",
  "the Tracker Panel dice in the Chat Settings title bar turns the panel on and off",
  "a tracker pops out of the Trackers window and stays when that window closes",
  "a minimized World State window stays in view as a movable banner",
  "a dot on the Chat Settings button and the Trackers window shows while agents run",
  "Saved nameless custom tracker rows do not crash Roleplay on open or reload",
];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Playwright matches these against "<project> <file> <describe> <title>". */
export const forkExcludedTests = TRACKERS_WINDOW_TESTS.map(
  (title) => new RegExp(`^desktop-\\S* .*${escapeRegExp(title)}`, "u"),
);
