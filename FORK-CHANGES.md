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

### Multiswipe: several alternatives per turn, agents deferred until you pick

One turn can now produce up to 4 alternatives in a single request, whether it is a regenerate or
a message the user just sent. Candidate 1 streams and saves exactly like a stock turn; candidates
2..N are generated sequentially and appended as silent swipes (`chats.addSwipe(..., silent)`), so
the active swipe and the message row never move while the tail runs. The existing swipe chevrons
then browse the spread.

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

A new turn fans out onto the message it creates. `resolveMultiSwipeCount` originally returned 1
for anything without a `regenerateMessageId`, on the reasoning that a new turn has no message to
append swipes to. That was never true of the code: the non-regenerate save branch ends at
`chats.createMessage`, which always inserts swipe row 0, so the `savedMsg`/`savedSwipeIndex` pair
the tail needs already existed. Dropping that gate, and the matching one on the tail's own `if`,
is the core of the change; the only difference from a regenerate is that candidate 1 owns swipe 0
instead of sitting after a pre-existing original, so the tail starts at index 1 rather than 2. Without it, multiswipe was
unreachable until the chat already held an assistant message to reroll, which is exactly the
first turn where picking between openings is most useful.

Two fresh-turn side effects had to be suppressed, because a regenerate never reached them and
candidate 1 is provisional until the user picks:

- The Discord webhook mirror. Posting is irreversible and the user is being shown N options, so a
  fanned-out send posts nothing rather than publishing a candidate they may discard. Marked
  `ponytail:` in place: the upgrade path is posting the committed swipe from the finalize route,
  which would need the webhook config and an already-posted guard taught to it.
- The Professor Mari fetch follow-up, which re-runs the entire generation up to twice more. Since
  `isMultiSwipe` is computed per request, each follow-up would have fanned out too, turning one
  send into three spreads and up to twelve generations. Same treatment the automatic roleplay
  summary already had, for the same reason.

The repeated-Conversation-response discard is a knowing gap rather than a suppression: it guards
candidate 1 only, so a tail candidate on a new conversation turn may repeat an earlier reply. That
is a weak option in the spread, not corrupt state, and the user can pick another swipe.

Off by default. Settings > General > Input & Editing > "Multiswipe reroll options" sets the cap;
at `1` (Off) nothing changes anywhere. Above that, right-click (long-press on touch) the send
button, the regenerate button, or the create-next-swipe chevron for the count menu. A plain click
is always a single candidate.

The gesture itself is one hook. `useMultiSwipeCountMenu` owns the right-click, the long-press
timer, the suppressed follow-up click, and the menu, and knows nothing about what a count is used
for; `useMultiSwipeRegenerateMenu` and `useMultiSwipeSendMenu` are thin adapters over it. That
split is what let the send button reuse the gesture without touching the regenerate path, and it
is why the file is now `MultiSwipeMenu.tsx` rather than `MultiSwipeRegenerateMenu.tsx`. Which
counts a surface may offer moved to `multiSwipeCountOptions` in `multi-swipe-policy.ts`, shared by
both adapters and directly testable; it applies only the one exclusion visible from a chat alone
(game mode), leaving the request-level matrix to the server, which re-clamps regardless. Both
composers thread an optional `candidateCount` through their own `handleSend` into every branch
that actually generates, so the empty-input "generate the next reply" path fans out too; branches
that only create rows (manual response order, slash commands, the presence-delayed conversation
path) never do.

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
events and no marker, plus a new turn fanning out onto the message it just created (four provider
calls, swipes appended at 1..3 behind an unmoved active swipe 0, markers on all four) and an
ordinary send leaving no marker at all. Plus `multi-swipe-candidates.regression.ts` (silent appends against real
file-backed storage, per-candidate extra, abort mid-loop, partial and total failure),
`multi-swipe-gating.regression.ts` (the count matrix, the sanitizer, marker round-trips),
`multi-swipe-finalize.regression.ts` (the finalize route through a real Fastify app: committing a
browsed-to candidate leaves its siblings marked, a marked sibling never makes a committed swipe
look pending, browsing back to an unchosen candidate re-exposes and then commits its own agents,
and a committed swipe is not re-marked when the user switches away), and
`multi-swipe-client-state.regression.ts` (commit triggers, the explicit `multiSwipe: null` that
finalize writes reading as committed, swipe-count cache merging, and the count options each
surface offers including the game-mode exclusion). The browser wiring has its
own fork-owned spec, `e2e/multi-swipe.e2e.ts`, kept out of `core-flows.e2e.ts` so it never
conflicts on a sync: it asserts the count menu appears from the setting, that the chosen count
reaches the request, that appended silent swipes become visible on the swipe control, that a plain
click still rerolls exactly once while the menu is armed, that the pending badge replays the
deferred agents against the message it sits on and then disappears, and that right-clicking send
in a chat holding no assistant message at all sends the typed text with the chosen count and no
regenerate target. That last spec needs a connection on the chat, because `ChatInput.handleSend`
refuses to send without one, a guard the regenerate specs never meet since they call `generate()`
directly. Its `seedClient` also retires both first-run overlays through localStorage: the
onboarding tour and the What's New modal both cover the composer, and dismissing either by
clicking persists to the shared server and changes what sibling specs load into.
Note the setting rides the existing server settings sync (`pickSyncedSettings`), so it outlives a
browser context; a spec cannot assume it is off just because that context never set it.

