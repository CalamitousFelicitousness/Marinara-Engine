# Fork Changes

Changes that exist only in this fork (`CalamitousFelicitousness/Marinara-Engine`), kept here rather than in `CHANGELOG.md` so syncing with `upstream/staging` does not conflict on every merge.

Upstream is [Pasta-Devs/Marinara-Engine](https://github.com/Pasta-Devs/Marinara-Engine). See `CLAUDE.md § Fork Workflow` for the sync and run procedure.

## Patches to upstream files

These live inside files upstream also edits, so an upstream merge can silently revert them. Re-check after every sync.

### Dev-server port resolution

`scripts/dev.mjs` and `packages/client/vite.config.ts` now load the repo-root `.env` before resolving `PORT`, matching how the server resolves it in `packages/server/src/config/runtime-config.ts`.

Upstream reads `PORT` only from `process.env` in both files and falls back to `7860`. The server reads the repo `.env`, so setting `PORT=7870` there makes the server bind 7870 while the readiness probe polls 7860 and the client proxies `/api` to 7860. `pnpm dev` then fails after the full 120-second timeout with `Server did not become ready ... (fetch failed)` and no indication that a port is involved — made harder to spot because `LOG_LEVEL=warn` suppresses the server's own "listening on" line.

`process.loadEnvFile()` never overrides a value already in the environment, so `PORT=... pnpm dev` still wins over the file. In `vite.config.ts` the load must stay **above** `DEV_SERVER_PORT`, because those constants evaluate at module load.

Guarded by `pnpm dev-ports:check`, which runs inside `pnpm check`.

## Fork-only additions

### Author's note presets

Author's notes were a single free-text string per chat (`chatMeta.authorNotes` plus
`authorNotesDepth`). They are now backed by a reusable library: presets live in a new global
`author_note_presets` table, and each chat records which of them are switched on in
`ChatMetadata.activeAuthorNotePresetIds`.

Several presets can be active at once and each carries its own injection depth, so a standing
style note can sit deep in the history while an urgent plot beat sits at depth 0. Where two
notes share a depth, presets come first in library order and the chat-local note comes last,
so the ad-hoc note sits closest to the model's turn and wins a contradiction by recency. The
chat-local note is unchanged and still always-active, so existing chats need no migration.
Clicking a preset loads it into the panel's text box for editing.

Saving is explicit: the box never writes on blur, on close, or on switching away. A changed
note is marked `(edited)` beside **Save** and on its row in the list. Leaving it for another
preset raises a three-way guard — **Save and switch**, **Discard**, or **Keep editing** — and a
failed save keeps the editor where it is with the text still marked, since there is no global
mutation error handler. Promoting a typed note with **Save as preset** prompts for the name
rather than deriving one from the first line. Unsaved text survives the popover closing: the
draft is parked in memory per chat, never written, so an outside click cannot destroy it, and
a reload drops it like any unsaved edit.

Patches to upstream files: `packages/shared/src/types/chat.ts` (`ChatMetadata` gains the three
fields — note that `authorNotes` and `authorNotesDepth` were previously read via untyped casts
and declared nowhere), `packages/server/src/routes/generate.routes.ts`,
`packages/server/src/routes/generate/dry-run-route.ts`,
`packages/server/src/routes/generate/retry-agents-route.ts`,
`packages/server/src/routes/chats.routes.ts`, `packages/server/src/db/file-backed-store.ts`
(table registration only — no `STORAGE_VERSION` bump, since new tables are additive),
`packages/client/src/components/chat/ChatRoleplayPanels.tsx`,
`packages/client/src/components/chat/ChatRoleplaySurface.tsx`, and `e2e/core-flows.e2e.ts`.

The `ChatRoleplaySurface.tsx` patch is one guard: the Author's Notes popover's outside-click
handler now ignores clicks inside `[data-chat-floating-panel]`. It already exempted
`[data-macro-modal]`; app dialogs portal outside the popover, so without this the panel
unmounted underneath the name prompt and the discard guard it had just opened. Same guard
`ChatGalleryDrawer` and `ChatSettingsDrawer` already carry.

