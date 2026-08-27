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

### Shared message action button carries gesture handlers

`packages/client/src/components/chat/MessageActionButton.tsx` accepts a `triggerProps` prop and
spreads it on the button ahead of `onClick`.

Upstream introduced that component in "feat: unify chat controls and reasoning presentation" and
routed `ChatMessage`'s `ActionBtn` through it. The fork's multi-swipe regenerate menu passes
right-click and long-press handlers down that path, and the shared component had nowhere to put
them, so adopting it unchanged would have dropped the menu silently. Keeping the fork's raw
`<button>` instead was the alternative, at the cost of drifting from upstream's chrome.

The spread must stay above `onClick` so the explicit click handler wins.

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

### Thoughts read at the size of the fields beside them, and stop being cut off

Thought text sized itself fluidly against its own container with `cqw`, and picked the step from the
text's length: `getThoughtTextFit` returned a bigger font for a short thought than a long one. So a
bubble never matched the mood, appearance and outfit rows around it, and two thoughts on different
characters did not match each other.

All four detail values now share `TRACKER_DETAIL_TEXT_CLASS`, keyed on the card's own container
rather than on text length or the panel-width preset. Measured on the compact card: outfit and
thoughts both 13.81px, previously 13.81 against a length-dependent value.

Both bubbles also capped their height and hid the overflow, so a long thought was simply cut:
`max-h-[2.95rem]` on the compact one, `max-h-[3.25rem]` on the floating one. Both caps are gone. The
floating bubble keeps a ceiling, but as `max-h-[min(22rem,calc(100vh-2rem))]` with `overflow-y-auto`,
so it stays on screen and scrolls rather than truncating.

Line budget follows the card, matching what the fields already do: the compact bubble clamps with
`TRACKER_DETAIL_VALUE_CLAMP_CLASS` because two cards share a grid row and one long thought would make
its neighbour tall too; the featured bubbles are unclamped, because that card owns its width.

`FEATURED_FIELD_TEXT_CLASS_BY_PROFILE` is deleted with the rest of it, which removes the last of the
featured card's type sizing keyed off `TrackerPanelSizeProfile`.

### Placeholder tracker rows can be filtered out

A tracker prompt emits a fixed schema, so a field that does not apply comes back as a placeholder
rather than absent. Footwear on a barefoot character is six rows of `-`, `brak` and `0` that say
nothing, and a wide schema fills the card with them.

`trackerBlankValues` is a user-editable list of values that read as "nothing here". The list is the
user's rather than a shipped one on purpose: placeholder conventions live in their prompt and follow
its language, and no built-in set covers `brak`. Defaults are the language-neutral placeholders (a
hyphen, a double hyphen, an em dash, `n/a`, `none`, `null`); an empty or whitespace-only value is
always blank with no configuring.

Matching is whole-value after trim and lowercase, never substring, so `brak` does not also hide
`brakuje`. Numbers match only when listed, so a real `0` on a heel height or a charge count survives
the defaults and collapses only once the user adds `0` themselves.

Blankness cascades: a container whose every descendant is blank is itself blank. That is what turns
the six-row footwear group into nothing rather than into six empty rows, and it reuses the renderer's
existing "no visible children" path rather than adding a parallel one.

**Edit mode reveals them.** Without that a placeholder could never be typed over, which would make
the filter a trap. It composes with the read-only edit mode from the previous entry.

Scope is extras and custom fields, the prompt-authored surfaces where placeholders happen. Stat bars
are left alone: they are gauges rather than rows, and `0` is meaningful there.

The setting lives in the UI store, not server app settings: nothing about the stored data changes, so
it is a display preference and rides the existing settings sync. Its editor sits beside the
auto-adopt toggle in Tracker preset settings.

One consequence worth knowing: a newly added custom field has an empty value, so it disappears when
edit mode is switched off until something is typed into it.

`scripts/regressions/tracker-blank-values.regression.ts` covers the predicates directly, including
the footwear case both with and without `0` in the list, plus that edit mode reveals blank rows and
that the lookup Set stays memoized, since it is passed down the extras tree past a memo boundary.
Verified in a browser: a custom field with an empty value renders in edit mode and not outside.

### Tracker rows are read-only until edit mode

Every tracker value used to be editable all the time, while "add mode" gated only the `+ Add row`
affordances. The mode therefore guarded the harmless action and left the destructive one -- typing
over a value -- permanently live, and the add rows appeared whether or not the mode was on.

`TrackerEditMode` drops `add` for `edit`, which turns on inline editing and reveals the add rows
together. `delete` stays its own mode so a row cannot be removed by mistake while editing. The
toolbar button keeps its position and becomes a pencil.

The gate rides `TrackerLockContext`, which every tracker surface already consumes, rather than a new
prop through the twenty call sites that pass `lockMode` by hand. `InlineEdit` and `InlineNumber` read
it themselves.

One subtlety worth keeping: both check `editMode === false`, never `!editMode`. Both controls are also
used by `RoleplayHUDPanels`, which sits outside `TrackerLockProvider` and so reads `undefined` --
under a truthiness check that would silently make the HUD read-only. The regression lane pins the
explicit comparison, and pins that the lock toggle is still checked before the read-only gate so lock
mode keeps working.

Verified in a browser: inside edit mode, one add row and one live input; outside, zero of each.

The four retired `...AddMode` catalog keys are removed from `en.json`, `ko.json` and `zh-Hans.json` --
a locale carrying a key `en.json` lacks fails `check-locales` as an unknown key.

The nested-extras `+ Add row` was the one add control the mode did not govern: it was gated on the
node being an array and nothing else, so it showed in every mode and had done since extras shipped.
`CharacterTrackerExtras` never received `addMode`. It does now, through the shared section tail, so
one gate covers both card layouts. An audit of the other six `AddRowButton` sites and the quest
objective button found them already gated; the regression lane pins all of them.

