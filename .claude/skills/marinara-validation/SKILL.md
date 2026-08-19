---
name: marinara-validation
description: How to validate a change in the Marinara-Engine repo — which lane to run (pnpm check, a regression lane, or the Playwright smoke suite), how to run the smoke suite so it actually completes, which e2e specs already fail on a clean tree, and the tooling traps that silently produce false passes. Use this skill whenever you are about to run pnpm check, pnpm regression, pnpm smoke:ui, or any test in this repo; whenever a validation run fails or times out and you are deciding whether your change caused it; and whenever you are scripting edits to tracked files, editing the localization catalog, or stashing work. Consult it before concluding that a run passed or that a failure is yours.
---

# Validating changes in Marinara-Engine

This repo's validation is cheap to run and easy to misread. Several failure
modes here produce a **green result that is wrong**, or a red result that has
nothing to do with your change. This skill exists so those are recognized on
sight instead of rediscovered.

Read `CLAUDE.md` for architecture and repo rules — this skill is only about
proving a change works.

## Pick the lane that matches the change

| Change touches | Run | Cost |
| --- | --- | --- |
| Anything at all (baseline) | `pnpm check` | ~2 min |
| Prompt assembly, lorebook, macros, author's notes | `pnpm regression:prompt` | ~1 min |
| Server behavior with a named lane | the lane (`regression:issues`, `regression:roleplay`, `regression:providers`, …) | seconds |
| A new module you wrote | a new `scripts/regressions/*.regression.ts` | seconds |
| Chat UI shell, panels, popovers | the two relevant e2e specs (see below) | ~1 min |
| Broad refactor across surfaces | full `pnpm smoke:ui` | **~1 hour** |

`pnpm check` runs stale-client cleanup, the Impeccable guard, both fork guards
(`agent-docs:check`, `dev-ports:check`), localization checks, lint, typecheck,
and the production build. It does **not** run regressions, and it does not
execute your code — it only proves it compiles and the guards hold.

That distinction matters. A green `pnpm check` says nothing about whether a
function you added actually returns the right thing, or whether a route is
mounted. Add a regression script for behavior, and lean on the e2e specs for
wiring.

### Regressions are the test suite

There is no Vitest or Jest. Tests are standalone `tsx` scripts under
`scripts/regressions/` that assert with `node:assert/strict` and print
`<name> regression passed.`

```bash
pnpm build:shared   # required when the script imports packages/shared/dist
pnpm --filter @marinara-engine/server exec tsx ../../scripts/regressions/<name>.regression.ts
```

Register a new script in the matching lane in `package.json` so it runs in CI,
and delete any `.test.ts` file you created for local proof — the repo does not
keep them.

## Running the Playwright smoke suite

### It takes about an hour, and usually you want two specs, not all of them

167 specs × 2 projects (desktop + mobile Chromium) = 334 tests, and
`fullyParallel: false` with a single spec file means they run essentially one
after another at ~10s each. Before committing an hour, ask which specs actually
cover the change and grep for those.

```bash
pnpm smoke:ui --grep "Author's Notes"        # correct
pnpm smoke:ui --project=desktop-chromium
```

**Never write `pnpm smoke:ui -- --grep "..."`.** pnpm 11 forwards the literal
`--` into the command, and Playwright reads everything after a bare `--` as
positional *file filters* rather than options. The filter is silently ignored
and the whole suite runs — which looks like you asked for a full run, so
nothing warns you. (Scripts that parse argv themselves, `version:sync` and
`release:notes`, tolerate the separator; only Playwright breaks.)

### Browsers go stale silently

If every test fails in ~3ms with
`browserType.launch: Executable doesn't exist at ...chromium_headless_shell-<N>`,
the browser cache is behind the pinned revision. Playwright pins an exact
Chromium build per release, and browsers live in a machine-global cache
(`%LOCALAPPDATA%\ms-playwright` on Windows) outside `node_modules`, so
`pnpm install` never refreshes them.

```bash
pnpm exec playwright install chromium
```

### Playwright's own webServer may never come up — start the servers yourself

