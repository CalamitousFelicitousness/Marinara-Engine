---
name: marinara-upstream-sync
description: How to sync this fork with upstream Pasta-Devs/Marinara-Engine — why the merge is a merge and not a rebase, how to see every conflict before touching the working tree, the specific fork patches that collide on each sync and how each one is resolved, and the silent losses that no conflict marker will warn you about. Use this skill whenever the user wants to sync, rebase, update, merge, or pull in upstream changes; asks whether upstream has new commits or how far behind the fork is; mentions upstream/staging, a version bump, or a large batch of incoming commits; or hits a merge conflict anywhere in this repo. Consult it before resolving any conflict here, and before concluding that a post-merge test failure is yours.
---

# Syncing this fork with upstream

Upstream moves fast and this fork carries patches inside files upstream also
edits. A sync is therefore not a mechanical merge: the dangerous outcomes are
silent, not loud. A fork patch that gets reverted still compiles, still passes
lint, and only surfaces later as a feature that quietly stopped working.

This skill covers the merge itself. `FORK-CHANGES.md` lists what this fork
changes and which of those live in files upstream also touches, and
`.claude/skills/marinara-validation/SKILL.md` covers proving the result works.

Everything below was verified on the 2026-08-20 sync: 447 upstream commits,
84 PR merges, v2.4.3 to v2.4.4, merge commit `151a263f5`.

