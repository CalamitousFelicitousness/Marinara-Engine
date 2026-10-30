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
  "Present Characters lock mode marks each field with a padlock",
  "the Trackers window and its button reach the bottom beside the message box, never over it",
];

// Upstream tests of designs this fork replaced, skipped on every project. The Text to Speech card picks
// no Audio connection as its Source: speech resolves its engine through the audio connection defaults.
const REPLACED_DESIGN_TESTS = ["An Audio connection chosen as the Source is saved by ID and reported when it is gone"];

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Playwright matches these against "<project> <file> <describe> <title>". */
export const forkExcludedTests = [
  ...TRACKERS_WINDOW_TESTS.map((title) => new RegExp(`^desktop-\\S* .*${escapeRegExp(title)}`, "u")),
  ...REPLACED_DESIGN_TESTS.map((title) => new RegExp(escapeRegExp(title), "u")),
];