Still to do: hide and lock remain their own toggles. Folding them into edit mode as per-row buttons
needs hidden-field keys for the world, persona, quest and inventory surfaces, which only have lock
keys today.

### Featured card fields size to their own content

The previous entry stopped the compact card truncating, but the featured card kept cutting off, for
two reasons that only its layout had.

**Every field was forced to the same height.** `FeaturedFieldList` set
`gridTemplateRows: repeat(N, minmax(0, 1fr))` as an inline style, so an empty mood tile stood as tall
as a nine-line appearance and the details column ran three times longer than its content. Measured:
mood 146.5px against 17px of actual content. Being an inline style, it beat every class, which is why
`align-content`, `grid-auto-rows` and a definite minimum all failed to move it. Rows are `auto` now
and pack with `content-start` -- mood drops to 27.5px and the long fields keep their full height.

**The details column was capped at the portrait height.** `h-[9rem] max-h-[9rem]` plus
`overflow-hidden` down the chain, with `items-center` on the tiles, so a long value was sliced at the
top *and* the bottom rather than merely truncated. The column now has no fixed height, the tiles are
top-aligned, and the card's own grid row keeps it at least as tall as the portrait.

**No clamp on featured values.** The compact card keeps `TRACKER_DETAIL_VALUE_CLAMP_CLASS` because two
cards share a grid row, so one long field makes its neighbour tall too. The featured card owns its
width, so it shows the value in full.

`TRACKER_PROFILE_PORTRAIT_FRAME_STAGE_MIN_CLASS` is added beside the existing `_MAX_` constant;
`PersonaInventoryPanel` still uses the max form, so its portrait stage is unchanged.

Verified in a browser with a long Polish appearance and outfit: the details column grows from 179px
to fit, neither field clips, and the empty mood tile no longer inflates. The regression lane pins that
the featured list has no `gridTemplateRows` and that only the compact card clamps.

### Detail fields flex, and the persona resolves a tracker portrait

Two changes that make a single unified Character Tracker prompt -- one that lists the user's persona
as a present character -- work as well as it should.

**Mood, appearance and outfit truncated to one line.** `CompactCharacterField` gated wrapping on a
`readable` prop wired to `hasDenseContent` (`stats.length > 0 || customFields.length > 0 || addMode`),
so a detail value only wrapped when the card *also* carried stats or custom fields. That is backwards:
the sparse card is the one with room to spare. Anything longer than a word or two was cut off with no
way to read it in place, and a fixed `h-3.5` / `h-4` on the value would have clipped a wrap anyway.

Detail values now always wrap, from a min-height rather than a fixed one, with the line budget in one
shared `TRACKER_DETAIL_VALUE_CLAMP_CLASS`. The budget follows the *card's* container width, not the
panel-width preset -- `FeaturedCharacterFields` still keyed its 2-or-3 line count off
`TrackerPanelSizeProfile`, which is the width/density coupling the size split removed.

Measured in a browser: the value box goes from a fixed 15px to 93px on a long outfit, `white-space`
from `nowrap` to `normal`, `text-overflow` from `ellipsis` to `clip`. Compact cards sit two to a grid
row, so a 420px panel gives each card roughly 200px and lands it on the middle (6-line) tier; the
8-line tier is for single-column and featured cards. Six lines is about 180 characters of outfit.

Still bounded rather than unbounded, deliberately: compact cards share a grid row, so one verbose
field would make its neighbour tall too. Raising `TRACKER_DETAIL_VALUE_CLAMP_CLASS`, or dropping the
clamp from it entirely, is a one-line change if a prompt legitimately needs more.

**The persona had no tracker portrait.** Avatar enrichment in `generate.routes.ts` walks chat
character cards, then a fuzzy library match, then stored NPC avatars. A persona is none of those, so
a persona tracked as a present character fell back to the initial placeholder. It is now matched by
normalized name -- the tracker agent emits names -- and slots between the chat card and the fuzzy
library match: a card in this chat stays more specific than the persona, but the persona beats a
fuzzy hit on a similarly named library character. `avatarCrop` follows the same order.

This was the one practical obstacle to folding the persona into the Character Tracker prompt instead
of building persona/character parity in code. Seeding already covers both sides
(`collectAdoptedTrackerRows` gathers `personaFields` and `personaStats`), but the persona path has no
row-level preserve-on-omission and no nested extras -- tracking the persona as a character sidesteps
both rather than duplicating them.

`scripts/regressions/tracker-field-flex.regression.ts` pins the clamp's three rising tiers, that
neither card truncates a detail value or reintroduces a fixed row height, and the position of the
persona avatar lookup in the chain. Verified non-vacuous by restoring `truncate`.

`generate.routes.ts` and both card files are upstream-edited.

### One changed character no longer re-renders every card

Measured with the repo's own `mari-perf` diagnostic, six characters present, adding a seventh:

| | Cards that re-rendered | Card renders |
| --- | --- | --- |
| Before | 7 of 7 | 8 |
| After | 1 of 7 | 2 |

The six untouched cards were re-rendering their whole subtree -- portrait, stats, custom fields and
the recursive extras tree -- on a patch that changed none of them. The waste scales with the cast,
and issue #3104 is a freeze report from chats running the tracker agents.

Four independent causes, all of which had to go together. Any one left in place restores the full
fan-out, and none of them fails visibly:

1. **The card map built four closures per card per render.** `onUpdate`, `onRemove`,
   `onToggleFeatured` and `onUploadAvatar` were fresh identities every time, so a `React.memo` on the
   card would have compared them, found them different, and re-rendered anyway. `useCallback` is not
   available in a `.map`, so the index moved into memoized `CompactCharacterCardSlot` /
   `FeaturedCharacterCardSlot` components that build their own callbacks from index-taking parents.