Re-exercised on the 2026-08-21 sync: 81 upstream commits, merge `59d7a1f79`.
`git merge-tree` predicted zero conflicts and the merge produced none, so every
check below ran against a clean auto-merge. All passed: the `authorNotes`
resolution in `retry-agents-route.ts` landed correctly on its own (upstream's
`activeChatSummary` with the fork's `toAuthorNotesContextText` beside it),
`package.json#pnpm` was unchanged, and upstream touched neither `AGENTS.md` nor
`CLAUDE.md`. A conflict-free merge is therefore not evidence you can skip these:
it is the case that makes them worth running.

Stress-tested on the 2026-09-11 sync: 240 upstream commits, 69 overlapping
files, 29 conflicts, v2.4.5 on both sides with no storage bump. Commit count
does not predict the work. The 2026-08-20 sync pulled 447 commits for 7
conflicts; this one pulled 240 for 29, because the overlap set grew from 18
files to 69. Measure the overlap, not the log.

On 2026-10-03: 564 commits, 82 overlapping files, 30 conflicts, one merge.
The conflicted line counts pointed the wrong way. The largest conflict, 585
lines in `TTSConfigCard.tsx`, was a one-sided keep; the riskiest outcomes carried
no marker or a small one. Read what each side changed, not how much.

Largest so far on 2026-09-27: 1141 upstream commits in sixteen days, 130
overlapping files, 64 simulated conflicts, v2.4.6 and storage format 7. It ran
as two merges split at the release point (see **Split a large sync** below), 36
conflicts then 47, with `pnpm check` and the regression suite between them.
Three of the collisions were features both lineages had built separately.

On 2026-10-09: 1016 commits in seven days, v2.4.6 to v2.5.0, 113 overlapping
files, 45 conflicts, one merge. The split was weighed and rejected: the
release-point half held 34 conflicts including all three duplicated features,
so a second merge would only have re-conflicted the hot files. Five read-only
subagents, one per collision area, previewed the merge from the simulated tree
before anything was touched; their reports named every silent loss later fixed.

## Merge, never rebase

The remote layout assumes a merge. `staging` tracks `upstream/staging` for
fetch while `remote.pushDefault` sends pushes to `origin`, so a bare push is
correct and `-u` would retarget tracking and break the split.

A rebase replays the fork's commits over hundreds of upstream ones. The fork's
commits touch the same few files repeatedly, so the same conflict arrives once
per commit instead of once in total, and the result needs a force-push over
history already published on the fork. A merge resolves each conflict exactly
once and keeps the ahead/behind reading meaningful.

If the user asks for a rebase, say what the merge buys and let them choose.
They may have a reason.

## Preview the collision surface before touching the tree

`git merge-tree` simulates the merge entirely in the object database. No index,
no working tree, nothing to abort.

```bash
git fetch upstream --prune
git merge-tree --write-tree --name-only staging upstream/staging
```

Output starts with the resulting tree OID, then conflicted paths, then the
per-file merge log. Exit status is non-zero when conflicts exist.

The number of incoming commits barely predicts the work. What matters is which
files both sides touched:

```bash
BASE=$(git merge-base staging upstream/staging)
git diff --name-only "$BASE" staging          | sort > /tmp/fork_files.txt
git diff --name-only "$BASE" upstream/staging | sort > /tmp/up_files.txt
comm -12 /tmp/fork_files.txt /tmp/up_files.txt
```

On 2026-08-20 that was 764 upstream-changed files, 18 overlapping with fork
changes, 7 real conflicts. Read the overlap list before starting: those 18 are
where a patch can be reverted, whether or not git flags them.

### Sort the conflicts by how much of each is formatting

Run the simulation twice, once whitespace-sensitive and once not, and compare
the conflicted line count per file. A file that shrinks is carrying upstream
re-indentation; a file that does not is a genuine two-sided rewrite. Doing this
before resolving anything tells you where the judgment is actually needed.

```bash
git merge-tree --write-tree --name-only staging upstream/staging > /tmp/mt.txt
git merge-tree --write-tree -Xignore-space-change --name-only staging upstream/staging > /tmp/mt_ws.txt
T1=$(head -1 /tmp/mt.txt); T2=$(head -1 /tmp/mt_ws.txt)
COUNT='/^<<<<<<</{f=1} f{n++} /^>>>>>>>/{f=0} END{print n+0}'
for f in $(sed -n '2,/^$/p' /tmp/mt.txt | grep -v '^$'); do
  printf "%6s %6s   %s\n" \
    "$(git show "$T1:$f" 2>/dev/null | awk "$COUNT")" \
    "$(git show "$T2:$f" 2>/dev/null | awk "$COUNT")" "$f"
done | sort -rn
```

On 2026-09-11 that moved about 470 conflicted lines out of the pile.
`ConversationInput.tsx` and `marinara.importer.ts` went to zero, so they needed
no decision at all. `SettingsPanel.tsx` dropped 197 to 80 and `ChatMessage.tsx`,
the largest conflict in the merge, 383 to 204. The other fourteen files did not
move, which is the useful half of the signal: they are unchanged because they
are real disagreements. See **Re-merge a re-indented file with whitespace
ignored** below for taking a single file from the second tree.

Branch a backup first. It costs nothing and makes the merge trivially
abandonable:

```bash
git branch -f pre-sync-backup staging
```

### Split a large sync at a release point

When the simulation shows more conflicts than one session can check, merge to
the upstream commit a release tag was cut from first, then to the tip. Each half
gets its own `pnpm check` and regression run, and the first lands on a released
version. Hot files conflict in both halves, so the total is larger (36 and 47
against 64 on 2026-09-27); the gain is that a failure has half the suspects.

```bash
MID=$(git merge-base v2.4.6 upstream/staging)
git merge-tree --write-tree --name-only staging "$MID"
```

The second half can be previewed before the first is committed, and while its
regressions still run, from a throwaway commit object. Nothing moves the branch
or touches the tree:

```bash
git add -A   # merge in progress, markers resolved
C=$(git commit-tree "$(git write-tree)" -p HEAD -p MERGE_HEAD -m tmp)
git merge-tree --write-tree --name-only "$C" upstream/staging
```

## Resolving

### Never `git checkout --ours` or `--theirs` on a conflicted source file

Both replace the **entire file**, not the conflicted hunks. Every upstream
change that merged cleanly in that file is discarded, and nothing marks what
was lost.

Undo it by regenerating the conflict:

```bash
git checkout --merge -- <file>
```

`--theirs` is correct for a regenerable file. `pnpm-lock.yaml` is the standard
case: take upstream's, then run `pnpm install` and let the result be rewritten.
Never hand-merge a lockfile.

### After a rename conflict, grep the whole file

When upstream renames an identifier, the conflicted hunks cover only the places
both sides edited. Fork-only code elsewhere in the same file merges cleanly and
still refers to the old name, so the file reads as resolved and fails in `tsc`.

The 2026-08-20 case: upstream renamed `ROLEPLAY_POPOVER_*` to
`NEUTRAL_PANEL_*` in `ChatRoleplayPanels.tsx`. Two references sat inside
conflict hunks; a third, in fork-only code, did not. After resolving a rename,
grep the file for the old identifier before moving on.

### When upstream hoists a literal, diff the two field lists

Upstream refactors by lifting a long inline object literal into a module-level
function. The conflict then reads as two hundred lines against one, and the
tempting conclusion is that upstream refactored and the fork should take
theirs. Taking theirs compiles, lints and passes every regression while
dropping every field the fork had added to that literal. TypeScript does not
complain that a picker omits fields.

The 2026-09-11 case: upstream moved `partialize: (state) => ({ ... })` out of
the `ui.store.ts` persist config into `pickPersistedUIState`. Six fork fields
lived only in the inline version, `messageControlsAbove` among them, three
commits old at the time. The hoisted function also carried upstream's
`trackerPanelSizeProfile`, which the fork had replaced with free-width sizing,
so that half did fail `tsc`. The six missing fields would not have.

Compare the two sets rather than reading them:

```bash
BASE=$(git merge-base staging upstream/staging)
git show "$BASE:<file>"          | sed -n '/<literal start>/,/^  }/p' | grep -o '^ *[a-zA-Z]*:' | tr -d ' :' | sort > /tmp/fork_fields.txt
git show upstream/staging:<file> | sed -n '/<function start>/,/^}/p'  | grep -o '^ *[a-zA-Z]*:' | tr -d ' :' | sort > /tmp/up_fields.txt
comm -23 /tmp/fork_fields.txt /tmp/up_fields.txt   # fork-only: add to the hoisted function
comm -13 /tmp/fork_fields.txt /tmp/up_fields.txt   # upstream-only: new fields the fork gains
```

The same shape also arrives with no marker at all. Upstream added
`pickSyncedSettings` in the same window, wholly new, listing the same tracker
fields. It merged cleanly and carried upstream's list, so four fork fields were
missing from a function nothing pointed at. After resolving a hoist, grep the
file for sibling functions of the same shape and check each one.

### Re-merge a re-indented file with whitespace ignored

A conflict running to hundreds of lines on both sides usually means upstream
re-indented, not that both sides rewrote the same code. On 2026-09-11
`ui.store.ts` showed 8 hunks and 1540 conflicted lines because upstream
rewrapped the store creator from `(set, get) => ({ ... })` into
`(setState, get) => { const set = ...; return { ... } }` to route writes
through `deferEditorLeave`, moving about 900 lines two spaces right.

`git merge-file` has no whitespace option. `git merge-tree` does, so simulate
the merge with it and take the single file:

```bash
git merge-tree --write-tree -Xignore-space-change --name-only staging upstream/staging > /tmp/mt_ws.txt
git show "$(head -1 /tmp/mt_ws.txt):packages/client/src/stores/ui.store.ts" > /tmp/ui.ws.ts
```

That dropped the file to 5 hunks and roughly 260 lines. Prettier restores the
indentation in `pnpm format`, so the mixed result does not survive `pnpm
check`. Before adopting the extracted file, grep it for a symbol each side
added and confirm both are present.

### The recurring conflicts, by file

| File                                       | Shape                           | Resolution                                    |
| ------------------------------------------ | ------------------------------- | --------------------------------------------- |
| `routes/generate/retry-agents-route.ts`    | semantic                        | see below, the dangerous one                  |
| `stores/ui.store.ts`                       | re-indent plus hoisted literal  | re-merge ignoring whitespace, then diff keys  |
| `package.json`                             | fork guards vs upstream scripts | keep both, see below                          |
| `localization/locales/en.json`             | adjacency                       | keep both blocks, `localeCompare` order       |
| `localization/locales/<lang>.json`         | upstream deleted the packs      | take the delete, see below                    |
| `e2e/core-flows.e2e.ts`                    | adjacency                       | keep both tests, close the first              |
| `pnpm-lock.yaml`                           | regenerable                     | take upstream's, then `pnpm install`          |
| `scripts/dev.mjs`, `client/vite.config.ts` | the `.env` PORT patch           | keep the fork's, guarded by `dev-ports:check` |
| `settings/TTSConfigCard.tsx`               | upstream edits a region cut     | keep the fork's hunk, re-home the change      |
| `chat/ChatMessage.tsx` action bars         | upstream edits its inline bars  | add the new items to the extracted bars       |

**`retry-agents-route.ts` is the one to slow down for.** The fork's
`authorNotes` derivation sits in the same object literal as `chatSummary`,
which upstream keeps refactoring. The two sides fail asymmetrically:

- Keeping the fork's side is a **compile error**, caught by `pnpm lint`.
- Keeping upstream's side is a **silent revert** of author's-note preset
  injection on agent retry. Nothing fails except the fork's own regression.

Resolve as upstream's `chatSummary` plus the fork's `authorNotes`. In 2026-08
that meant upstream's precomputed `activeChatSummary` (from the async
`resolveRoleplayChatSummaryForPrompt`) with the fork's
`toAuthorNotesContextText(collectAuthorNoteEntries(...))` beside it.