The 2026-08-20 sync conflicted in `retry-agents-route.ts`: upstream replaced the synchronous
`resolveRoleplayChatSummary(chatMode, chatMeta)` with a precomputed `activeChatSummary` from the
async `resolveRoleplayChatSummaryForPrompt`, inside the same object literal that carries
`authorNotes`. The two sides fail asymmetrically — keeping the fork side is a compile error
(the old resolver is no longer imported), keeping upstream's is a silent revert of preset
injection on agent retry. Resolve as upstream's `chatSummary` plus the fork's `authorNotes`.

`ChatRoleplayPanels.tsx` also conflicted: upstream renamed `ROLEPLAY_POPOVER_*` to
`NEUTRAL_PANEL_*`. Fork-only code referencing the old names auto-merges cleanly and then fails
to compile, so rename every reference, not just the conflicted hunks.

Those three generation routes each re-derived the note and re-hardcoded the default depth of
`4` independently. They now share `packages/server/src/services/prompt/author-notes.ts`, and
the default lives in `packages/shared` as `DEFAULT_AUTHOR_NOTE_DEPTH`. Covered by
`scripts/regressions/author-note-presets.regression.ts`, which runs in `pnpm regression:prompt`.

### Multiswipe: several alternatives per reroll, agents deferred until you pick

One regenerate can now produce up to 4 alternatives in a single request. Candidate 1 streams and
saves exactly like a stock reroll; candidates 2..N are generated sequentially and appended as
silent swipes (`chats.addSwipe(..., silent)`), so the active swipe and the message row never move
while the tail runs. The existing swipe chevrons then browse the spread.

Upstream declined the feature because multi-swipe "would work terribly with agents", which is
accurate for the obvious implementation: `AgentContext.mainResponse` is a single string anchored
to one `(messageId, swipeIndex)`, agents sharing a provider and model are batched into one call
built from `agents[0]`'s context, and post-processing side effects (Discord mirroring, lorebook
writes, chat metadata, music, illustrations) are not idempotent. Running them per candidate would
multiply those; running them once against an arbitrary candidate would attach wrong results.

So this fork defers instead. During a multiswipe request **no** parallel or post-processing agent
runs. Every candidate swipe carries a `multiSwipe` marker in its extra listing the agent types
that were skipped. Committing to a swipe clears **that swipe's** marker and replays exactly those
agents against it through the existing `POST /api/generate/retry-agents`, which already rebuilds
the full agent context from storage and anchors to the message's active swipe. Running agents that
never ran is an established path here: `manualTrackers` already strips tracker agents from the
pipeline for the same reason. Committing happens automatically inside `generate()` when the chat
moves forward (send, continue, or regenerating a different message), and on demand from the
"Agents pending" badge or the message's gesture menu. The marker is persisted, so a reload
mid-decision still finalizes.

Markers are per swipe, not per run. Alternatives the user did not commit to keep theirs
indefinitely, which is what keeps swipe semantics equal to stock: a swipe is either agent-coherent
or visibly pending. Clearing the whole run at the first commit would leave the other candidates as
text with no tracker, game, or expression state, so browsing to one and sending would advance the
story on that text while the injected agent context still described the committed candidate.
`setActiveSwipe` already mirrors a swipe's extra onto the message row, so browsing to an
un-agented candidate resurfaces its marker with no extra plumbing.

Agents run only at commit boundaries: sending or continuing from a swipe, or clicking the badge.
Navigating between swipes never triggers them, which keeps browsing a spread free of both dialogs
and surprise side effects. There is no staleness cutoff, because reaching a commit boundary is
deliberate at any age and `resolveRetryAgents` already drops agent types deactivated since the
defer; the marker's `createdAt` is recorded should one ever be wanted.