2. **The lock context churned every render.** `normalizeTrackerFieldLocks` allocates on every call
   and `TrackerDataSidebar` called it unconditionally, so `TrackerLockProvider`'s memoized value
   changed identity every render. Context updates bypass `React.memo` entirely, so this alone would
   have made the memo boundaries measure as zero improvement. `useStableRecord` now holds both lock
   records at their previous reference while their content is unchanged.
3. **`StatIconLookup` was rebuilt every render.** It returned a bare object literal, and it is a prop
   on every card. It is an API over moving state rather than a derived value, so it is now memoized
   with no dependencies and resolves against a single `latest` ref at call time.
4. **The character mutations closed over the rendered snapshot.** `updateCharacter`,
   `removeCharacter` and the featured-card toggles listed `presentCharacters` (or a `Set` rebuilt
   from chat metadata) in their dependencies, so every patch changed their identity. They read those
   through refs now. That is equivalent rather than approximate: a card that did not re-render holds
   the same character object the ref does, because a changed object would have re-rendered it.

The memo boundary is the slot, not the card. Same effect, and it keeps the change out of
`CharacterTrackerCard.tsx` and `FeaturedCharacterTrackerCard.tsx`, which upstream edits often.

`contain-intrinsic-size` moves from `10rem` to `auto 10rem`. The bare value is a fixed guess for a
card whose height varies with its stats, custom fields and extras, so off-screen cards reserved the
wrong space and the list jumped as they scrolled in. `auto` reuses each card's last rendered height
and keeps the `content-visibility` saving.

Both cards keep a permanent `useRenderTimer` under the existing `// [#3104 diagnostic]` convention.
To re-measure: `localStorage.mariPerfVerbose = "1"`, reload, and watch the `[mari-perf]
tracker-card:<n>` lines while a tracker turn streams. It is inert unless that key is set.

`shallowRecordEqual` moves to `lib/shallow-record-equal.ts`; `use-tracker-mutations.ts` had its own
copy and `useStableRecord` needed the same thing.

`scripts/regressions/tracker-render-cost.regression.ts` pins all four causes plus the containment
placeholder, and covers `shallowRecordEqual` directly. Verified non-vacuous by removing a memo
boundary, which fails the lane.

The prop-drilling-to-selectors item from the plan was dropped. The props `TrackerSectionList` passes
are mostly stable store values already; the churn came from the four causes above, so converting
them would have carried a large merge cost against upstream-edited files for no measured gain.

Three stale assertions from earlier fork phases were fixed in the same pass, each a real failure this
work surfaced rather than caused:

- `roleplay-streaming.regression.ts` pinned `version: 95` in `ui.store.ts`; three tracker migrations
  have since taken it to 98.
- `open-issues.regression.ts` expected a migrated `trackerPanelTextSize` of `s`; the default became
  `l` when the size steps widened.
- The `desktop Tracker scales into either Roleplay gutter` e2e spec seeded `trackerPanelSizeProfile`,
  which is no longer persisted, and asserted a font size that predates the independent Text size
  axis. It now seeds `trackerPanelWidth` plus `trackerPanelPlacement: "scale"` -- the mode it
  actually covers -- and reads `--tracker-text-scale` instead of hardcoding it.

Every file except the three new ones is upstream-edited, so a merge can revert these call sites. The
memo boundaries and the ref reads are the parts that fail silently if lost, which is what the
regression lane is for.

### Character cards share one section tail and one set of mutations

`CharacterTrackerCard.tsx` and `FeaturedCharacterTrackerCard.tsx` each carried their own copy of
`updateCustomField`, `addCustomField`, `removeCustomField` and `addCharacterStat`. The copies had
already drifted: the compact `removeCustomField` typed its working object `Record<string, unknown>`
while the featured one cast at the `onUpdate` call, and the featured card kept a thoughts-only
specialisation of the compact card's generic hidden-field toggle.

That duplication had already shipped a bug. `CharacterTrackerExtras` was mounted in the compact card
only, so a featured card rendered none of the nested data the tracker agent had already stored.

Two new files own what was duplicated:

- `hooks/use-character-card-mutations.ts` -- the four handlers, the extras write, and the
  hidden-field toggle. Lock and hidden-field updaters come from `TrackerLockContext` rather than
  arguments, since both cards already consume that context.
- `components/character-card/CharacterCardSections.tsx` -- custom fields then nested extras, the two
  sections that trail the card body in both layouts. A third trailing section can now only be added
  once. Per-variant chrome sits in three `Record<CharacterCardVariant, ...>` tables in that file, so
  the compact and featured styling are read side by side.

Stats deliberately stay out of the shared tail. The featured card places its `StatList` inside the
portrait grid rather than after the body, so sharing it would mean parameterising layout, not
sharing it.

Two behaviour changes fall out of unifying:

- Featured custom-field values now honour the readable density (`twoLinePreview` at expanded width)
  instead of always scrolling one line on hover. The featured card's own extras already used that
  expression; its custom fields had simply never been given it.
- Hiding a field is now cleared through a per-field function rather than a value lookup. `mood` is
  `string` while `appearance`, `outfit` and `thoughts` are `string | null`, and a computed-key spread
  (`{ ...character, [field]: value }`) widens, so the compiler would not have caught `mood: null`.
  Each literal key is checked.

Net line count is roughly flat -- 342 lines leave the two cards, 331 arrive in the two shared files.
The win is that each behaviour exists once, not that there is less code.

`scripts/regressions/character-card-sections.regression.ts` pins the de-duplication: both cards mount
the shared tail, neither mounts `CharacterTrackerExtras` or renders field rows itself, neither
re-declares a handler, and the per-field clearers keep their types. Verified non-vacuous by
reintroducing the original bug, which fails the lane on the extras assertion.

Both card files are upstream-edited, so a merge can revert the call sites. The two new files are
fork-only and cannot collide.