### Tracker presets

Every character card carried its own `trackerCustomFieldDefaults` and `rpgStats.pools`, and there
was no way to give a whole library the same tracker layout short of editing each card. A new
global `tracker_presets` table now holds reusable layouts: character text fields, character stat
bars, persona text fields, and persona stat bars. `app_settings.activeTrackerPresetId` selects one
app-wide and `ChatMetadata.trackerPresetId` overrides it per chat.

A preset is a base layer, never a replacement. One chain runs identically for characters and the
persona: `preset -> card -> live tracker state`. `mergeTrackerNamedEntries` puts preset rows first
so every card lays out identically, and later layers win a collision, so card values beat preset
values and a value the chat already tracks beats both. Applying is therefore additive and
idempotent: pressing Apply twice, or mid-chat, never resets a tracked value.

The card layer is read inside the service rather than inherited from
`seedNewRoleplayChatTrackerDefaults`, which runs only at chat creation and character-add. Without
it the two halves diverged: Apply on an existing chat picked up persona card edits, because that
branch reads the persona row directly, but not character card edits. Cards are read only, never
written.

Preset stats deliberately ignore a card's `rpgStats.enabled` toggle, the one intentional break in
the symmetry, because that toggle defaults off and is untouched on most libraries; gating on it
would make preset stats a no-op exactly where they are wanted. A card's own stats still respect
it.

Seeding is the whole mechanism, not a convenience. `buildLoreBlock` in `agent-executor.ts` emits
`Configured RPG pools` and `Configured persona stat bars` but has no custom-field equivalent, so
the tracker agent learns a text field exists only by seeing it in current tracker state.

Persona cards gained tracker text fields, which had no card-level equivalent before: the tracker
rendered `PlayerStats.customTrackerFields` but they could only be added by hand, per chat. They
ride inside the existing `personaStats` JSON blob rather than a new `personas` column, because
every stage on that column already passes unknown keys through: `normalizePersonaStats` and its
siblings are spread-first, `personaStatsSchema` is `.passthrough()`, and `mari-db.service.ts`
already lists `personaStats` among its structured fields.

Application runs from `services/tracker/tracker-preset.service.ts`, kept out of `chats.routes.ts`
on purpose. That file is upstream-owned and actively edited, and `buildRoleplayTrackerDefaultCharacters`
was last touched by an upstream review commit, so the fork's only lines there are two calls to
`applyTrackerPresetToChat` plus the metadata read. The card-owned seeding pass is untouched and
still runs first; the preset layers under whatever it wrote.

`trackerPresetId` is deliberately not validated in the `PATCH /chats/:id/metadata` route, to add no
lines to that upstream-hot handler. `readChatTrackerPresetId` is the guard instead: anything that
is neither a non-empty string nor `null` degrades to "inherit the global selection", so a bad
value cannot disable presets for a chat.

New files only, apart from four small patches: `packages/shared/src/types/chat.ts`
(`ChatMetadata.trackerPresetId`), `packages/shared/src/types/persona.ts` (`PersonaStatsConfig.fields`),
`packages/shared/src/utils/custom-tracker-fields.ts` (`comparableTrackerName` extracted from the
existing dedup rule, plus `mergeTrackerNamedEntries`), `packages/server/src/routes/chats.routes.ts`,
`packages/server/src/db/file-backed-store.ts` (table registration only, no `STORAGE_VERSION` bump
since new tables are additive), `packages/client/src/components/panels/SettingsPanel.tsx` (one mount),
and `packages/client/src/components/personas/PersonaEditor.tsx`.

