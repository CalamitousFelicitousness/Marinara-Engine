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

| Change touches                                    | Run                                                  | Cost        |
| ------------------------------------------------- | ---------------------------------------------------- | ----------- |
| Anything at all (baseline)                        | `pnpm check`                                         | ~2 min      |
| Prompt assembly, lorebook, macros, author's notes | `pnpm regression:prompt`                             | ~1 min      |
| Server behavior, one script                       | `node ./scripts/run-regressions.mjs --filter <path>` | seconds     |
| A new module you wrote                            | a new `scripts/regressions/**/*.regression.ts`       | seconds     |
| Chat UI shell, panels, popovers                   | the two relevant e2e specs (see below)               | ~1 min      |
| Broad refactor across surfaces                    | full `pnpm smoke:ui`                                 | **~1 hour** |

`pnpm check` runs stale-client cleanup, the Impeccable guard, both fork guards
(`agent-docs:check`, `dev-ports:check`), localization checks, the Prettier
format check, lint, typecheck, and the production build. It does **not** run regressions, and it does not
execute your code — it only proves it compiles and the guards hold.

That distinction matters. A green `pnpm check` says nothing about whether a
function you added actually returns the right thing, or whether a route is
mounted. Add a regression script for behavior, and lean on the e2e specs for
wiring.

### Regressions are the test suite

There is no Vitest or Jest. Tests are ~139 standalone `tsx` and `mjs` scripts
under `scripts/regressions/` that assert with `node:assert/strict` and print
`<name> regression passed.` Related lanes sit in subdirectories: `launcher/`,
`mari/`, `noodle/`, `professor-mari/`.

```bash
pnpm build:shared   # required when the script imports packages/shared/dist
node ./scripts/run-regressions.mjs --list
node ./scripts/run-regressions.mjs --filter scripts/regressions/<name>.regression.ts
```

`scripts/run-regressions.mjs` discovers every `*.regression.{ts,mjs,js}` under
`scripts/regressions/` recursively, so a new script needs no registration in
`package.json` to run in CI. Each file gets a fixed 30-second budget — a slower
test fails on time, not on its assertion.

`--filter` is one substring matched against the repo-relative path and throws
when nothing matches, so pass a full path: a moved file then fails loudly
instead of silently running nothing. The runner consumes a bare `--` itself, so
the pnpm separator trap below does not apply to it.

Delete any `.test.ts` file you created for local proof — the repo does not keep
them.

## Running the Playwright smoke suite

### It takes about an hour, and usually you want two specs, not all of them

180 specs × 2 projects (desktop + mobile Chromium) = 360 tests, and
`fullyParallel: false` with a single spec file means they run essentially one
after another at ~10s each. Before committing an hour, ask which specs actually
cover the change and grep for those.

```bash
pnpm smoke:ui --grep "Author's Notes"        # correct
pnpm smoke:ui --project=desktop-chromium
```

**Never write `pnpm smoke:ui -- --grep "..."`.** pnpm 11 forwards the literal
`--` into the command, and Playwright reads everything after a bare `--` as
positional _file filters_ rather than options. The filter is silently ignored
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

### `pnpm dev` dying instantly and silently is usually the writer lease