Expect this file to conflict on most syncs. The asymmetry is the point: a
default of "take theirs" is wrong here in a way **nothing in the suite
currently catches**. `author-note-presets.regression.ts` exercises the shared
helpers in `services/prompt/author-notes.ts`, not this route's wiring, so the
revert passes every check. Verify the resolution by reading the merged file.

**`package.json`** carries a fork guard upstream does not have. Keep
`dev-ports:check` in `check` alongside whatever upstream has added, and re-add the fork's `author-note-presets` filter to
`regression:prompt`.

**Adjacency conflicts** — `en.json` and `core-flows.e2e.ts` — mean both sides
appended at the same point. Keep both. In `en.json` the surviving order must
satisfy `localeCompare`, not byte order. In the e2e spec both sides typically
end mid-`finally`, so the first test needs its closing braces added back.

**The community locale packs are gone upstream.** #5865 replaced the eleven
bundled files with on-demand download: `locale-loader.ts` globs only `en.json`
and fetches the rest from `/api/ui-languages/<locale>` as an explicit settings
action. Every pack the fork had edited arrives as modify/delete. Take the
delete. The fork's edits to those files were stale-key pruning, and the whole
mechanism comes across, so nothing is lost by dropping eleven stale
translations.

**`AGENTS.md` is upstream's, unmodified.** Take upstream's side of every change
to it. A fork edit there turns each later upstream edit into a conflict.