Covered by `scripts/regressions/tracker-presets.regression.ts`, which runs the routes and the
service against real storage and pins the additive merge, idempotent re-apply, chat override
versus global fallback, persona seeding, and the cleared pointer on delete.

**Adopt tracker rows automatically.** An app setting (`trackerAutoAdoptFields`) that removes the
preset from the loop entirely: at seed time the union of tracker rows across the 40 most recent
game-state snapshots, any chat, is folded in as an extra layer. Add a field once in any chat's
tracker panel and every later chat starts with it.

Adoption is a layer inside the existing pipeline rather than a second path: adopted rows are
appended behind whatever a selected preset already names, so an explicit preset keeps its layout
order and starting values, and with no preset selected the adopted rows stand alone. The chain
stays `preset -> adopted -> card -> live state`.

Worth knowing why this matters at all: the stock Character Tracker prompt (the `character-tracker`
capability package) ends with "Do not add, rename, or remove custom fields", so the agent never
creates a custom field, it only echoes existing ones. Rows enter tracker state because a person
added one in the panel or something seeded it. That is why seeding is the mechanism rather than a
convenience, and why adoption spreads hand-added rows rather than agent-invented ones unless the
user's custom prompt lifts that restriction.

**Build from this chat.** The preset editor can derive its rows from a chat's live tracker:
`GET /api/tracker-presets/from-chat/:chatId` reads the latest game-state snapshot and returns the
union of `presentCharacters[].customFields` keys, `presentCharacters[].stats` names,
`playerStats.customTrackerFields`, and `personaStats`, which is a 1:1 map onto a preset's four
lists. Deterministic rather than model-driven on purpose: the tracker agent's accumulated output
already names every field, and those names must match the tracker prompt exactly, so a generated
guess would be strictly worse than reading what is there. Field values are dropped and stat bars
reset to full, because mid-story play state is not a default for every future chat. The button
only appends rows the draft does not already name, so pressing it twice is a no-op and it never
rewrites a hand-tuned value. Pure read; the user still saves explicitly.

`tracker_presets` is registered in both table lists: `FILE_BACKED_TABLES` in
`db/file-backed-store.ts` and the hand-maintained `SHARDED_TABLES` copy in
`scripts/protect-launcher-data.mjs`, which `launcher/format-guard.regression.mjs` pins
`deepEqual`, order included. Adding this table is what surfaced that `author_note_presets` had
never been registered there, fixed separately; see that commit for why the omission loses data.
Every future table added to `FILE_BACKED_TABLES` needs the same entry at the same position.

### Nested tracker data from custom Character Tracker prompts

A custom Character Tracker prompt can define a schema richer than
`PresentCharacter`: clothing layers with heel type and height, body state, action traces. The
agent's output was already persisted verbatim into the game-state snapshot, but only
`customFields` and `stats` were ever read back, so everything else rendered nowhere and vanished
on any turn the agent omitted it. Confirmed against a live snapshot whose character carried six
prompt-defined top-level keys alongside an empty `customFields`.

`packages/shared/src/utils/tracker-extras.ts` makes those keys first class. Every key not in
`KNOWN_PRESENT_CHARACTER_KEYS` is an "extra", a JSON tree that is rendered, edited, locked, and
preserved on omission. A denylist rather than a required `extras` container, because prompts
already in use emit their schema at the top level of each character and a container would break
every one of them.

Three rules, each pinned by `scripts/regressions/tracker-extras.regression.ts`:

- **Preserve on omission**, matching `customFields`. A key the agent stops mentioning keeps its
  previous value. Arrays take their length from the agent, which is authoritative about list
  membership, but surviving elements merge by index so an element's unmentioned sub-keys persist.
- **Lock by dotted path**, reusing the existing lock-key scheme:
  `characters.id:nova.extra.clothing.footwear.0.heel_height_cm`. Locking a container freezes its
  subtree. The `extra` namespace segment keeps a prompt-defined key named `stats` clear of the
  real stat locks, and segments are URI-encoded so a dot inside a key cannot fracture the path.
- **Edit immutably**, cloning only the touched spine, with add and remove for array members. A new
  row copies the first element's shape with its leaves blanked rather than being an empty object
  the agent has to infer.

`CharacterTrackerExtras.tsx` renders the tree generically, driven by the data rather than by any
schema, since the shape belongs to the user's prompt. Numbers stay numbers on edit so a heel
height does not silently become a string.