Sequential rather than a provider-side `n`: Anthropic, the Claude and Grok subscription
providers, and the local sidecar expose no multi-candidate parameter, and a single streamed
generator cannot be demultiplexed per candidate. Repeating one prompt is also the ideal
prompt-cache case. The run holds the chat's generation slot until every candidate is saved, which
falls out of ordering alone: the loop sits inside `generateForCharacter`, and
`assistant_message_ready` (which releases the roleplay composer, nulls the client abort
controller, and starts TTS) is only sent after that function returns.

Off by default. Settings > General > Input & Editing > "Multiswipe reroll options" sets the cap;
at `1` (Off) nothing changes anywhere. Above that, right-click (long-press on touch) the
regenerate button or the create-next-swipe chevron for the count menu. A plain click is always a
single swipe.

While the active swipe still holds a marker, an "Agents pending" pill sits beside the swipe
control and runs the deferred agents when clicked. It is suppressed while that message's own
spread is still generating, where the progress pill speaks for it instead. Like the existing
manual agent-retry buttons, it has no client-side double-fire guard: two fast clicks can start two
retry-agents runs, because `activeAgentRuns` tracks runs for aborting rather than rejecting
concurrent ones. Worth fixing server-side for every manual trigger at once, not just this one.

Deliberate scope limits: game mode and group individual mode force a count of 1, because
save-time map parsing and per-swipe game-state snapshots do not replay at finalize, and because
individual mode writes one message per speaker. Continue, impersonate, turn-game bot turns, and
tool-call generations are single-candidate for the same class of reason. Conversation commands,
`<ooc>` blocks, and spatial directives inside candidates 2..N are stripped and logged, never
executed, since finalize replays agents rather than commands. Per-candidate agent execution (the
opt-in "re-roll agents on every swipe" mode) is not implemented.

New files: `packages/shared/src/utils/multi-swipe.ts`,
`packages/server/src/routes/generate/multi-swipe-candidates.ts` (the candidate loop, the gating
guard, and a display-only sanitizer),
`packages/server/src/routes/generate/multi-swipe-finalize-route.ts`,
`packages/client/src/lib/multi-swipe-policy.ts`, `packages/client/src/hooks/use-multi-swipe.ts`,
`packages/client/src/stores/multi-swipe.store.ts`, and
`packages/client/src/components/chat/MultiSwipeRegenerateMenu.tsx`.

Patches to upstream files: `packages/server/src/routes/generate.routes.ts` (six modified lines,
listed below, plus four insertions: the import, the count guard, the hoisted `mainChatOptions`
declaration, and the candidate-loop call), `packages/server/src/routes/index.ts`,
`packages/shared/src/schemas/chat.schema.ts` (`candidateCount`),
`packages/shared/src/types/chat.ts` (`MessageExtra.multiSwipe`),
`packages/client/src/hooks/use-generate.ts`,
`packages/client/src/lib/message-cache-reconciliation.ts`,
`packages/client/src/stores/ui.store.ts` (no persist version bump: zustand merges persisted
state over the initial state, so stores written before the field fall back to the off default,
and `roleplay-streaming.regression.ts` pins the current `version:` line),
`packages/client/src/components/panels/SettingsPanel.tsx`, and the message chain
(`ChatArea.tsx`, `ChatMessage.tsx`, `SwipeJumpControl.tsx`, `ChatConversationSurface.tsx`,
`ChatRoleplaySurface.tsx`, `ConversationView.tsx`, `ConversationMessage.tsx`,
`ConversationMessageShared.tsx`, and the Bubble/Grouped/Line layouts).

The `generate.routes.ts` edits are deliberately small, because that file is 10k lines and
upstream rewrites it constantly. Re-check these after every sync:

- `holdForTextRewrite` gains `!isMultiSwipe`, which is what keeps every rewrite-hold behavior
  and the transient `postProcessingPending` payload consistent from one edit.
- The `provider.chat(initialProviderMessages, {...})` options literal is captured into
  `mainChatOptions` so candidates reuse candidate 1's exact options. The literal body is
  byte-identical; only the two frame lines changed, so upstream edits to option fields still
  merge cleanly. `mainChatOptions` is declared `null` above the tool-call branch and set only by
  the plain streaming path, which is why tool-call generations stay single-candidate.
