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

### Generated `AGENTS.md`

`AGENTS.md` is generated from `CLAUDE.md` plus `.github/agents/codex-overlay.md`, so a contributor rule written for one AI agent cannot silently go missing for the other. Regenerate with `pnpm agent-docs:sync`; `pnpm agent-docs:check` runs inside `pnpm check` and fails on drift.

### pnpm 11 configuration migration

Every dependency override moved from `package.json#pnpm` into `pnpm-workspace.yaml`, because pnpm 11 no longer reads that field and was silently dropping all 17 pins. Build-script permissions moved from `onlyBuiltDependencies` to the `allowBuilds` map. `protobufjs` resolves to `7.6.5` — the later of the two conflicting pins, matching the committed lockfile.

### Local dev environment

`.env` is untracked, so these settings are local rather than part of fork history. Recorded here because the dev loop depends on them.

- `PORT=7870` and `VITE_PORT=7871` stay clear of other local dev servers.
- `CORS_ORIGINS` includes the Vite origin, because the dev proxy rewrites `Host` but not `Origin`, so the server's same-origin shortcut does not apply.
- `AUTO_OPEN_BROWSER=false` stops both the launchers and the Vite dev server from opening a tab. The Vite half only works because of the port-resolution patch above — upstream's `vite.config.ts` never reads the repo `.env`, so this setting would otherwise be ignored by `pnpm dev`.