### Clearing trackers now actually clears them, plus a global reset

"Clear trackers" wrote an empty snapshot and stopped there, which does not retire anything: every
tracker run merges its output over `characterTrackerHistory`, built from `getRecent(chatId, 100)`, so
a field the prompt stops emitting is restored from history on the very next turn. The button looked
like it worked and did not.

- **Per chat.** The menu action now deletes the chat's snapshots via `DELETE /chats/:id/game-state`
  before writing the cleared state, behind a destructive confirm. Messages are untouched.
- **Globally.** Settings gains "Reset all tracker data", which posts the existing admin expunge with a
  new narrow `trackers` scope. The `chats` scope already dropped `game_state_snapshots`, but it takes
  every message and chat with it, which is not what retiring a tracker schema needs.

The use case is switching a tracker prompt to another language: without a purge the old field names
survive forever through the merge, so the panel ends up bilingual.

Pinned by `scripts/regressions/tracker-data-reset.regression.ts`, mutation-verified that the per-chat
purge stays scoped to its chat.

Note for anyone writing a regression here: `createFileNativeDB()` takes test hooks, not a path. It
reads `FILE_STORAGE_DIR`, so a directory passed as its argument is silently ignored and the real
install is opened instead. The writer lease refused that here, but only because a server was running.

### Thought bubbles follow the text-size control

Thought text is sized fluidly against its own container with `cqw`, as six hardcoded `clamp()` values
in inline styles rather than Tailwind classes, so the token migration did not reach it. It stayed at a
fixed size at every step of the Text size control, and at XL it rendered *smaller* than the rows
around it: 14.9px against 15.9px.

Each clamp is now multiplied by the same two scales the tokens use, which keeps the fluid
container-query behaviour and restores the ~1.4x ratio the bubble was designed to have against a row.
Measured across the control: 13.8 / 16.4 / 19.3 / 22.3px against rows of 9.8 / 11.7 / 13.8 / 15.9px,
where before it was 14.9px at all four.

`WorldEditableTile` also sizes itself in JS, but reads the inherited computed size, so it already
followed the tokens.

### Tracker panel reflows instead of shrinking its text

The panel adapted to a narrow gutter by scaling type down, floored at 0.65. Measured on a 1600px
viewport that produced 6.2px labels; at 1500px the gutter is 89px and nothing readable fits at any
size. It also made the resize handle pointless, because more width bought bigger glyphs rather than
more content.

Three changes, chosen from an interactive width explorer built for the decision:

- **Reflow.** `lib/tracker-row-layout.ts` holds one label/value grid shared by the compact card, the
  featured card, and the nested extras tree: stacked below 176px, tight two-column to 259px, roomy at
  260px+. Narrowing now costs columns, not legibility.
- **Overlay.** Below a 176px gutter the panel stops docking and floats over the chat column at its own
  width. 176px is also the stacked/two-column breakpoint, which is the point: it is the width at which
  a label and a value stop sharing a line.
- **Text size**, a four-step S/M/L/XL control in the panel header beside the width control, default L.
  Spacing and line clamps ride along, so one control moves the whole card. There is deliberately no XS:
  it would land near 7.6px labels, the state this work exists to fix.

  Both ends of the scale are anchored to measured numbers rather than picked by feel. The panel's row
  token is `0.625rem` and the app's default root is 17px, so S (0.925) lands at 9.8px. XL is 1.5, which
  puts row text at 15.9px, level with the 16px chat body (`chatFontSize` default) -- XL previously
  stopped at 13.3px and read as smaller than the prose beside it. The middle steps are geometric, so
  every press is the same proportional jump.

The nine-rule font-size allowlist in `globals.css` is gone. It matched literal Tailwind class strings
such as `[class~="text-[0.5625rem]"]`, so it silently missed any size not listed -- `0.4375rem`,
`0.5rem` and `0.875rem` were all in use and none of them scaled. Type now comes from one token per
size on the panel root, each multiplied by both the user's text scale and the legacy width scale:

    --tracker-fs-0-5625: calc(0.5625rem * var(--tracker-text-scale) * var(--tracker-panel-font-scale))

88 occurrences across 25 files moved onto those tokens. `rem` rather than `em` on purpose: the extras
tree nests arbitrarily deep and `em` would compound at every level.

Placement is a three-way setting, since the question turned out to be where the panel sits rather than
only what happens when it does not fit:

| Value | Behaviour |
| --- | --- |
| `dock` (default) | Beside the chat, reflowing as it narrows; floats only below a 176px gutter. |
| `float` | Always over the chat column at its own width, whatever the gutter. |
| `scale` | Always docked, shrinking type to fit. The pre-reflow behaviour, kept as an opt-out, and the only value that lets `--tracker-panel-font-scale` differ from 1. |

Measured in a browser at a 249px gutter, with the settings-sync fetch blocked so local state was
authoritative: `dock` renders 249px with no overlap and scale 1.0, `float` renders 340px overlapping
the chat by 83px at scale 1.0, and `scale` renders 249px at scale 0.7324 (249/340). A drag under
`float` is bounded by the main area rather than the gutter.

Verified in a browser: at 1500px, where the gutter is 89px, the panel now renders at 340px with
11.7px labels and two-column rows instead of an 89px sliver at 5.9px.

Persist migration v96 -> v97 folds the short-lived density setting into the text scale
(compact/standard/comfortable -> S/M/L). Width presets set width only now; pairing them with a text
size would re-conflate the axes this work separated.

### Sync with upstream, 2026-08-26

146 upstream commits, merge base `c276876dd`. 274 upstream-changed files, 44 overlapping fork
changes, 7 conflicts. Version and storage format were already equal on both sides (2.4.4, format 5),
and upstream touched neither `AGENTS.md` nor `CLAUDE.md`, so the two usual silent reverts did not
arise. `package.json#pnpm` gained nothing upstream, so `pnpm-workspace.yaml` needed no mirroring.