On at least one Windows machine, `pnpm smoke:ui` dies with
`Error: Timed out waiting 180000ms from config.webServer` even though the
launcher is fast. Instrumenting it showed the mobile API server healthy at
t=14s while its Vite client never started, so `scripts/dev.mjs` never got past
its readiness gate. The same launcher spawned directly reaches both stacks in
17–37s. Ruled out: slowness, piped stdout, stale browsers, the fork `.env`
patch. Suspected: how Playwright spawns the webServer through a shell.

Do not re-diagnose this. Use the two-step procedure, which is reliable:

```bash
# 1. Start both stacks yourself. npm_execpath must be set, or start-servers.mjs
#    dies with `spawn pnpm ENOENT` (see Traps).
npm_execpath="C:/Program Files/nodejs/node_modules/pnpm/bin/pnpm.cjs" \
AUTO_CREATE_DEFAULT_CONNECTION=false AUTO_OPEN_BROWSER=false \
DEV_PRESERVE_SHARED_DIST=true DEV_SERVER_READY_TIMEOUT_MS=600000 \
LOG_DISABLE_REQUEST_LOGGING=true LOG_LEVEL=warn \
MARINARA_E2E_DISABLE_RATE_LIMIT=true \
PLAYWRIGHT_CLIENT_PORT=5178 PLAYWRIGHT_SERVER_PORT=7971 \
PLAYWRIGHT_MOBILE_CLIENT_PORT=5179 PLAYWRIGHT_MOBILE_SERVER_PORT=7972 \
SKIP_PWA=true VITE_HOST=127.0.0.1 VITE_OPEN_BROWSER=false \
node ./e2e/start-servers.mjs > /tmp/servers.log 2>&1 &

# 2. Wait until BOTH answer 200, then run the specs against them.
until curl -sf http://127.0.0.1:5178 >/dev/null && curl -sf http://127.0.0.1:5179 >/dev/null; do sleep 5; done
PLAYWRIGHT_SKIP_WEBSERVER=true pnpm smoke:ui --grep "<your specs>"
```

Free ports 5178/7971/5179/7972 first — the suite never reuses a dev server. Stop
the launcher when finished, and confirm the ports are released.

### Diagnosing a server that will not start

`playwright.config.ts` sets `LOG_LEVEL: "silent"` for the webServer, so a boot
failure appears as a bare timeout with no cause. To see what the server is
actually doing, boot it directly against a scratch data dir so real data is
untouched:

```bash
cd packages/server && PORT=7975 DATA_DIR=/tmp/bootdata LOG_LEVEL=info \
  AUTO_OPEN_BROWSER=false AUTO_CREATE_DEFAULT_CONNECTION=false npx tsx src/index.ts
```

A healthy boot logs the storage dir, seeds, and `listening on` within ~1–2s.
This is also the fastest way to exercise a new route end to end with `curl`
before involving a browser.

## Known-failing specs — do not chase these

These fail on a clean tree at `HEAD` with all work stashed, deterministically,
at the same durations every run:

- `Character favorite tags and stars inherit the configured accent color` (~1.0m)
- `Character Chat actions reuse mode selection and seed the chosen setup wizard` (~2.1m)

Both are `locator.click: Test timeout exceeded`.

If you see these, they are not yours. If you see *other* failures and need to
know whether your change caused them, the ladder is:

1. **Re-run the failing specs alone.** If they pass in isolation, it was
   contention from other work competing for CPU — done, no stashing.
2. **Only if they still fail**, stash everything and re-run at `HEAD`:
   `git stash -u -m "baseline check"` … `git stash pop`. Identical failures with
   identical durations mean pre-existing.

Scattered timings suggest flake; identical stopwatch readings across runs mean
deterministic, which is what makes step 2 worth the risk. Back up first
(`git diff HEAD > /tmp/wip.patch` plus copies of untracked files) and verify the
restore matches.

## Traps that produce false results

### Piping a run to `tail` destroys its exit code

```bash
pnpm smoke:ui 2>&1 | tail -80      # reports tail's status — a failed run looks green
pnpm smoke:ui > log 2>&1; echo "EXIT=$?" >> log   # correct
```

In a pipeline the shell reports the *last* command's status. This has already
caused a failing suite to be reported as passing. Whenever the exit code
matters — especially for background runs whose result you will act on —
redirect to a file and capture `$?` explicitly.

