# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Companion Documents

`CONTRIBUTING.md` stays canonical for workflow, validation, and release policy. This file adds the architecture map plus the agent-specific operating rules. Two companion documents are authoritative in their own scope:

- `packages/client/.instructions.md` — authoritative for all frontend work: architecture, patterns, conventions, and common-mistake avoidance.
- `.github/agents/chai-workflow.md` — the repo's additive AI-agent workflow overlay for proof discipline, bugfix lanes, feature sizing, issue filing, PR gates, and risky-work claim boundaries.

The overlay does not replace this file, `CONTRIBUTING.md`, package instructions, or maintainer requests. Repo rules and the user's latest request still win. `CONTRIBUTING.md` and the overlay both describe the upstream project's contribution process; in this fork they apply only to upstream-bound work.

## Fork Workflow

This checkout is a fork. Upstream is `Pasta-Devs/Marinara-Engine`; this repository is where the local work lives.

| Remote | Points at | Used for |
| --- | --- | --- |
| `upstream` | `Pasta-Devs/Marinara-Engine` | fetching and syncing |
| `origin` | the fork | pushing |

- `staging` tracks `upstream/staging` for fetch, while `remote.pushDefault=origin` sends pushes to the fork. A bare `git push` is correct; do not add `-u`, which would retarget tracking and undo the split.
- Sync with `git fetch upstream` then merge `upstream/staging`. `git status` ahead/behind therefore reads as divergence from upstream, which is the useful measure here.
- **Run the dev loop with `pnpm dev`,** not the launchers. `start.bat` stashes the working tree, attempts `git merge --ff-only origin/staging` — which always fails on a diverged fork — and hard-resets if the stash reapply conflicts. Use `start.bat --skip-update` or `start-local.bat` when a built app is genuinely needed.
- Ports come from `.env`: the API on `PORT`, the Vite dev server on `VITE_PORT`. `CORS_ORIGINS` must include the Vite origin, because the dev proxy rewrites `Host` but not `Origin`. `AUTO_OPEN_BROWSER=false` there suppresses tab-opening for both the launchers and the Vite dev server.
- `.env` is gitignored and holds local host names; never move its contents into a tracked file.
- **After every upstream merge, run `pnpm check`.** It runs the fork guards, which fail loudly if a merge reverted a fork patch. `FORK-CHANGES.md` lists what this fork changes and which patches sit in files upstream also edits.

## Commands

Node 24+ and the repo-pinned pnpm (`packageManager` in root `package.json`) are required.

| Task | Command |
| --- | --- |
| Install | `pnpm install` |
| Dev, server + client with hot reload | `pnpm dev` |
| Dev, API only (port 7860) | `pnpm dev:server` |
| Dev, Vite client only (port 5173) | `pnpm dev:client` |
| Production build | `pnpm build` |
| Baseline validation | `pnpm check` |
| Full regression + smoke suite | `pnpm test` |
| Format | `pnpm format` |

`pnpm check` runs stale-client cleanup, the Impeccable design-context guard, the agent-doc sync guard, the fork dev-port guard, localization checks, workspace lint/typecheck, and the production build. It does **not** run regressions.

Two of those are fork guards, cheap source-shape checks rather than behavioral tests, which is why they sit in `check` instead of the regression lane: `pnpm agent-docs:check` (AGENTS.md matches CLAUDE.md) and `pnpm dev-ports:check` (the dev-server port patch is intact).

The Impeccable guard (`scripts/check-impeccable-context.mjs`) fails the build if `PRODUCT.md` is missing, too short, or still contains `[TODO]` markers, so keep `PRODUCT.md` and `DESIGN.md` intact when touching root docs.

### The shared package is a build dependency

`packages/shared` compiles to `dist/`, and both the server and the regression scripts resolve `@marinara-engine/shared` through that output. Run `pnpm build:shared` after changing shared source. The server dev watcher deliberately ignores `../shared/dist`, so a running `pnpm dev:server` also needs a restart.

### Regressions are this repo's test suite