Resolutions worth remembering:

- **`ui.store.ts` persist version.** Both sides independently used 96: upstream for inline Roleplay
  reasoning prefs and per-mode chat help, the fork for the tracker width/density split. The sync
  lands on 99 so every store migrates. Upstream's `chatHelpSeenModes` seeding was widened from
  `version <= 95` to `<= 98`, because fork stores sit at 96-98 while the `delete
  persisted.gameTutorialDisabled` below it is unconditional: without widening, those stores lose the
  signal without gaining the replacement and re-show help the user had dismissed.
- **`ChatMessage.tsx`.** The fork's `dark` prop on `ActionBtn` is retired, not reverted. Upstream's
  new `--marinara-chat-message-action-*` tokens are `40% / 70% / 10%` of the chrome text, which is
  exactly what `dark` selected, so the prop had no branch left. `triggerProps` survives through the
  shared button, see above.
- **`ChatRoleplayPanels.tsx`.** Author's-note depth field: the fork's `patchDraft` /
  `parseAuthorNoteDepth` handlers with upstream's `mari-chrome-field` classes. Upstream's side
  restored save-on-blur, which would have silently reverted the presets' explicit-save model.
- **`PersonaInventoryRow.tsx`** was deleted upstream in "unify tracker and settings controls"; the
  deletion is accepted and the fork's two now-unused class constants in `PersonaInventoryPanel.tsx`
  went with it.
- **`use-generate.ts`** auto-merged with a duplicate `import { translate }`, caught by `tsc` rather
  than by a conflict marker. Both sides added the same import at different anchors.

`tracker-edit-mode.regression.ts` was the one lane the merge broke, and it broke correctly:
`PersonaInventoryPanel` no longer renders its own `AddRowButton`, it hands `addMode` to `StatList`.
The lane now accepts either shape and asserts `StatList`'s own two gates, so delegation is only
allowed because the delegate is checked.

Nine further regression failures during validation were the writer lease, not the merge: a running
Marinara process held `packages/server/data/storage`. `launcher/update.regression.mjs` fails by fork
design, as `.claude/skills/marinara-validation/SKILL.md` records.

Left for later: upstream's new capability-package tracker CSS
(`.mari-tracker-capability-section .mn-tracker-title` and friends) scales font size and line height
by `--tracker-panel-font-scale` only, never `--tracker-text-scale`, so those titles ignore the S/M/L/XL
setting entirely. Same confusion as the line-box bug below, different symptom, and outside the reach
of `tracker-line-height-scale.regression.ts`, which only scans tracker-panel sources.

### TTS has a provider layer instead of five parallel ternary chains

All TTS synthesis lived inline in `tts.routes.ts`, where choosing a backend meant five nested
ternary chains, one each for URL, headers, body, text preparation, and whether to send a speed
parameter. They were separated by dozens of lines and had to be edited in lockstep, so adding a
backend meant finding all five. LLM, image, and video generation all have a `services/` layer;
TTS had none.

`packages/server/src/services/tts/` now holds `BaseTTSProvider`, one file per backend, and a
`createTTSProvider` switch shaped like `createLLMProvider`. It is deliberately not a plugin
registry: four backends do not need a registration mechanism, and the switch is the thing a reader
can follow.

Providers build a request descriptor and perform no I/O. The route makes the single outbound call,
so the deadline, the abort chain, the URL policy, and the response cap cannot drift apart per
backend, and request shapes can be asserted without a live server. The whole registry regression is
plain function calls: no mock servers, no ports, no timers.