The storage layer allows one writer per data dir, enforced through the
`.writer-lease` lock directory (`data/storage/.writer-lease/owner.json` — a
directory, because `mkdir` is atomic; `cat` on the path fails with "Is a
directory", which is not the file being absent). If a previous dev server is
still alive when the next one starts — on Windows, Ctrl+C reliably kills the
pnpm wrapper but the `tsx` child can linger for many seconds — the new server
sees a live same-host PID and exits by design. Since the 2026-08-20 sync the
dev watcher stops instead of restart-looping (upstream 271658820), and the
process exits before the async Pino logger flushes, so the observable symptom
is exactly: `tsx watch` exits 1 with zero output, then
`Server process exited before it became ready`.

Check `netstat -ano | findstr :7870` and `tasklist | findstr node` for the
lingering process; otherwise just wait a few seconds and rerun. A lease whose
PID is dead is reclaimed automatically at next boot with a
`Reclaimed the writer lease` WARN — that line is normal, not a problem.

## Known-failing specs — do not chase these

**Regression suite re-baselined at the 2026-08-21 sync (81 commits, merge
`59d7a1f79`): 141/147 pass, 6 fail, listed below.** The Playwright specs in this
section are still unverified since the 2026-08-20 sync (447 commits) and have
not been re-run since. Re-confirm before trusting them; treat an unexpected pass
as good news, not a mystery.

These Playwright specs fail on a clean tree at `HEAD` with all work stashed,
deterministically, at the same durations every run:

- `Character favorite tags and stars inherit the configured accent color` (~1.0m)
- `Character Chat actions reuse mode selection and seed the chosen setup wizard` (~2.1m)
- `Professor Mari history opens a loaded chat at its newest message` (both projects,
  60s timeout each) — waits forever for the `Ask Professor Mari` button inside
  `[data-component="HomeProfessorMariChat.MariPanel"]`

All are `locator.click: Test timeout exceeded`.

`scripts/regressions/prompt.regression.ts` also fails, at the Beholder system
prompt: `The input did not match the regular expression /Persona: Mari
Current
state:/u`, actual `'Return a physical-state delta as JSON.'` — the raw
`promptTemplate`, unaugmented. Confirmed identical on a clean `upstream/staging`
worktree (`9b1853da3`, its own pnpm 10.34.5 install), so it is upstream's, not
this fork's. Beholder was still landing upstream when this was recorded.

It is the first `--filter` in `pnpm regression:prompt`, and `&&` chaining means
that lane exits before reaching `prompt-attachments`, `context-fit`, or
`author-note-presets`. Run those three individually until upstream fixes it:

```bash
node ./scripts/run-regressions.mjs --filter scripts/regressions/author-note-presets.regression.ts
```

### Regression suite: the 6 failures at the 2026-08-21 sync

Observed identically before and after that merge, so none are the sync's doing:

| Spec                                          | Attribution                                                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `open-issues.regression.ts`                   | upstream, see below                                                              |
| `prompt.regression.ts`                        | upstream, see above                                                              |
| `manual-agent-retry-resolution.regression.ts` | pins `emitMetadataPatch:` by source shape in `retry-agents-route.ts`             |
| `agent-runtime.regression.ts`                 | fails on "agent result vocabulary must retain its exact public values and order" |
| `launcher/format-guard.regression.mjs`        | was the fork's own bug, fixed 2026-08-21, see below                              |
| `launcher/update.regression.mjs`              | the fork's pnpm 11 migration, permanent, see below                               |

The middle two were observed failing but not traced to a side; do not assume
they are upstream's without checking. The two launcher lanes have since been
traced, and neither was upstream's.

**`launcher/format-guard.regression.mjs` was this fork's bug, now fixed.**
`SHARDED_TABLES` in `scripts/protect-launcher-data.mjs` is a hand-maintained
copy of `FILE_BACKED_TABLES` in `db/file-backed-store.ts`, and the lane pins the
two as `deepEqual`, order included. The fork's author's-note-presets work added
`author_note_presets` to the store list and not to the launcher copy, so the
lane had been failing on the fork's own omission the whole time, not on
anything upstream did. The consequence was real rather than cosmetic: the
unshard step folds sharded tables back into a monolith for a downgraded build,
and a table missing from that list is silently dropped, so a launcher downgrade
would have destroyed the fork's author's note presets. It is now in the
launcher copy and the lane passes. Any future table added to
`FILE_BACKED_TABLES` must be added there too, at the same position.

**`launcher/update.regression.mjs` fails by fork design and will keep failing.**
It asserts `packageManager` pins pnpm exactly `10.34.5`
(`update.regression.mjs:25`), which upstream's launcher expects. This fork
migrated to pnpm 11 on purpose, see `FORK-CHANGES.md`. Making the lane pass
means reverting that migration, so leave it red.

`open-issues.regression.ts` arrived failing with the 2026-08-21 merge, at
`Changing media providers must clear stale remote LoRA choices`. It is a
source-text `assert.match` against `ConnectionEditor.tsx`, and upstream both
rewrote that spec (+178 lines) and reformatted that component in the same
window, including a commit titled `ran prettier on connectioneditor.tsx`. This
fork has touched neither file since the merge base, and a regex over file
contents has no path by which fork code could affect it, so attribution is
conclusive on provenance alone. The empirical clean-worktree confirmation was
attempted and abandoned: the throwaway worktree hit `ENOSPC` mid-install.

If you see these, they are not yours. If you see _other_ failures and need to
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

### Never assume which server is running - detect it

Before driving a browser at this app, find the server. Assuming either one
wastes a whole debugging cycle, and it has already cost two: first assuming the
built server, then assuming the dev server.

```powershell
Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -in 7870,7871 } |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

| Listener | What it is | What to know |
| --- | --- | --- |
| `7870` | built server, serves `packages/client/dist` | `@fastify/static` runs with `wildcard:false`, so it enumerates `dist` **once at registration**. Any `pnpm check` or `pnpm build` after it started gives it a stale file list, and changed chunks 404. Needs a restart to see a rebuild. |
| `7871` | Vite dev server | Serves modules from source, so it is always current and immune to rebuilds. Unminified, so stack traces name real components. |

Two traps in that table:

- **Vite often binds IPv6 loopback only.** `LocalAddress` reads `::1`, and every
  `curl http://127.0.0.1:7871` returns connection-refused while the server is
  running perfectly. Use `http://[::1]:7871`.
- **A 404 on 7870 does not mean the user is seeing stale UI.** It means that
  server's static index is stale. If they are on the dev server, or a service
  worker is serving from precache, their browser is fine. Report what was
  measured, not what it seems to imply.

Prefer 7871 when both are up: current source, no asset-hash shim, readable
stacks. Decoding a minified helper out of a bundle to find a crash is a sign the
probe was pointed at the wrong server.

### Piping a run to `tail` destroys its exit code

```bash
pnpm smoke:ui 2>&1 | tail -80      # reports tail's status — a failed run looks green
pnpm smoke:ui > log 2>&1; echo "EXIT=$?" >> log   # correct
```

In a pipeline the shell reports the _last_ command's status. This has already
caused a failing suite to be reported as passing. Whenever the exit code
matters — especially for background runs whose result you will act on —
redirect to a file and capture `$?` explicitly.

### `packages/shared/dist` is gitignored, so git will not protect it

`dist/` is a build output that both the server and the regression scripts
resolve `@marinara-engine/shared` through. It survives `git stash` untouched,
which means a baseline run on a stashed tree rebuilds it from _clean_ source and
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

### The local push guard and `git stash push`

`~/.claude/hooks/block-git-push.py` is now subcommand-aware: it tokenizes the
command and only blocks when the first non-option word after `git` is `push`,
so `git stash push` passes (verified 2026-08-20). The old advice to spell it
`git stash -u -m "message"` is obsolete.

What still trips the guard is its fallback scan: a command that is unparseable,
or one where a shell-exec or interpreter word survives outside heredoc bodies
while `git` and `push` appear anywhere in the raw text. Since 2026-08-20 the
guard strips heredoc bodies precisely (quote-aware, immune to conflict-marker
fakes), so writing a doc file via `cat > x.md <<'EOF'` with a ` ```bash ` fence
and the phrase "git push" in the body passes. It also blocks `gh` subcommands
outside a read-verb allowlist, so `gh pr create` and friends are user-run only.

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
fire when you _write about_ the pattern — documenting the bad form through a
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
