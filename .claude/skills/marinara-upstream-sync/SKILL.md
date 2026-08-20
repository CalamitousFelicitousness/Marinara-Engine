---
name: marinara-upstream-sync
description: How to sync this fork with upstream Pasta-Devs/Marinara-Engine — why the merge is a merge and not a rebase, how to see every conflict before touching the working tree, the specific fork patches that collide on each sync and how each one is resolved, and the two reverts that no conflict marker will warn you about. Use this skill whenever the user wants to sync, rebase, update, merge, or pull in upstream changes; asks whether upstream has new commits or how far behind the fork is; mentions upstream/staging, a version bump, or a large batch of incoming commits; or hits a merge conflict anywhere in this repo. Consult it before resolving any conflict here, and before concluding that a post-merge test failure is yours.
---

# Syncing this fork with upstream

Upstream moves fast and this fork carries patches inside files upstream also
edits. A sync is therefore not a mechanical merge: the dangerous outcomes are
silent, not loud. A fork patch that gets reverted still compiles, still passes
lint, and only surfaces later as a feature that quietly stopped working.

This skill covers the merge itself. `CLAUDE.md` covers architecture and the
remote layout, `FORK-CHANGES.md` lists what this fork changes and which of
those live in files upstream also touches, and
`.claude/skills/marinara-validation/SKILL.md` covers proving the result works.

Everything below was verified on the 2026-08-20 sync: 447 upstream commits,
84 PR merges, v2.4.3 to v2.4.4, merge commit `151a263f5`.

## Merge, never rebase

`CLAUDE.md § Fork Workflow` prescribes a merge, and the remote layout assumes
one. `staging` tracks `upstream/staging` for fetch while `remote.pushDefault`
sends pushes to `origin`, so a bare push is correct and `-u` would retarget
tracking and break the split.

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

Branch a backup first. It costs nothing and makes the merge trivially
abandonable:

```bash
git branch -f pre-sync-backup staging
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

### The recurring conflicts, by file

| File                                       | Shape                           | Resolution                                    |
| ------------------------------------------ | ------------------------------- | --------------------------------------------- |
| `routes/generate/retry-agents-route.ts`    | semantic                        | see below, the dangerous one                  |
| `package.json`                             | fork guards vs upstream scripts | keep both, see below                          |
| `localization/locales/en.json`             | adjacency                       | keep both blocks, `localeCompare` order       |
| `e2e/core-flows.e2e.ts`                    | adjacency                       | keep both tests, close the first              |
| `pnpm-lock.yaml`                           | regenerable                     | take upstream's, then `pnpm install`          |
| `scripts/dev.mjs`, `client/vite.config.ts` | the `.env` PORT patch           | keep the fork's, guarded by `dev-ports:check` |

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

**`package.json`** carries fork guards upstream does not have. Keep
`agent-docs:check` and `dev-ports:check` in `check` alongside whatever upstream
has added, and re-add the fork's `author-note-presets` filter to
`regression:prompt`.

**Adjacency conflicts** — `en.json` and `core-flows.e2e.ts` — mean both sides
appended at the same point. Keep both. In `en.json` the surviving order must
satisfy `localeCompare`, not byte order. In the e2e spec both sides typically
end mid-`finally`, so the first test needs its closing braces added back.

## Checks that no conflict marker will warn you about

Two reverts happen without a conflict, because only one side edits the file.

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
`pnpm-workspace.yaml` by hand.

**`AGENTS.md`.** Upstream hand-edits it directly, while this fork generates it
from `CLAUDE.md` plus `.github/agents/codex-overlay.md`. An upstream
`AGENTS.md` edit therefore arrives as a clean auto-merge that
`pnpm agent-docs:check` then rejects. Fold the new content into `CLAUDE.md` at
the matching position, then:

```bash
pnpm agent-docs:sync
```

Upstream maintains its own `CLAUDE.md` too — 15 commits of history as of
2026-08, though none landed in that sync's window. When a sync does bring a
`CLAUDE.md` change, merge it into the fork's `CLAUDE.md` (the generation
source) and regenerate the same way.

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
runs `agent-docs:check` and `dev-ports:check`, which exist for exactly that.
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