### `packages/shared/dist` is gitignored, so git will not protect it

`dist/` is a build output that both the server and the regression scripts
resolve `@marinara-engine/shared` through. It survives `git stash` untouched,
which means a baseline run on a stashed tree rebuilds it from *clean* source and
silently strips your new exports. Run `pnpm build:shared` after any stash
round-trip, after changing shared source, and before running a regression that
imports from `dist`. A running `pnpm dev:server` also needs a restart, since its
watcher ignores `../shared/dist`.

### Line endings: the repo stores LF, the checkout is CRLF

Scripted edits that insert `"\n"` into a CRLF file produce mixed endings —
invisible in a diff, but the formatter will later rewrite the whole file. Detect
the file's dominant ending before splicing:

```python
text = path.read_text(encoding="utf-8", newline="")   # preserve as-is
nl = "\r\n" if "\r\n" in text else "\n"
```

Then verify with `git diff --numstat`: a small edit must show a small number. A
four-figure line count on a file you barely touched means it was rewritten.

### The localization catalog sorts by `localeCompare`, not byte order

`scripts/check-locales.mjs` requires
`keys.sort((a, b) => a.localeCompare(b, "en"))`. Python's default `sorted()`
produces an order it rejects. Re-sort through Node, and confirm
`git diff --numstat packages/client/src/localization/locales/en.json` shows only
the keys you added — not a reshuffle of the whole file.

Every new user-facing string needs a semantic key in `en.json` rendered through
`useTranslation`. Do not copy English into other locale files; missing keys fall
back deliberately.

### `start-servers.mjs` needs `npm_execpath`

It reads `process.env.npm_execpath` to decide how to invoke pnpm. pnpm 11 sets
that for `pnpm run` but not for `pnpm exec` or a bare `node`, and without it the
script spawns literal `pnpm`, which has no directly-spawnable binary on Windows
(`spawn pnpm ENOENT`). Set it explicitly when invoking the launcher yourself.

### `git stash push` trips the local push guard

A hook blocks any command containing both `git` and `push`, so `git stash push`
is a false positive. Use `git stash -u -m "message"` — push is the default
subcommand.

## Local guards

This checkout may carry machine-local hookify rules in `.claude/hookify.*.local.md`
(git-excluded, so they will not exist on a fresh clone). They mechanise the traps
above plus a few conventions carried over from the author's other projects:

- `block-smoke-ui-double-dash` blocks the separator form of the smoke command.
- `warn-pipe-hides-exit-code` fires when a validation run is piped into `tail`.
- `block-claude-attribution` blocks AI attribution trailers in commits and PRs.
- `warn-git-add-all`, `warn-em-en-dash-commits`, `warn-ai-isms`,
  `warn-command-fluff`, `warn-pkill-self-match` cover staging and authored text.

Treat a fired rule as a real signal rather than an obstacle to route around. When
one blocks a command, the fix is in its message. If a rule is genuinely wrong for
a case, say so rather than rephrasing the command to slip past it.

Two quirks worth knowing. These rules match on raw command text, so they also
fire when you *write about* the pattern — documenting the bad form through a
bash heredoc trips the same block. Edit such files with the Write/Edit tools
instead, which the bash rules do not inspect. And the em-dash rule deliberately
covers commit text only: em dashes are this repo's house style in files (180+
server sources, `en.json`, `CONTRIBUTING.md`), so a file-level dash rule would
fight upstream.

## Fork-specific notes

- Record fork-only behavior in `FORK-CHANGES.md`, never `CHANGELOG.md`, and note
  whether the change patches a file upstream also edits — those are the ones a
  merge can silently revert.
- `pnpm check` runs the fork guards, so run it after every upstream merge.
- Node 24+ is required by `engines`. If Node 22 is installed, every pnpm command
  warns and everything still works — but it is the first thing to suspect when
  tooling behaves strangely.
- New file-backed tables do **not** need a `STORAGE_VERSION` bump; that gate is
  for layout changes to existing rows. Global (unsharded) tables register in
  `FILE_BACKED_TABLES` only, never `SHARDED_TABLES`.