Two behaviours were nearly lost in the move and are now pinned by name. A NanoGPT base URL wins over
the configured source, so an ElevenLabs source pointed at nano-gpt.com sends NanoGPT-shaped
requests; dispatching on `cfg.source` alone would have broken those setups silently. And format
forcing keys on the configured source rather than the dispatched provider, so a saved WAV preference
never leaks into an ElevenLabs or xAI request. Per-model behaviour (ElevenLabs speed support, OpenAI
speech instructions, NanoGPT's ElevenLabs-branded models) stays in the providers, which is why the
shared source table carries none of it.

Voice and model listing stay in `tts.routes.ts`. Their fetchers are pinned by upstream regressions
that call them directly against live mock servers and read env flags at call time, and moving
working code purely for symmetry would risk that for no gain.

Every symbol the upstream regression imports is re-exported from `tts.routes.ts`, and every fragment
it asserts against by source text (the PocketTTS probe body, the config-save cache invalidation
pair, the extractor debug line) stays physically in place. That is what let roughly 24 helpers and
the entire dispatch move without editing an upstream-owned test.

Patches to upstream files: `packages/server/src/routes/tts.routes.ts` only; everything else is new.
Proven by `scripts/regressions/tts/tts-provider-registry.regression.ts`.

### Chunk size, timeout, retries, and parallelism are settings

The tuning fields existed in the schema but nothing reachable set them. `TTSConfigCard` gains an
"Advanced synthesis" section, collapsed by default because the defaults suit hosted APIs and local
engines are the reason it exists. Every control is a bounded slider saved into the active source
profile, so a local engine's 300s timeout does not follow the user to ElevenLabs.

The chunk-size control is clamped to the source's `maxInputChars` as well as its own range, so a
legal setting can never become a 400 from `/speak`. It warns when WAV output is paired with chunks
long enough to breach the 20 MB response cap, and the parallel-requests control warns that a queued
request still spends its timeout while it waits, which is how a serial local engine starts reporting
timeouts that vanish at 1.

`splitTTSChunks` takes the limit as an argument instead of reading a module constant; the
newline-to-sentence-to-clause-to-word cascade is unchanged.

`cleanTTSInputText` now strips emoji. Engines either read them aloud by name or choke on them, and
bracketed emotion cues (which some providers do steer on) are protected separately by
`preserveEmotionIndicators`. Keycap sequences lose only their enclosing mark, so "press 1" survives
as speech. A message that is nothing but emoji now produces no requests at all, which leaves the
speak button correctly disabled instead of sending junk to the engine.

Progressive playback splits the opening chunk at the last sentence end within 220 characters, so
audio starts while the rest of the message is still rendering. It runs before the dialogue-pause
pass, which keys on the last chunk of an utterance and would otherwise attach the pause to the wrong
request. In prefetch-all mode it is skipped: there it would be one more request for no earlier sound.

Autoplay stops trying after three consecutive failed sequences and says so once, rather than turning
every generated message into minutes of silent loading against a dead engine. Any clip that actually
plays clears the count, and the manual speak button always tries.

Patches to upstream files: `packages/client/src/lib/tts-dialogue.ts`,
`packages/client/src/components/panels/settings/TTSConfigCard.tsx`,
`packages/client/src/components/chat/ChatMessage.tsx`,
`packages/client/src/components/chat/ChatArea.tsx`, and the English catalog. All are upstream-edited.

### The TTS engine retries, deadlines, and reports what went wrong

The chat playback engine had no retries: one transient 502 ended the whole sequence, while the game
engine has shipped two attempts with a 350ms linear backoff for months. It also had no deadline of
its own, so an engine that accepted the connection and never answered left the button spinning until
the server gave up. Failures reached the user as a silently flipped button state and a
`console.warn`; the settings card was the only surface that showed a reason.

`packages/client/src/lib/tts-synthesis-policy.ts` is new and holds the timeout, the retry loop, and
the failure classifier, so it can be exercised without the playback singleton and the engine's diff
against upstream stays small. Retries cover timeouts, unreachable hosts, and 5xx; never 4xx, which
would repeat identically, and never a caller abort. The classifier reads the `code` field `/speak`
now returns rather than matching English prose. The client deadline is the server's budget plus 15s
grace so the server's own answer wins the race and the user is told which engine timed out.

Both new knobs are inert unless a caller passes them: the engine defaults to no client deadline and
no retries. That is what keeps the upstream `tts-source-persistence` assertions true, including the
serial-generation and stop-after-first-failure ones, with no edit to that file.

`generateAudio` now goes through `api.raw` instead of the one bare `fetch` left in the client, so it
carries the CSRF header, the admin secret, and the no-store policy every other request gets.

Progressive playback's hardcoded one-chunk lookahead became a bounded ring driven by
`generationConcurrency`; at 1 it issues exactly the same requests in the same order as before. The
between-chunk loading flip now only fires while the next clip is genuinely still coming, instead of
flashing a spinner over a clip the lookahead already had.

The `#2647` orphaned-audio guards are ported from `GameNarration` into the shared engine, which
never had them: every element handed to `play()` is tracked rather than just the current ref, and a
`play()` rejection on an element that is actually running is treated as started. Both cases
otherwise leave a clip nothing can pause.

Failures now raise a localized toast, loaded lazily and only in a browser so the regression suite
never pulls in sonner. A consecutive-failure counter backs the autoplay circuit breaker; it clears
as soon as any clip actually plays.

Patches to upstream files: `packages/client/src/lib/tts-service.ts` (the engine itself, the one to
re-check after a sync) and `packages/client/src/localization/locales/en.json`. Proven by
`scripts/regressions/tts/tts-synthesis-policy.regression.ts`.

### TTS honours a configured timeout, stops on disconnect, and reaches localhost

The provider request budget was the literal `AbortSignal.timeout(60_000)` in the `/speak` handler.
It now comes from `cfg.timeoutMs` (see the entry below), clamped again on read because
`resolveAudioConfig` overlays a connection row onto the parsed blob. No `TTS_SPEAK_TIMEOUT_MS` env
var: the config field is the mechanism, and an env fallback would have been unreachable once the
schema always supplies a value.

Client disconnect now aborts the provider request. The binding is `reply.raw`, not `req.raw`:
on a plain POST the request message completes as soon as Fastify parses the body, so `req.raw`
fires `close` about a millisecond into the handler and would abort every synthesis. Verified
empirically rather than from the docs, because the two differ only under a real socket:
`app.inject` has none, so an inject-only test cannot tell them apart. The regression therefore
drives a real listener for that case.

`/speak` failures carry a `code` of `timeout`, `unreachable`, or `provider_error` beside the
existing `error` string, so the client can branch without matching English prose. A disconnect
answers 499 rather than logging an error, since the listener is gone. The field is additive and the
existing client reads only `error`/`detail`/`message`.

Loopback is now allowed for every TTS source. `llmFetch` passes `allowLoopback: true` and
`allowMdns: true` unconditionally and `docs/CONFIGURATION.md` already promises that local model
servers keep working, but no TTS policy set it, so a localhost engine needed
`TTS_LOCAL_URLS_ENABLED` where an LLM server never did. The flag still gates private and LAN
addresses. `packages/server/src/services/tts/url-policy.ts` now issues the one policy every TTS
fetch uses; previously `/speak` used pockettts-bypass-or-flag, the PocketTTS probe hardcoded
`allowLocal: true`, and xAI voice listing hardcoded never-local while naming the flag it ignored.
That last one is a deliberate widening: xAI `/speak` was already flag-gated, so the listing was the
outlier. Game audio keeps its own hardcoded https-only ElevenLabs policy.

`/voices` and `/models` parse their query with Zod instead of an untyped cast. Synthesis gets its
own rate-limit bucket (`tts-speak`, 300/min) matched before the generic `/api/tts` rule: a message
is many chunk requests, so at a small chunk size with parallel generation the shared 90/min ran out
and began 429ing `/tts/config` reads mid-playback.

Patches to upstream files: `packages/server/src/routes/tts.routes.ts` and
`packages/server/src/middleware/rate-limit.ts`. Proven by
`scripts/regressions/tts/tts-speak-timeout-abort.regression.ts`, which boots the real app against a
stub engine.

### TTS source metadata and synthesis tuning have one definition

Local TTS engines were unusable. The reported symptom was "no paragraph splitting, no timeout
settings, no nothing"; splitting existed (900 chars, newline to sentence to clause to word) but
everything around it defeated it. The provider request budget was the literal
`AbortSignal.timeout(60_000)` in `tts.routes.ts` with no env var and no config field anywhere, so a
CPU engine needing longer could only be accommodated by editing source.

The list of TTS sources and their default base URL, model, and voice existed in six places: two
shared Zod enums, a shared const tuple, two tables in `tts.routes.ts`, and two more in the client,
one of which carried a comment saying it mirrored the other.
`packages/shared/src/constants/tts-sources.ts` now holds `TTS_SOURCE_IDS` and
`TTS_SOURCE_DEFINITIONS`, and every one of those sites derives from it. Per-model behaviour (ElevenLabs speed support, OpenAI speech instructions,
forced formats, auth headers) is deliberately absent from the table: it varies by model rather than
by source, so it stays in the request builders.

`ttsConfigSchema` gains `timeoutMs`, `chunkCharLimit`, `maxRetries`, and `generationConcurrency`,
all per source profile because a local CPU engine and a cloud API want opposite values. Defaults
reproduce today's behaviour exactly (60000 / 900 / 1 / 1) except `maxRetries`, which defaults to 1:
the chat path had no retries at all while the game path has shipped two attempts with backoff for
months, and one transient 502 killed an entire sequence. `progressivePlayback` now defaults to true,
which reaches only installs without a parseable saved blob, since `PUT /config` stores the fully
parsed object and a saved config therefore carries its own explicit value.

The per-source profile field list also existed three times: the Zod `pick`, `ttsSourceProfileFromConfig`,
and `TTSConfigCard`'s `defaultSourceProfile`. The latter two now derive from the schema by parsing,
so a field added to the pick cannot silently vanish from saved profiles. The card's `buildPayload`
is a fourth copy, but it is typed `TTSConfig`, so the compiler catches an omission there; its
source-switch restore path is not type-checked and is pinned by regression instead.

Patches to upstream files: `packages/shared/src/types/tts.ts`, `packages/shared/src/types/connection.ts`,
`packages/shared/src/schemas/connection.schema.ts`, `packages/shared/src/index.ts`,
`packages/server/src/routes/tts.routes.ts` (local tables deleted, six call sites repointed),
`packages/client/src/components/panels/settings/TTSConfigCard.tsx`, and
`packages/client/src/components/connections/ConnectionEditor.tsx`. All are upstream-edited;
`tts.routes.ts` and `TTSConfigCard.tsx` are the ones to re-check after a sync.

Proven by `scripts/regressions/tts/tts-shared-contract.regression.ts`. The upstream
`tts-source-persistence.regression.ts` imports moved helpers and asserts against `tts.routes.ts`
source text, and passes unedited.

### Speaker tags have one grammar, and it is well-formed markup

Group chat dialogue colouring asked models for `<speaker="Amy">`, which is not valid markup: an
attribute needs a name. Models emit `<speaker name="Amy">` whatever the prompt says, so the colour
lookup missed and fell through to the default, silently, because a missing speaker match is
indistinguishable from an untagged line.

The first attempt rewrote the model's output into the malformed spelling on the way in. That kept
the wrong format canonical and bought a repair step to maintain forever, so it was replaced:
`packages/shared/src/utils/speaker-tags.ts` now holds the whole grammar, readers accept both
spellings, and writers emit the well-formed one. Tolerance covers stored history, which is finite,
rather than model behaviour, which is not, and nothing rewrites a model's output.

Twelve consumers each carried their own copy of the pattern and now import it: prompt history
stripping, the individual-mode unwrap, narration NPC harvesting on both server and client, three
TTS sites, the conversation grouping check, the shared segment parser, and the chat renderer's HTML
detection plus both of its render paths. The regression forbids any other file from spelling the
tag out in code, which is the guard that would have prevented the original divergence.

Details worth keeping:

- **The malformed spelling existed for a reason.** Messages can render as real HTML, so a speaker
  tag has to be distinguishable from content markup. Matching the tag *name* does that just as well,
  which is what freed the spelling to become well-formed.
- **Regexes come from factories, never a shared instance.** A module-level `RegExp` with `g` carries
  `lastIndex` between callers, so one consumer's partial scan moves where the next one starts.
- **The name is capture group 1 or 2, not a back-referenced quote.** Two callers run the pattern
  inside a heterogeneous `patterns` array and read `match[1]`, so a leading quote group would have
  handed them the quote character.
- **`parseSpeakerTags` locates opener and closer separately.** A single span pattern's lazy body
  rescans to end-of-string from every opener, which made 50k openers with no closer quadratic. That
  is the case `code-scanning-content-parsing.regression.ts` guards, and a span-pattern rewrite broke
  it. Searching for the closer restores the original early exit.
- **A name containing a double quote is now representable**, because `formatSpeakerTag` switches to
  single quotes and the readers accept either.
- Both prompt sites build the instruction from `formatSpeakerTag`, so the text can no longer drift
  from what the app parses. The preview still adds its `Available characters` clause, which live
  generation still omits.

Patches to upstream-edited files, all of them replacing a private copy of the grammar with the
shared one: `generate.routes.ts`, `chats.routes.ts`, `generate-route-utils.ts`, `game.routes.ts`,
`ChatMessage.tsx`, `ConversationView.tsx`, `GameSurface.tsx`, `tts-dialogue.ts`,
`speaker-segments.ts`, and three assertions in `code-scanning-content-parsing.regression.ts` that
pinned the decoder's old output.

### Character cards collapse to a header

A cast of eight fills the tracker with cards you scroll past to reach the one you want. Each
character card now collapses to a one-line row carrying its avatar, emoji, name and mood, with a
collapse-all toggle in the Present Characters header.

Collapsed keys persist per chat in `trackerCollapsedCharacterKeys`, alongside the existing
`trackerFeaturedCharacterKeys`. Both now run through one `useCharacterCardKeySet` hook rather than
two copies of the same write-through-to-metadata logic; `useFeaturedCharacterCards` is a thin
wrapper over it, kept so upstream references to that name still resolve.

Featured and compact stay the only groups. Collapsing swaps what an entry renders as, never which
group it lands in, so a card holds its place in the list whether it is open or shut. Routing
collapsed entries into a third group under the open ones was tried first and was wrong: shutting one
card of eight sent it to the bottom, which is a re-sort, not a header.

In the two-column compact grid a collapsed row spans the full width and closes its line, so the
trailing ghost slot can no longer be a parity of the entry count. It is derived by walking the flow
instead.

Two details worth keeping:

- Collapse-all enumerates the live characters rather than reading the stored set, so keys left
  behind by departed characters cannot leave the button stuck reporting "all collapsed".
- Removing a character drops its collapsed key as well as its featured one. Without that, a later
  character resolving to the same key renders collapsed for no visible reason.

The row's avatar is plain `object-cover`. It first applied `getAvatarCropStyle(character.avatarCrop)`,
which crashed the panel: `avatarCrop` is typed `unknown` because it can still be raw JSON text from
storage, and `isLegacyAvatarCrop`'s `"zoom" in c` throws on a string. The cast that silenced the
compiler was the bug. `normalizeAvatarCrop` would have parsed it, but the deeper point is that no
other tracker avatar honours `avatarCrop` at all -- the panel frames with `portraitFocus` and
`portraitZoom` -- so the crop would have framed a character one way collapsed and another expanded.
The regression now forbids `getAvatarCropStyle` anywhere in the panel, and forbids casting
`avatarCrop` rather than parsing it.

Display only. Nothing in the collapsed path touches `presentCharacters`, and no server file knows
the metadata key, so a collapsed character reaches the prompt exactly as an expanded one does. The
regression pins that, because the tempting future optimisation is to stop sending them.

### Tracker line boxes scale with the tracker font scale

Font sizes in the panel come from `--tracker-fs-*`, which multiply by `--tracker-text-scale` (the
user's S/M/L/XL setting) and `--tracker-panel-font-scale`. Every `line-height` was a fixed rem and
did not. At the default size L the multiplier is 1.3, so a 0.625rem gauge label rendered at
0.8125rem inside a `leading-3` line box of 0.75rem: a line box smaller than its own font.

`FittedText` needs `overflow-hidden` for its ellipsis, so the excess was sheared rather than
overflowing. Descenders lost their tails on y, g, p and on the Polish tails in a, e. It read as
several unrelated bugs (stat gauge labels, the featured nameplate, detail fields) because it
surfaced wherever a glyph happened to have a descender.

All 38 length-valued line heights in `features/tracker-panel` are now unitless ratios, which are a
proportion of the element's own font-size and therefore track both scales with no token. That also
made 8 per-breakpoint `line-height` overrides redundant, since a ratio already follows whatever
font-size the breakpoint sets. Ratios preserve the value each site was designed at, floored at 1.25
so a descender clears the box.

Fixed heights that capped scaled text became floors in the same pass: the nameplate frame and its
name editor, the stat-name and value editors, and the quest title and objective rows.

`pnpm regression:...` lane `tracker-line-height-scale` forbids any length-valued `leading-` in the
panel and self-checks its own pattern against four legal and four illegal spellings.

The `globals.css` line-height allowlist under `[data-tracker-content-constrained="true"]` is left
alone. It keys on literal class strings that no longer appear in the panel, so it is inert here, but
it still covers shared components rendered inside the panel from elsewhere.

### Stat gauges wrap instead of scrolling off the edge

The gauge rail was a `snap-x` carousel with `scrollbar-hide`. In a fixed-width panel that meant a
fifth stat sat past the right edge with no visible affordance that anything was there.

The featured card capped its stat band at `max-h-[7.75rem]`, which moved the clipping from the right
edge to the bottom one once gauges wrapped: a second row scrolled out of sight. The cap now applies
to bar mode only, which is a scrolling list by design; gauge mode sizes to its rows.

The dashed-circle icon placeholder rendered on every gauge with no icon. It is a control, not data,
so it now appears only in edit mode, alongside the rest of them. Gauges that do carry an icon are
unchanged. The gate compares `editMode === true` rather than testing truthiness, because
`RoleplayHUDPanels` renders gauges outside the lock provider and reads `undefined` there.

Removing the icon and label's `-translate-y-1` fixed a collision the taller line boxes exposed: both
nudges were compensating for the cramped metrics, so once the stack sized correctly they pushed the
placeholder into the gauge arc.

Three or more gauges now lay out as `grid-cols-[repeat(auto-fit,minmax(4.25rem,1fr))]`, which wraps
into equal columns and needs no per-count breakpoint. Two or fewer keep the flex rail, because that
case always fits one row and carries the ornament rails and dividers. Dividers are dropped in the
wrapping mode: a divider element cannot know where a wrapped row breaks.

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

The handle is not rendered when the gutter cannot reach `TRACKER_PANEL_WIDTH_MIN`: there is nothing
to drag, and showing one would advertise an `aria-valuemax` the panel can never reach. Verified in a
browser at both widths -- at 2400px the drag tracks the pointer, commits, and persists past the
store's 1s write debounce; at 1500px the gutter is 89px and no handle appears.

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