There is no Vitest or Jest suite. Tests are ~113 standalone `tsx` scripts under `scripts/regressions/` that assert with `node:assert/strict` and print `<name> regression passed.` on success.

Do not keep `.test.ts` files in the repo. If an agent creates one for local proof, remove it after the test is done.

Run a single regression:

```bash
pnpm build:shared   # once, when the script imports packages/shared/dist
pnpm --filter @marinara-engine/server exec tsx ../../scripts/regressions/dice-display.regression.ts
```

Check `package.json` for a named alias first — most lanes have one (`pnpm regression:prompt`, `pnpm regression:issues`, `pnpm regression:roleplay`, `pnpm regression:providers`). Launcher and installer guards are plain node scripts run from the root instead, for example `node ./scripts/regressions/launcher-update.regression.mjs`.

`pnpm regression` runs every lane and ends with `pnpm smoke:ui`.

### Playwright smoke

```bash
pnpm smoke:ui                                 # desktop-chromium + mobile-chromium
pnpm smoke:ui --project=desktop-chromium      # one project
pnpm smoke:ui --grep "chat"                   # one test by title
```

Pass Playwright flags **without** a `--` separator. pnpm forwards a literal `--` into the command, and Playwright reads everything after it as positional file filters, so `pnpm smoke:ui -- --grep "chat"` silently ignores the filter and runs the whole suite. Scripts that parse argv themselves (`version:sync`, `release:notes`) tolerate the separator and keep it below.

Specs live in `e2e/*.e2e.ts`. The run starts its own isolated servers (defaults: 5178/7971 desktop, 5179/7972 mobile) and clears `.tmp/playwright-data`. It never reuses a dev server, so free those ports first.

### Release metadata

```bash
pnpm version:check                                  # drift across derived version files
pnpm version:sync -- --android-version-code <next>  # after bumping root package.json
pnpm credits:check                                  # fix failures with pnpm credits:sync
```

## Architecture

Marinara Engine is a **local, single-user** AI chat, roleplay, and game engine: a Fastify API plus a React PWA. In production a single process on port 7860 serves both the API and the built client. Launchers (`start.bat`, `start.sh`, `start-termux.sh`, `MarinaraLauncher.exe`) perform git-based auto-update, then start that server.

```text
packages/shared   Zod schemas, types, constants (APP_VERSION, providers, prompt defaults). Contract for both sides.
packages/server   Fastify API, file-native storage, prompt assembly, LLM providers, agents, importers.
packages/client   React 19 SPA/PWA. No URL router — navigation is Zustand state.
android/ win/     Android WebView wrapper; Windows installer sources.
```

### Server request path

`index.ts` to `app.ts` (`buildApp`), through the middleware chain, into `routes/index.ts` (everything mounted under `/api/...`), down to `services/storage/*.storage.ts`, then `db`.

`app.ts` is also the startup orchestrator: security hooks (host validation, CORS, rate limit, CSRF, basic auth / IP allowlist / Android local auth), `app.db` decoration, seeds (`db/seed*.ts`), one-way data migrations, capability-package runtime boot, and the autonomous scheduler. New global startup work belongs there.

Routes stay thin: parse the body with a shared Zod schema, gate with `requirePrivilegedAccess` when the action installs, executes, or deletes something, then delegate to a storage service. `routes/themes.routes.ts` is the reference shape.

Security-relevant behavior is concentrated in `middleware/` and `config/runtime-config.ts`. Many capabilities are opt-in through `.env` flags that default to off (`CUSTOM_TOOL_SCRIPT_ENABLED`, `ENABLE_EXTERNAL_EXTENSIONS`, `UPDATES_APPLY_ENABLED`, `PROVIDER_LOCAL_URLS_ENABLED`), and each has a matching `*-security` regression lane. Keep the default-off posture and extend the lane when you touch one.

### Storage is file-native JSON, not SQL

