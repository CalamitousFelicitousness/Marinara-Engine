import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isPatternSafe } from "../../packages/shared/src/utils/regex-safety.js";

const malformedSource = String.raw`[^]a)|(?:(?:a?|b?){30}|]*x`;
const mode = process.argv[2];

if (mode === "--no-compilation") {
  const NativeRegExp = globalThis.RegExp;
  let compilationAttempts = 0;
  const rejectCompilation = () => {
    compilationAttempts += 1;
    throw new Error("The safety checker must inspect regex source without compiling it");
  };
  globalThis.RegExp = new Proxy(NativeRegExp, {
    apply: rejectCompilation,
    construct: rejectCompilation,
  });
  try {
    for (const source of [String.raw`[^|]+\|[^|]+\|[^|]+`, malformedSource]) {
      isPatternSafe(source);
    }
  } finally {
    globalThis.RegExp = NativeRegExp;
  }
  assert.equal(compilationAttempts, 0, "safety analysis must never compile attacker-controlled substrings");
} else if (mode === "--semantics") {
  for (const source of [
    "(?:a|[ab])+$",
    "(?:[ab]|a)+$",
    "(?:a|[a-c])+$",
    "(?:A|[^a])+$",
    "(?:a|[^a&&b])+$",
    "(?:a|A)+$",
    "(?:[ab]|[bc])+$",
    String.raw`(?:a|\x61)+$`,
    String.raw`(?:\d|[0-9])+$`,
    String.raw`(?:\w|a)+$`,
    String.raw`(?:[\uD800\uDC00]|\uD800)+$`,
    String.raw`(?:[\uDBFF-\uDC00]|\uDBFF)+$`,
    "(?:a|.)+$",
    "(?:a|ab)*c",
    "[^|]+x[^|]+y[^|]+",
  ]) {
    assert.equal(isPatternSafe(source), false, `${source} must be rejected before execution`);
  }
  for (const source of [
    "(?:a|b)+$",
    "(?:[ab]|[cd])+$",
    "(?:ab|cd)+$",
    "(?:a|bc)+$",
    "(?:cat|dog)+$",
    String.raw`(?:\d|\s)+$`,
    "(?:a|[^a])+$",
    String.raw`(?:\d|\D)+$`,
    '(?:[^"]|"")*',
    "[]",
    "[]+",
    "[^]+",
    String.raw`([^|]+)\|([^|]+)\|([^|]+)`,
    String.raw`([^\\|]+)\|([^\\|]+)\|([^\\|]+)`,
    "[^,]+,[^,]+,[^,]+",
    String.raw`[^^]+\^[^^]+\^[^^]+`,
    String.raw`(?:\^|[^^])+$`,
  ]) {
    assert.equal(isPatternSafe(source), true, `${source} must remain usable`);
  }
} else if (mode === "--malformed") {
  assert.equal(isPatternSafe(malformedSource), false, "a leading ] closes the JavaScript character class");
} else {
  // Keep both malformed-source analysis and checker regressions bounded even if
  // an earlier implementation compiles and executes an attacker substring.
  const failures: string[] = [];
  for (const childMode of ["--no-compilation", "--semantics", "--malformed"]) {
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), childMode], {
      encoding: "utf8",
      timeout: 5_000,
    });
    if (child.status !== 0) {
      failures.push(
        `${childMode}: ${child.error?.message ?? child.signal ?? child.status}\n${child.stdout}${child.stderr}`,
      );
    }
  }
  assert.deepEqual(failures, [], "regex safety checks must finish without executing attacker patterns");
  console.info("Regex safety security regressions passed.");
}
