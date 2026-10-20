import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(
  process.argv[2] ?? new URL("../../packages/client/src/features/multiplayer/MultiplayerChat.tsx", import.meta.url),
  "utf8",
);
const file = ts.createSourceFile("MultiplayerChat.tsx", source, ts.ScriptTarget.Latest, true);
const helper = file.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "getMultiplayerGuestAccent",
);
assert(helper, "the guest theme must resolve the selected accent instead of always using the default gradient");
let theme;
function visit(node) {
  if (ts.isJsxAttribute(node) && node.name.getText(file) === "theme" && ts.isJsxExpression(node.initializer))
    theme = node.initializer.expression;
  ts.forEachChild(node, visit);
}
visit(file);
assert(theme && ts.isObjectLiteralExpression(theme), "exercise the theme passed to the actual guest frame");

const compile = (text) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const colors = runInNewContext(
  `${compile(readFileSync(new URL("../../packages/client/src/lib/css-colors.ts", import.meta.url), "utf8"))}\nexports;`,
  { exports: {} },
);
const styles = new Map([
  ["--marinara-app-accent-static", "#19af66"],
  ["--marinara-app-accent-solid", "#e87232"],
]);
const reads = [];
const paints = [];
const nativeColors = new Map([
  [colors.getCssColorFallback(colors.MARINARA_GRADIENT_PRESET, ""), [236, 75, 151, 255]],
  ["rgb(23, 148, 191)", [23, 148, 191, 255]],
  ["oklch(0.7 0.15 150)", [52, 182, 107, 255]],
]);
let nativePixels = nativeColors.values().next().value;
let contextAvailable = true;
const context = {
  set fillStyle(value) {
    paints.push(value);
    // The browser owns CSS parsing. Supply its pixel result to exercise the service's RGB-to-wire conversion.
    if (nativeColors.has(value)) nativePixels = nativeColors.get(value);
  },
  fillRect() {},
  getImageData: () => ({ data: Uint8ClampedArray.from(nativePixels) }),
};
const environment = {
  getCssColorFallback: colors.getCssColorFallback,
  MARINARA_GRADIENT_PRESET: colors.MARINARA_GRADIENT_PRESET,
  document: { documentElement: {}, createElement: () => ({ getContext: () => (contextAvailable ? context : null) }) },
  getComputedStyle: () => ({
    getPropertyValue(name) {
      reads.push(name);
      return styles.get(name) ?? "";
    },
  }),
};
const resolveAccent = runInNewContext(`${compile(helper.getText(file))}\ngetMultiplayerGuestAccent;`, environment);
assert.equal(resolveAccent("#123456"), "#123456", "an explicit solid is kept");
assert.equal(resolveAccent("linear-gradient(90deg, #1a2b3c, #abcdef)"), "#1a2b3c", "use the selected first stop");
assert.equal(reads.length, 0, "explicit colors do not read an unrelated theme or Pulse frame");
styles.set("--marinara-app-accent-static", "rgb(23, 148, 191)");
assert.equal(resolveAccent(""), "#1794bf", "an empty picker follows the theme accent in six-digit wire format");
assert(paints.includes("rgb(23, 148, 191)"), "CSS colors go through the native canvas parser");
assert.equal(resolveAccent("linear-gradient(90deg, oklch(0.7 0.15 150), #abcdef)"), "#34b66b");

const presentation = runInNewContext(compile(`(${theme.getText(file)});`), {
  ...environment,
  mode: "dark",
  accent: "",
  getMultiplayerGuestAccent: resolveAccent,
});
styles.set("--marinara-app-accent-static", "#6789ab");
assert.equal(JSON.parse(JSON.stringify(presentation)).accent, "#6789ab", "read the theme when the channel sends it");
assert(
  reads.every((name) => name === "--marinara-app-accent-static"),
  "Pulse's live solid accent never enters the wire",
);

const shared = await import("../../packages/shared/dist/index.js");
const guestLabels = runInNewContext(
  `${compile(readFileSync(new URL("../../packages/client/src/features/multiplayer/multiplayer-guest-labels.ts", import.meta.url), "utf8"))}\nexports;`,
  { exports: {} },
);
const channel = runInNewContext(
  `${compile(readFileSync(new URL("../../packages/client/src/features/multiplayer/multiplayer-guest-channel.ts", import.meta.url), "utf8"))}\nexports;`,
  {
    exports: {},
    TextEncoder,
    require: (name) => {
      if (name === "@marinara-engine/shared") return shared;
      assert.equal(name, "./multiplayer-guest-labels");
      return guestLabels;
    },
  },
);
const wire = JSON.parse(
  JSON.stringify({
    state: { phase: "ended", snapshot: null, error: null },
    labels: {
      ...Object.fromEntries(guestLabels.MULTIPLAYER_GUEST_LABEL_KEYS.map((key) => [key, key])),
      errors: Object.fromEntries(shared.multiplayerErrorCodeSchema.options.map((key) => [key, key])),
      modes: { conversation: "Conversation", roleplay: "Roleplay", game: "Game" },
    },
    theme: presentation,
  }),
);
assert.equal(
  channel.validateGuestPresentation(wire).theme.accent,
  "#6789ab",
  "the actual channel accepts the delayed six-digit value",
);
assert.throws(
  () => channel.validateGuestPresentation({ ...wire, theme: { ...wire.theme, accent: "rgb(23, 148, 191)" } }),
  /Invalid guest theme/u,
  "the channel still rejects colors outside its six-digit protocol",
);
contextAvailable = false;
assert.equal(resolveAccent("oklch(0.7 0.15 150)"), "#6789ab", "a missing canvas keeps the safe held theme");
const withoutDom = runInNewContext(`${compile(helper.getText(file))}\ngetMultiplayerGuestAccent;`, {
  getCssColorFallback: colors.getCssColorFallback,
  MARINARA_GRADIENT_PRESET: colors.MARINARA_GRADIENT_PRESET,
});
assert.match(withoutDom(""), /^#[\da-f]{6}$/iu, "a non-browser fallback remains protocol-valid");
console.log("Multiplayer guest accents follow selected solids, gradients, and held theme colors without Pulse.");