Patches to upstream files, 39 added lines and no deletions across three:
`packages/shared/src/utils/tracker-field-locks.ts` (extras lock application inside
`mergeCharactersWithLocks`), `packages/server/src/routes/generate/generate-route-utils.ts`
(extras merge inside `preserveTrackerCharacterUiFields`, so both the post-turn and re-run paths
get it), and `CharacterTrackerCard.tsx` (one mount). `tracker-extras.ts` keeps its own copy of the
private `encodeSegment` from `tracker-field-locks.ts` rather than importing it: that module
imports this one, and closing the cycle risks a bundler TDZ failure. The regression pins the two
encodings equal.

Both upstream patches are verified by mutation: removing either the merge or the lock application
fails the lane.

Follow-up, after the first render landed and the tree proved unreadable against real prompt output:

- **Empty containers are skipped.** A prompt that re-emits the same always-present empty lists each
  turn painted one chevron over nothing per key. `isEmptyTrackerExtraContainer` hides them at render
  time only; the merge still carries the key forward.
- **Typography comes from the list wrapper**, matching `CHARACTER_CUSTOM_FIELD_LIST_CLASS`. The
  per-row `text-[0.5625rem]` resolved against the panel's reduced root size and landed near 6px,
  which read as blank space next to the card's own rows.
- **Rows stack under 176px** and split into label/value columns above it, on the container-query
  breakpoint the card already uses, so a long key is not truncated into a fixed fraction of a
  narrow card.
- **Default open state follows subtree size** via `countTrackerExtraLeaves` rather than depth, so a
  40-leaf `body` stays folded while `clothing` unfolds.
- **Array rows borrow their own descriptive field** (`item`/`name`/`title`/`label`/`type`) instead
  of rendering as a bare ordinal.
- **`FeaturedCharacterTrackerCard.tsx` gained the mount it was missing.** Only the compact card
  rendered extras, so a featured character showed none of the data the API returned. This is a
  fourth upstream file patched.

### Tracker panel width and density become independent

`trackerPanelSizeProfile` picked both the panel's pixel width and its type scale, so widening the
panel enlarged its text instead of showing more of it. That is also why a resize handle would have
been pointless: more width bought nothing.

Width and density are now separate persisted settings. `packages/client/src/lib/tracker-panel-size.ts`
is a new store-free module holding the whole model -- clamping, preset pairing, legacy migration --
so it is unit-testable (`ui.store.ts` touches `localStorage` at module load and cannot be imported
from a regression) and so the upstream-hot store shrinks to re-exports plus state.

- The three profiles survive as one-click presets that set both fields. `resolveTrackerPanelPreset`
  returns null once the user drags off a preset, so no button falsely claims to be active.
- Drag range is 240-640px, deliberately wider than the 280/340/420 presets.
  `resolveTrackerPanelDesktopWidth` still clamps to the gutter actually available.
- Persist migration v95 -> v96. The old `migrate` ended with an unconditional
  `delete persisted.trackerPanelWidth` from when upstream removed free width; leaving it would have
  wiped the new field on every rehydrate, so it is gone.

Pinned by `scripts/regressions/tracker-panel-size.regression.ts`, mutation-verified.

### One drag-resize primitive, and a resizable tracker panel

`AppShell.tsx` carried two near-identical inline resize implementations (~40 lines each) for the left
sidebar and the right panel, differing only in the clamp expression. The tracker had none. Rather
than add a third copy, `packages/client/src/hooks/use-panel-resize.ts` now owns it, with two upgrades
taken while extracting:

- **Pointer events instead of mouse events**, with `setPointerCapture`, so touch and stylus work.
  The old handlers listened for `mousemove`/`mouseup`, which never fire in the Android WebView wrapper.
- **The live width can be published as a CSS custom property instead of React state.** The old
  handlers called `setState` per `mousemove`, re-rendering the whole shell each frame. The tracker's
  subtree is far larger and would visibly stutter, so its handle uses the variable path and never
  re-renders during a drag; the sidebar and right panel keep their `onPreview` state for unchanged
  behaviour, now coalesced to one update per frame.

Keyboard handling and the `role="separator"` / `aria-valuenow` markup were already correct upstream
and are preserved, with arrow directions now derived from which edge the panel is anchored to.
Double-click resets to the nearest preset.

`resolveTrackerPanelGutterWidth` is split out of `resolveTrackerPanelDesktopWidth` so the drag can be
clamped to the room actually available beside the chat column; without it, dragging past the edge
would snap back on release.

`open-issues.regression.ts` asserted the old settings-sync projection carried `trackerPanelSizeProfile`.
That contract changed deliberately, so the assertion now pins width and density instead. That lane is
still red on the pre-existing upstream `ConnectionEditor.tsx` failure recorded in the
marinara-validation skill.