`db/file-backed-store.ts` implements a Drizzle-shaped query API over in-memory tables that persist as JSON snapshots under `DATA_DIR/storage`. Tables are declared with a small DSL (`fileTable`, `text`, `.primaryKey()`, `.notNull()`, `.default()`) in `db/schema/*.ts` and re-exported from `db/schema/index.ts`. `db/connection.ts` exposes the singleton `DB`.

There is no migration tool despite the Drizzle-like surface. A layout change needs a hand-written row migration (see `db/noodle-platform-migration.ts`) plus the coordinated `STORAGE_VERSION` bump described under Version Truth.

### Generation pipeline

The core loop is `routes/generate.routes.ts` (~10k lines) with helpers split across `routes/generate/*`:

1. Resolve preset, connection, characters, persona, and chat history.
2. `services/prompt/assembler.ts` builds the ChatML array — expands markers (`marker-expander.ts`), scans lorebooks, resolves macros (`macro-context.ts`), wraps sections via `format-engine.ts` (`wrapContent`/`wrapGroup`), merges adjacent messages (`merger.ts`).
3. `services/llm/provider-registry.ts` constructs the provider from `providers/*.provider.ts` (OpenAI-compatible, Anthropic, Google, Claude/Grok subscription, local sidecar), wrapped with connection defaults and fallback handling.
4. `services/agents/agent-pipeline.ts` runs agents in three phases around the call: `pre_generation` injects context, `parallel` fires alongside the main generation, `post_processing` sees `mainResponse`. Agents that share provider and model are batched into one LLM call; different connections run in parallel.
5. Output streams to the client as SSE (`routes/generate/sse.ts`) with typed events: `token`, `agent_update`, `game_state`, `done`, `error`.

Chat mode (`"conversation" | "roleplay" | "game"` in `packages/shared/src/types/chat.ts`) selects the prompt scaffolding, which agents may activate (`constants/chat-mode-agent-policy.ts`), and which client surface renders.

### Capability packages

Optional features and downloadable agents load at runtime through `services/capability-packages/*` — package manager, module runtime, and registries for agents, commands, routes, services, and prompt context. The Engine owns this host integration; package contents live in a separate repository (see Repo-Specific Cautions).

### Client

React 19, Tailwind v4, Zustand for UI and runtime state, React Query for server data. Navigation is state-based: setting `rightPanel`, a `*DetailId`, or `modal` in `ui.store.ts` changes what `AppShell`, `RightPanel`, and `ModalRenderer` render. All requests go through `lib/api-client.ts` (`api.get/post/patch/delete/upload/download/streamEvents`), which prefixes `/api`.

## Repo-Specific Invariants

### Prompt leaf content is verbatim

What the model receives inside a prompt section equals what the user typed. Character card fields, persona, lorebook entries, memories, scene text, and example dialogue are passed **unescaped** — users legitimately author cards with `<thinking>`-style tags. Do not add `<`, `>`, or `&` escaping to that path; it has been added and reverted repeatedly. See `CONTRIBUTING.md § Prompt Leaf Content Is Verbatim` and the header comment in `packages/server/src/services/prompt/prompt-escaping.ts`.

Structural wrappers emitted by `wrapContent` are separate and unaffected. The agent XML escapers (`escapeXml` and `escapeXmlAttribute` in `agent-executor.ts`, plus the local escaper in `knowledge-router.ts`) feed strict machine-parsed documents and must stay escaped — that is not a reason to harmonize the main prompt path.

### Localization is part of every client change

New or changed user-facing labels, messages, tooltips, placeholders, toasts, confirmations, accessibility text, tutorials, and similar copy must use semantic localization keys and update the canonical English catalog (`packages/client/src/localization/locales/en.json`) in the same change, rendered through `useTranslation`.

Community locale files are intentionally partial: update only translations the contributor can responsibly supply, and let missing keys fall back to English. Never touch every bundled locale merely to copy English or satisfy key parity. Do not translate model prompts or user-authored content. `pnpm localization:check` runs inside `pnpm check`.

### Fork changes are recorded in FORK-CHANGES.md