- The parallel-agent gate, `hasPostProcessingAgents`, and the automatic roleplay summary each
  gain `!isMultiSwipe`. Note the gate is on `hasPostProcessingAgents`, not on `hasPostWork` or
  its `if`: `agent-activation.regression.ts` pins both of those by source shape, and with the
  three inputs already false the derived expression is false anyway. The summary guard sits
  outside the `hasPostWork` block and needs its own.

Covered by `scripts/regressions/multi-swipe-generate-route.regression.ts`, which drives the real
`POST /api/generate` against a mock OpenAI-compatible provider and asserts the whole wiring: three
sequential provider calls, two silent swipes behind an unmoved active swipe, markers on every
candidate, and `candidateCount: 1` producing byte-for-byte stock behavior with no multiswipe
events and no marker. Plus `multi-swipe-candidates.regression.ts` (silent appends against real
file-backed storage, per-candidate extra, abort mid-loop, partial and total failure),
`multi-swipe-gating.regression.ts` (the count matrix, the sanitizer, marker round-trips),
`multi-swipe-finalize.regression.ts` (the finalize route through a real Fastify app: committing a
browsed-to candidate leaves its siblings marked, a marked sibling never makes a committed swipe
look pending, browsing back to an unchosen candidate re-exposes and then commits its own agents,
and a committed swipe is not re-marked when the user switches away), and
`multi-swipe-client-state.regression.ts` (commit triggers, the explicit `multiSwipe: null` that
finalize writes reading as committed, and swipe-count cache merging). The browser wiring has its
own fork-owned spec, `e2e/multi-swipe.e2e.ts`, kept out of `core-flows.e2e.ts` so it never
conflicts on a sync: it asserts the count menu appears from the setting, that the chosen count
reaches the request, that appended silent swipes become visible on the swipe control, that a plain
click still rerolls exactly once while the menu is armed, and that the pending badge replays the
deferred agents against the message it sits on and then disappears.
Note the setting rides the existing server settings sync (`pickSyncedSettings`), so it outlives a
browser context; a spec cannot assume it is off just because that context never set it.

### Message action row wraps on narrow phones

`ChatMessage.tsx` renders the per-message action row (copy, edit, branch, delete, and the
conditional reasoning / stored-guidance / rewrite actions) as a bare `flex` of `shrink-0`
buttons with no wrapping. A full assistant row is 12 buttons, and the roleplay message body is
capped at `calc(100% - avatar space)`, so below roughly 375px the row overflows to the right and
the trailing buttons leave the viewport entirely. Measured at 390/375/360/344/320px: Delete is
unreachable from 360px down, and Branch from here joins it at 320px. User rows are unaffected,
being max-content sized and anchored right.

Both action rows in `ChatMessage.tsx` (the roleplay layout and the default layout) now carry
`max-w-full flex-wrap`, so the buttons wrap to a second line instead of overflowing. The
conversation surface uses `ConversationMessageActions`, an absolutely positioned pill that does
not overflow, and is unchanged.

Patches to upstream files: `packages/client/src/components/chat/ChatMessage.tsx` and
`e2e/core-flows.e2e.ts`. Covered by the mobile-only e2e spec `Message actions stay inside the
viewport on a narrow phone`, which fails without the patch with
`clipped=true offscreen=[Delete]`.

### Validation skill

`.claude/skills/marinara-validation/SKILL.md` records how to validate a change here: which lane
covers which kind of change, how to run the Playwright smoke suite so it completes, which e2e
specs already fail on a clean tree, and the traps that produce a green result that is wrong
(piping a run to `tail` reports the pipe's exit code, `pnpm smoke:ui -- --grep` silently runs the
whole suite under pnpm 11, `packages/shared/dist` is rebuilt from clean source by a stash
round-trip, CRLF-vs-LF on scripted edits, and the `localeCompare` sort the locale guard enforces).