### SPA fallback no longer answers asset requests with the app shell

`@fastify/static` is registered with `wildcard: false`, so it enumerates `dist` at registration time.
Any file written afterwards -- a launcher auto-update, or a rebuild under a running server -- has no
route and lands on the not-found handler, which returned `index.html` for everything outside `/api/`.
A hashed chunk request therefore got `200 text/html`, and the browser reported
`Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html"`.
That reads as a broken app rather than a stale tab, and it defeats the client's own
`vite:preloadError` recovery in `lib/browser-runtime.ts`, which clears the service worker and reloads.

`isNonSpaRequest` in `config/client-static-config.ts` now excludes `/assets/` alongside `/api/`, so a
missing chunk 404s. Verified live: the running server returned 3024 bytes of `text/html` for
`/assets/index-JO7zOKHI.js` while that file existed on disk.

Pinned by `scripts/regressions/spa-fallback.regression.ts`. The predicate is a separate export so the
lane does not need to boot the whole app.

### Game-state characters are repaired at the boundary

`PresentCharacter` declares `characterId`, `name`, `emoji`, `mood`, `customFields` and `stats` as
non-nullable, but a snapshot is agent JSON: a custom tracker prompt omits whatever it never mentions,
and a character with no card of its own has no id. TypeScript then vouches for values that are not
there, so `strictNullChecks` gives no protection exactly where the data is least trustworthy. Two
crashes came from this in one session.

An audit of the stored snapshots found the live violations: 1 character of 128 with no `characterId`,
3 with no `emoji` or `mood`, and 3 with neither `stats` nor `customFields`. Every consumer of those
last five happened to be guarded; `characterId` was not.

Rather than keep guarding consumers, `packages/client/src/lib/game-state-normalize.ts` repairs the
character list inside `normalizeGameState`, the single store action all 37 writers funnel through.

Two constraints it must respect, both mutation-verified:

- **Unknown keys survive.** A custom prompt's nested output lives directly on the character and is
  read back by `readCharacterExtras`; rebuilding from known keys would delete it.
- **Untouched objects keep their identity**, so downstream memoization does not churn on every
  snapshot.

Nullable fields are deliberately left alone: their declared type already admits null, consumers
handle it, and rewriting `undefined` to `null` would risk overwriting on a write-back.

### Tracker sidebar crashed the app shell on a character with no card

`normalizeLookupCharacterIds` in the tracker sprite lookup trimmed every id it was handed. It is fed
`presentCharacters.map((c) => c.characterId)`, and `PresentCharacter.characterId` is typed string but
arrives as agent JSON -- a character with no card of its own carries none. One such character made the
sidebar throw inside a `useMemo`, which the app recovery boundary caught as
`Cannot read properties of undefined (reading 'trim')`, replacing the whole screen.

Reproduced from a real snapshot: one present character across 128 had no `characterId`, so that chat
crashed deterministically whenever its tracker was open.

The normalizer moved to `lib/sprite-expressions.ts`, which is React-free and already owns
`isSpriteLookupCharacterId`, so `scripts/regressions/tracker-sprite-lookup.regression.ts` can pin it.
Mutation-verified. Every other `characterId` trim in the feature was already optional-chained; this
was the only hole.

Same class as the featured card's `character.name.trim()`, fixed alongside it: fields the type system
calls `string` that are really untrusted model output.

### Detached tracker panel leaves the docked panel unresponsive

`AppShell.tsx` created one `trackerPanelHost` div for the lifetime of the shell and physically moved
it into the detached window's document (`TrackerPanelDetachedWindow` appends it to `popup.document.body`).

React attaches its delegated event listeners to a portal container once, in `preparePortalMount`, and
marks the node so it never attaches again. Closing the movable window tears down that document and
drops the listeners with it. The node was then moved back into the main document, so the panel
rendered normally and CSS `:active` still fired on its buttons, but no handler ran: React had a live
tree pointed at a container nothing was listening on.

Reproduced by closing the movable window directly rather than using the Dock button. The Dock button
path happens to survive because it closes the popup from the opener, so nothing else changes.

Fix: mint a fresh host node when a detach session ends. A new container makes React unmount the old
portal and run `preparePortalMount` again on a node in the live document. Patch is
`createTrackerPanelHost()` plus one effect keyed on the detached flag, in `AppShell.tsx` -- an
upstream file this fork already patches elsewhere.

Not covered by a regression: the failure needs a real second browsing context, which the smoke suite
does not drive.

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