Record bug fixes, behavior changes, and new features that stay in this fork in `FORK-CHANGES.md`, not `CHANGELOG.md`. Upstream rewrites the `[Unreleased]` region constantly, so a fork entry there conflicts on every sync. Keep `CHANGELOG.md` byte-identical to upstream unless the change is destined for an upstream pull request.

Note in `FORK-CHANGES.md` whether a change patches a file upstream also edits, because those are the ones a merge can silently revert.

## Preferred Workflow

- Start with `pnpm install`.
- Run `pnpm check` as the baseline validation command.
- Run `pnpm version:check` when you touch release metadata, version-bearing files, or README release references.

## Repo-Specific Cautions

- Keep edits non-destructive. Do not revert unrelated work in the tree.
- Prefer focused patches that keep code, docs, and release metadata aligned in the same change.
- Check `README.md`, `android/README.md`, `CONTRIBUTING.md`, `docs/CONFIGURATION.md`, `docs/TROUBLESHOOTING.md`, and `docs/FAQ.md` together when install, update, or release behavior changes.
- Downloadable agents such as Illustrator, Music DJ, and Lorebook Keeper are content of a separate repository, [Pasta-Devs/Marinara-Agents](https://github.com/Pasta-Devs/Marinara-Agents) — agent definitions, default prompts, package-owned runtime code, metadata, assets, manifests, and catalog entries live there. This repository owns the host integration: package loading, capability APIs and shared contracts, Engine UI/settings, storage, provider/model routing, orchestration, and compatibility handling. Know which side a change belongs to before starting, even when both are edited locally in a fork.

## When Contributing Back Upstream

These rules govern pull requests to `upstream` (`Pasta-Devs/Marinara-Engine`). They do **not** apply to ordinary work in this fork — see Fork Workflow above for that. Follow them only when the user asks for a change destined for upstream.

- Target `staging`, never `main`. See `CONTRIBUTING.md § Branches`.
- Required checks and CodeRabbit must complete before any `staging` merge. PRs from active Pasta-Devs organization members and owners do not require another human approval; outside and first-time contributors require an approving review from `SpicyMarinara`. Organization members with repository merge permission may merge internal PRs after those gates pass.
- Only `SpicyMarinara` may promote the repository's `staging` branch into `main` or merge a same-repository `hotfix/*` branch.
- Route agent-content changes to [Pasta-Devs/Marinara-Agents](https://github.com/Pasta-Devs/Marinara-Agents) against its `staging` branch, and split cross-repository changes when both package content and host integration are affected.
- Before starting issue work, check for an existing issue-linked branch, open PR, draft PR, or project board item so multiple agents do not duplicate effort.
- When implementation effort starts for an issue, open a draft PR immediately so the project Kanban board shows the work in progress.
- When starting work on an issue, tag or identify the GitHub user or agent owning that issue/PR so ownership is visible before implementation proceeds.
- Make the why explicit in the PR description, so reviewers see the user problem or rationale rather than only the file changes.
- Add the user-facing entry to `CHANGELOG.md` under `[Unreleased]` in the upstream-bound commit only, not in fork history.
- When a change adds, renames, or edits user-facing docs under `docs/`, also update every translated language pack on the `docs-i18n` branch to match — or open a `[docs-i18n] <paths>` follow-up issue. Renames/deletions must be mirrored there or the translation is silently orphaned. See `CONTRIBUTING.md § Translated documentation`.
- **Never auto-check validation or test-plan checkboxes in a PR.** Those boxes are a to-do list for the human contributor, not evidence that work is done. If you generate a test plan, leave every box unchecked.
- List what needs manual verification explicitly. Write entries like "Manually verify X in browser" rather than "Works correctly."
- If there is no linked issue or feature request, note that one should be opened before the PR is submitted. See `CONTRIBUTING.md § Before You Open a Pull Request`.

## Version Truth

- Canonical version: root `package.json`
- Release tag format: `vX.Y.Z`
- Release-notes source: `CHANGELOG.md`
- Derived version files that must stay in sync:
  - `packages/client/package.json`
  - `packages/server/package.json`
  - `packages/shared/package.json`
  - `packages/shared/src/constants/defaults.ts`
  - `win/installer/installer.nsi`
  - `win/installer/install.bat`
  - `android/app/build.gradle`

Android-specific rule:

- `versionName` matches the app version.
- `versionCode` increments for every shipped APK.

Storage-format rule (separate from the app version — never touched by `version:sync`):

- Root `storage-format.json` must equal `STORAGE_VERSION` in `packages/server/src/db/file-backed-store.ts`. It changes only when the on-disk storage layout changes; the launcher/updater downgrade guard reads it via `git show` on the update target, so a missed bump silently disables that protection. The launcher-format-guard regression pins the pairing.

## Safe Multi-File Updates

- When changing version numbers, bump root `package.json` first, then run `pnpm version:sync -- --android-version-code <next-code>`.
- When changing version numbers or preparing a release, run `pnpm credits:check`; if it fails, run `pnpm credits:sync` and include the Credits modal update.
- Run `pnpm version:check` before tagging or publishing.
- Keep `CONTRIBUTING.md` authoritative. Add Claude-specific notes here only when they are operationally useful and not already covered there.

Agent instruction files are generated, so never hand-edit `AGENTS.md`:

- `CLAUDE.md` is the hand-edited source of truth. Everything from its first level-2 (`##`) heading onward is shared by every agent.
- `AGENTS.md` is generated from `CLAUDE.md` plus `.github/agents/codex-overlay.md`, which holds the Codex-only heading and preamble.
- After editing either source, run `pnpm agent-docs:sync`. `pnpm agent-docs:check` runs inside `pnpm check` and fails on drift, so a rule added for one agent cannot silently go missing for the other.
- A shared-body mention of a specific agent by name fails the sync deliberately. Register it in `SUBSTITUTIONS` (an agent reference to rewrite) or `PRESERVED_SPELLINGS` (a filename or product name, such as the Claude/Grok subscription providers) in `scripts/sync-agent-docs.mjs`.

## Logging

- **Never use `console.log/warn/error` in server code.** Always import the shared Pino logger:

  ```ts
  import { logger } from "../lib/logger.js"; // adjust relative path
  ```

- Use the correct level: `logger.error` for failures, `logger.warn` for non-fatal issues, `logger.info` for operational milestones, `logger.debug` for verbose traces (prompts, timing, state patches).
- When adding a new agent, model generation route, image generation route, or prompt-building helper, wire prompt logging before shipping it. Accept and pass UI `debugMode` where relevant, honor `DEBUG_AGENTS`, and use `logDebugOverride(...)` or an equivalent `debugLog` callback so the final prompt sent to the provider is visible in debug mode even when the default log level is not `debug`.
- Use Pino format specifiers for multi-arg calls: `logger.info("Resolved %d agents", count)` — not `logger.info("Resolved agents:", count)`.
- Log errors with the error object first: `logger.error(err, "Import failed")`.
- Client code (`packages/client/`) should keep using `console.*` — the browser has no Pino, and production builds strip `console.log` automatically.
- See `CONTRIBUTING.md § Logging` for full guidelines and `docs/CONFIGURATION.md § Logging Levels` for the user-facing reference.

## Frontend Changes

- **Read `packages/client/.instructions.md` before editing any client code.** It is the authoritative reference for architecture, patterns, conventions, and common-mistake avoidance. Load-bearing rules it covers: no barrel or index exports, lazy-load new editors in `AppShell.tsx`, never call `fetch()` directly, keep async logic in React Query hooks rather than Zustand stores, and the shared row-action-button pattern for settings panels.
- Treat localization as part of every client UI change, per Repo-Specific Invariants above. Run `pnpm localization:check` before shipping.
- Validate with `pnpm check` (TypeScript + ESLint). Use `pnpm regression:prompt` for prompt, lorebook, and macro regressions, and `pnpm smoke:ui` for the browser shell smoke suite when the change touches those areas. The repository does not ship a conventional `.test.ts` suite.