Fork-only: upstream has no `.claude/` skills. Nothing here changes product behavior.

### Generated `AGENTS.md`

`AGENTS.md` is generated from `CLAUDE.md` plus `.github/agents/codex-overlay.md`, so a contributor rule written for one AI agent cannot silently go missing for the other. Regenerate with `pnpm agent-docs:sync`; `pnpm agent-docs:check` runs inside `pnpm check` and fails on drift.

### pnpm 11 configuration migration

Every dependency override moved from `package.json#pnpm` into `pnpm-workspace.yaml`, because pnpm 11 no longer reads that field and was silently dropping all 17 pins. Build-script permissions moved from `onlyBuiltDependencies` to the `allowBuilds` map. `protobufjs` resolves to `7.6.5` — the later of the two conflicting pins, matching the committed lockfile.

Upstream stays on pnpm 10.34.5 and still keeps its overrides in `package.json#pnpm`, so this is a
standing divergence rather than a one-time migration: `package.json` conflicts on most syncs, and
any override upstream adds to that field lands somewhere this fork no longer reads. After every
sync, diff `package.json#pnpm` between the merge base and `upstream/staging`. It was unchanged
across the 447 commits merged 2026-08-20, but a silently dropped pin is the failure mode.

### Regression lane registration

`pnpm regression:prompt` appends `scripts/regressions/author-note-presets.regression.ts` via the
runner's `--filter`. Upstream replaced the per-script `regression:*` aliases with
`scripts/run-regressions.mjs`, which discovers `scripts/regressions/**/*.regression.{ts,mjs,js}`
recursively on a 30-second-per-file budget, so plain `pnpm regression` picks the script up with no
registration at all; only the focused prompt lane needs the explicit filter.

`pnpm check` keeps both fork guards (`agent-docs:check`, `dev-ports:check`) ahead of upstream's
`format:check`. Patches `package.json`, which upstream edits constantly — re-check both after
every sync.

### Local dev environment

`.env` is untracked, so these settings are local rather than part of fork history. Recorded here because the dev loop depends on them.

- `PORT=7870` and `VITE_PORT=7871` stay clear of other local dev servers.
- `CORS_ORIGINS` includes the Vite origin, because the dev proxy rewrites `Host` but not `Origin`, so the server's same-origin shortcut does not apply.
- Node runs under nvm-windows, which symlinks the Program Files `nodejs` directory at the
  selected version.
  Active: 24.19.0, the LTS line CI uses (`.github/workflows/*.yml` set `node-version: 24`).
  `engines` wants `>=24 <27`; the repo's `.nvmrc` says `25`, which is an EOL line nvm no longer
  lists — treat `.nvmrc` as stale, not as the target.
  A fresh `nvm install` arrives with npm but no pnpm, so `pnpm` is `command not found` until
  `corepack enable pnpm` runs once per installed Node version. pnpm then resolves through
  corepack and honors `packageManager` in the root `package.json`, so the version is the repo's
  pin rather than whatever was installed globally. Set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` for
  non-interactive runs, or corepack's first-use prompt hangs the shell.
- `core.autocrlf=false` **and** `core.eol=lf`. Upstream added `format:check` to `pnpm check`
  (`chore/5181-prettier-check`); Prettier defaults to `endOfLine: "lf"`, so a CRLF working tree
  flags every file — 1297 of them, which reads as catastrophic and is purely line endings.
  Setting `core.autocrlf=false` alone is not enough: `core.eol` defaults to `native`, which is
  CRLF on Windows, and `.gitattributes` marks the repo `* text=auto`. Both settings are needed.
  `*.bat text eol=crlf` keeps the launchers CRLF regardless. Re-materialize an existing checkout
  with `git rm --cached -r .` then `git reset --hard` on a clean tree.
- `AUTO_OPEN_BROWSER=false` stops both the launchers and the Vite dev server from opening a tab. The Vite half only works because of the port-resolution patch above — upstream's `vite.config.ts` never reads the repo `.env`, so this setting would otherwise be ignored by `pnpm dev`.