**The store persistence version no longer has to collide.** Both lineages used
to number `version:` independently from a shared ancestor, which is why the
fork's migrate guards were widened by hand. Upstream now reads the name and
number from `lib/ui-persistence.ts`, so the next collision is a one-line file
rather than a hand-audited guard sweep. Adopt it. Where an upstream step is
guarded below the fork's current number, widen that guard so a fork store still
runs it: on 2026-09-11 upstream's character-sheet step read `version <= 99`
against fork stores sitting at 100.

### When both lineages built the same feature, pick one

A conflict between two implementations of one idea is not resolved by keeping
both. On 2026-09-27 there were three: parameter source tracking (upstream's
string `parameterSources` against the fork's typed trace), NanoGPT plan
coverage (upstream #6686 against the fork's `/connections/:id/subscription`),
and the 404 for stale asset chunks (`createClientNotFoundHandler` against
`isNonSpaRequest`). Decide which one survives, port the other's consumers onto
it, and delete the loser with its lane. Ask the user when the choice changes
what they see.

Then look for the two stacking. Upstream moved NanoGPT's `detailed=true` into
`modelsEndpoint`; the fork's own query suffix would have requested it twice,
and nothing would have failed.

The duplicate is not always a conflict. On 2026-10-09 upstream's Character
Editor Voice section arrived in new files and its routes merged cleanly, but
they wrote the app-level TTS settings that the fork's per-connection casting
overrides: a save returned 204, showed as saved, and was never spoken, while
upstream's own lane passed. For each new upstream feature, ask which record it
writes and whether the fork resolves that record the way upstream does.

### Upstream reuses a key or helper the fork deleted

When the fork prunes something upstream still has (stale localization keys, a
gutted component's helpers), the merge keeps the deletion. A new upstream
consumer of that name then fails in `pnpm localization:check` or `tsc`, not as a
conflict. On 2026-10-09 four `ui.panels.ttsconfigcard.*` keys and
`buildTTSVoiceOptions` came back this way. Two more, the tracker add-mode keys,
passed every check and showed as raw text on a button: `localization:check` and
upstream's key lane only read `localizeUi("literal")`. The fork's
`localization-key-literals` lane reads every catalog-shaped literal; run it
after each sync. Restore the key from upstream's
catalog, or point the consumer at the fork's equivalent; do not rewrite
upstream's consumer around the gap.

### Upstream lanes seed upstream's data model

A new upstream regression that fails on an assertion about a value, not a
crash, may be seeding data the fork reads differently. Several seed
`chatParameters: { temperature: ... }`, which the fork ignores at runtime in
favour of `chatParameterOverrides`. Re-seed the fixture in the fork's shape and
keep the assertions; the behavior under test is the same.

The same goes for defaults. The fork turns provider, TTS and STT LAN reach on
by default; an upstream lane that deletes `PROVIDER_LOCAL_URLS_ENABLED` and
asserts a refusal then times out on the fetch instead. Set the flag to `false`
in the lane. Upstream e2e specs seed `trackerPanelSizeProfile`, which the fork's
store replaced with `trackerPanelWidth`; `tsc` in `check:e2e-types` catches it.

### Upstream tests of the Trackers window are skipped, not adapted

The fork never mounts upstream's Trackers window (`trackersWindowAvailable` in
`RoleplayTrackerWindow.tsx`); trackers show only in the Tracker Panel. A new
upstream e2e test that seeds `trackerPanelEnabled: false` on a computer, or
looks for `[data-window="trackers"]`, fails on its first locator. Add its title
to `e2e/fork-excluded-tests.ts` instead of editing the spec, then check it
dropped out of `playwright test --list --project=desktop-chromium`. A conflict
on the `showWindow` line means upstream changed when the window shows: keep the
gate.

## Checks that no conflict marker will warn you about

Six losses happen without a conflict, or behind one that looks routine. The
first is a revert, because only one side edits the field; the second is an
inbound fix that lands nowhere; the third is a fork field missing from code
upstream added whole; the fourth is an upstream call to a helper the fork
retired; the fifth is upstream cleanup code that destroys a fork path; the sixth
is two features that each work alone.

**`package.json#pnpm`.** This fork moved dependency overrides into
`pnpm-workspace.yaml` for pnpm 11; upstream stays on pnpm 10.x and keeps them
in `package.json#pnpm`, a field this fork no longer reads. An override upstream
adds there merges cleanly and does nothing. Diff the field every sync:

```bash
BASE=$(git merge-base staging upstream/staging)
git show "$BASE:package.json"          > /tmp/pkg_base.json
git show upstream/staging:package.json > /tmp/pkg_up.json
python -c "import json;print(json.dumps(json.load(open('/tmp/pkg_base.json')).get('pnpm',{}),indent=1,sort_keys=True))" > /tmp/pnpm_base.txt
python -c "import json;print(json.dumps(json.load(open('/tmp/pkg_up.json')).get('pnpm',{}),indent=1,sort_keys=True))"   > /tmp/pnpm_up.txt
diff /tmp/pnpm_base.txt /tmp/pnpm_up.txt
```

Anything new on the upstream side has to be mirrored into
`pnpm-workspace.yaml` by hand. On 2026-09-11 that was `hono` and `js-yaml`,
both security bumps. Note that upstream has started writing
`patchedDependencies` and `auditConfig` into `pnpm-workspace.yaml` directly;
those merge cleanly and need no mirroring. Only `overrides` is split.

On 2026-10-09 upstream deleted the `overrides` block from its
`pnpm-workspace.yaml` as one pnpm 10 ignores (#7146). That block is the only
one the fork reads, so the delete conflicts with the fork's list: keep the
fork's block and add upstream's new `package.json#pnpm` pins to it.

**An upstream fix aimed at code this fork relocated.** Where the fork has gutted
a file and moved its parts elsewhere, an upstream fix to the moved part arrives
as a conflict in the file the fork emptied. Resolving that in the fork's favour
is correct and still drops the fix, because its destination is a file upstream
has never heard of and no marker points at. Nothing fails: the fork keeps
compiling, and keeps the bug upstream just closed.

The 2026-09-05 case: the fork had cut `TTSConfigCard.tsx` from 1747 lines to a
playback-settings card, moving the voice picker to
`components/connections/audio/voice-controls.tsx`. Upstream then spent two
commits adding keyboard-focus restoration to that picker (#5633, #5642) inside
the region the fork had deleted. The relocated copy had the same
`disabled={fetchingVoices}` trigger and the same synchronous
`triggerRef.current?.focus()`, so it carried both bugs verbatim.

Find these by listing the overlap for files the fork gutted, then reading what
upstream added to each:

```bash
BASE=$(git merge-base staging upstream/staging)
git diff --numstat "$BASE" staging | awk '$2 > 100 {print $3}' | sort > /tmp/gutted.txt
git diff --name-only "$BASE" upstream/staging | sort | comm -12 /tmp/gutted.txt -
```

For each hit, decide where the fix belongs now rather than whether to keep it.
Grep the fork's destination file for the symptom the fix names, not for the fix.

The destination is not always the relocated file, and assuming it is wastes the
check. `TTSConfigCard.tsx` conflicted again on 2026-09-11, this time over
upstream's new `blocked` playback state (#5889). The obvious guess, that the
fix belonged in `voice-controls.tsx` the way the focus fix had, was wrong:
that file has no `ttsState` reference at all. The state lives in the playback
card the fork kept, where four of the five call sites merged cleanly on their
own and only one needed porting by hand. A gutted file is 665 lines against
upstream's 2380 and still owns some of what upstream changed. Grep for the
symptom in every candidate before deciding which one is the destination.

**A fork field missing from a function upstream added whole.** When upstream
introduces a new function that enumerates state the fork has extended, the file
has nothing to conflict against, so the new function lands carrying upstream's
field list alone. `pickSyncedSettings` in `ui.store.ts` did this on 2026-09-11.
The failure is invisible in both directions: the function compiles, and no test
asserts that a given field is persisted or synced. Find these by listing the
functions that enumerate store fields and diffing each against the fork's
equivalent, as under **When upstream hoists a literal** above.

**An upstream addition that calls the helper the fork replaced.** Where the fork
has swapped a helper for a stricter wrapper, upstream keeps writing new call
sites against the original. The import line conflicts, so the loss looks like a
missing import and the obvious repair is to add it back. Doing that compiles and
reinstates exactly the defect the wrapper exists to prevent.

The 2026-09-11 case: the fork replaced `buildPromptMacroContext` in routes with
`buildChatMacroContext`, whose docstring says every chat-scoped field "a call
site used to be free to omit, and several silently did" is derived rather than
passed. Upstream then added a second `buildPromptMacroContext` call in
`game.routes.ts` for lorebook resolution, passing `variables: {}` and a bare
`chatId` and omitting the local variable store, the timezone, the group scenario
override and the storyboard keyframe count. `pnpm check` named only the missing
import.

When a conflict resolves to "an identifier is not defined", check whether the
fork deliberately retired it before restoring the import. `git log -S` on the
old name finds the commit that replaced it, and its message says why.

**Upstream cleanup code that destroys a fork path.** When upstream wraps a
function in `try`/`catch` and the `catch` removes what the function created, a
fork branch inside that `try` which updates an existing row instead of creating
one inherits the rollback. The resolution compiles and reads as "wrap the fork's
branch in upstream's new error handling", and a failure then deletes the user's
data.

The 2026-10-03 case: upstream's lorebook importer gained reference images, saved
inside a `try` whose `catch` runs `storage.remove(newLb.id)`. The fork's overwrite
path set `newLb` to the user's existing lorebook, so a failed re-import would
have removed it. Read every new `catch`, `finally` and rollback in a conflicted
function and ask what it does to a row the fork's side did not create.

**Two features that each work alone.** Upstream adds state kept per swipe or per
message, and the fork adds a feature that creates swipes or messages its own way.
Neither file conflicts, both lanes pass, and the combination is wrong.

The 2026-10-03 case: upstream records each turn's chat-variable changes on the
swipe that produced them and replays them when the active swipe changes. Fork
multiswipe appends candidates 2..N as silent swipes after candidate 1 is
recorded, so they carried nothing, and browsing to one undid every `{{setvar}}`
the shared prompt ran. For each new upstream per-swipe or per-message record,
check it against multiswipe, branches and the fork's import overwrite, which all
create or replace those rows outside upstream's paths.

**Upstream e2e specs drive upstream's UI.** A new spec that finds a control by
label in a surface the fork restructured fails on the locator, not on the
behavior. Adapt it to the fork's surface and keep its assertions; on 2026-10-03
`author-notes.e2e.ts` and `tts-pcm-settings.e2e.ts` needed that.

## Proving a failure is upstream's, not yours

After a large sync something will fail, and the first question is whose it is.
Answer with evidence rather than reasoning.

Establish what the fork actually owns in that area:

```bash
git diff --name-only upstream/staging HEAD -- packages/server packages/shared
```

If every file on the failing code path is absent from that list, it is
byte-identical to upstream. Strong, but not conclusive: the fork may still
change a shared export that alters behavior elsewhere. Confirm empirically in a
throwaway worktree, which gets its own install and its own pnpm:

```bash
git worktree add --detach /tmp/upwt upstream/staging
cd /tmp/upwt && pnpm install --ignore-scripts && pnpm build:shared
node ./scripts/run-regressions.mjs --filter scripts/regressions/<name>.regression.ts
```

An identical failure there is upstream's. Record it as known-failing in
`.claude/skills/marinara-validation/SKILL.md` so the next session does not
re-investigate it.

Clean up afterwards. A plain `git worktree remove` refuses because
`node_modules` is untracked; `--force` normally deletes it, but on Windows it
can still fail with `Directory not empty` when a file inside is locked (it did
on the 2026-08-20 sync), so finish with the `rm -rf`:

```bash
git worktree remove --force /tmp/upwt; git worktree prune; rm -rf /tmp/upwt
```

## Validate and record

`pnpm check` is the real test of whether the merge reverted a fork patch. It
runs `dev-ports:check`, which exists for exactly that.
`pnpm lint` does not typecheck the client app: its `tsc` covers only the
regression lanes, and the app's own `tsc -b` runs inside `pnpm build`, last.
Run `packages/client/node_modules/.bin/tsc -b` from `packages/client` straight
after resolving to see every client type error at once instead of one per
`pnpm check` round.
Then run the fork's own regressions, since those are what a silent revert
breaks. `.claude/skills/marinara-validation/SKILL.md` covers the rest,
including which failures are already known.

Record anything a future sync needs in `FORK-CHANGES.md`, never `CHANGELOG.md`
— upstream rewrites its `[Unreleased]` region constantly and a fork entry there
conflicts on every sync. Note specifically which fork patches sit in files
upstream also edits, because those are the ones a merge can silently revert.

After the push lands, drop the backup with the safe delete, which refuses
unless the branch is fully merged:

```bash
git branch -d pre-sync-backup
```
