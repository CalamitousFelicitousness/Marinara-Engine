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
Clicking a preset loads it into the panel's text box for editing; a note typed into the box
can be promoted with **Save as preset**.

Patches to upstream files: `packages/shared/src/types/chat.ts` (`ChatMetadata` gains the three
fields — note that `authorNotes` and `authorNotesDepth` were previously read via untyped casts
and declared nowhere), `packages/server/src/routes/generate.routes.ts`,
`packages/server/src/routes/generate/dry-run-route.ts`,
`packages/server/src/routes/generate/retry-agents-route.ts`,
`packages/server/src/routes/chats.routes.ts`, `packages/server/src/db/file-backed-store.ts`
(table registration only — no `STORAGE_VERSION` bump, since new tables are additive), and
`packages/client/src/components/chat/ChatRoleplayPanels.tsx`.

Those three generation routes each re-derived the note and re-hardcoded the default depth of
`4` independently. They now share `packages/server/src/services/prompt/author-notes.ts`, and
the default lives in `packages/shared` as `DEFAULT_AUTHOR_NOTE_DEPTH`. Covered by
`scripts/regressions/author-note-presets.regression.ts`, which runs in `pnpm regression:prompt`.

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

### Local dev environment

`.env` is untracked, so these settings are local rather than part of fork history. Recorded here because the dev loop depends on them.

- `PORT=7870` and `VITE_PORT=7871` stay clear of other local dev servers.
- `CORS_ORIGINS` includes the Vite origin, because the dev proxy rewrites `Host` but not `Origin`, so the server's same-origin shortcut does not apply.
- `AUTO_OPEN_BROWSER=false` stops both the launchers and the Vite dev server from opening a tab. The Vite half only works because of the port-resolution patch above — upstream's `vite.config.ts` never reads the repo `.env`, so this setting would otherwise be ignored by `pnpm dev`.
