---
name: marinara-sandbox
description: How to run a second Marinara-Engine instance on scrubbed data for browser-driven testing without touching the real install - building the sandbox data (pnpm sandbox:data), starting, checking and stopping it (pnpm sandbox), what the scrub guarantees and what it leaves, and why a hand-rolled `PORT=... DATA_DIR=... pnpm dev` opens the real storage and takes over the live server. Use this skill whenever you want to drive the app in a browser, need realistic chats, characters, lorebooks or trackers to test against, are about to start any server other than the user's own, are about to set PORT, DATA_DIR, FILE_STORAGE_DIR or MARINARA_ENV_FILE on a server command, or need to stop a dev stack. Consult it before starting a second server and before printing anything read from the real data folder.
---

# The sandbox instance

A second copy of the app, running from source on a scrubbed clone of the real
data. It exists for two reasons that are easy to get wrong separately:

- **Isolation.** A second server that opens the real storage takes the running
  one over. This has happened (see "Why a hand-rolled start is dangerous").
- **Privacy.** A plain copy of the data is isolated but still real: every
  browser snapshot and screenshot of it puts private chats into the session.
  The sandbox keeps the structure and replaces the words.

## The one rule

**Start a second instance only with `pnpm sandbox`.** Never assemble one from
`PORT=`, `DATA_DIR=` or `MARINARA_ENV_FILE=` in front of `pnpm dev`,
`pnpm start` or `tsx src/index.ts`. The launcher checks the resolved storage
before it starts anything; a hand-rolled command checks nothing and fails
silently.

## Layout

| Thing | Where | Notes |
| --- | --- | --- |
| Data | `../marinara-sandbox-data` (beside the checkout) | Built by the scrubber; disposable |
| Marker | `<data>/.sandbox-data.json` | Written only when the scrub check passes; the launcher refuses a folder without it |
| Env file | `../marinara-sandbox.env` | Optional. `PORT` and `VITE_PORT` are read from it; storage never is |
| Ports | API 7880, client 7881 | Loopback only |

Do not write the marker by hand. It is the scrubber's statement that its check
passed, and the launcher's only proof that a folder is not real data.

## Commands

```bash
pnpm sandbox:data --from <copy of the data folder>           # first build
pnpm sandbox:data --from <copy of the data folder> --force   # refresh; replaces a marked sandbox only
pnpm sandbox:data --defaults-only  # re-apply working defaults in place; keeps keys and settings added since
pnpm sandbox --check    # print the data folder, env file and URL; start nothing
pnpm sandbox            # start; run it in the background
pnpm sandbox --stop     # stop the server and the client
```

Build from a copy, not from the live folder: the server may be mid-write. On
Windows, `robocopy <data> <copy> /E /XJ /XD node_modules` from PowerShell. From
Git Bash the switches must be doubled (`//E`), or they are rewritten into paths
and nothing is copied. `/XJ` matters: `capability-packages/node_modules` is
made of junctions robocopy cannot recreate.

The build takes about two minutes for a 650 MB data folder and prints counts
only. It is safe to show or log.

### After starting, verify

The server announces its storage on boot. Read it; do not assume it.

```bash
grep "FILE_STORAGE_DIR=" <the log pnpm sandbox was redirected to>
```

It must name the sandbox folder, exactly once (one boot). If it names anything
under `packages/server/data`, stop everything and tell the user.

## Using it

- Open `http://127.0.0.1:7881`. The client is Vite on current source, so client
  edits reload on their own.
- **Server edits need a sandbox restart** (`--stop`, then start). There is no
  file watcher, on purpose: see the launcher's header comment.
- Names and titles are pseudo-words, so a chat cannot be found by name. Pick one
  by mode or size, or let the user choose it in the browser.
- Saved API keys are blank. Replies and agents need a connection the user adds
  in the sandbox UI, ideally a key with a small spending cap and a cheap model.
  Ask for it; do not type credentials.
- The data is disposable. Break it freely and rebuild.

## What the scrub does

| Kept | Replaced | Removed |
| --- | --- | --- |
| Tables, row counts, links between rows | Words in free text, with same-length pseudo-words | API keys, tokens, any encrypted value |
| Chat modes, settings, tracker shapes | Names and lorebook keys, the same way everywhere | Remote URLs and host names |
| Message and text lengths, timestamps, numbers | Ids and slugs, letter runs only, consistently | Embeddings |
| Words the app's own code spells (modes, model ids, setting values) | Images, with same-size placeholders | Audio, videos, diagnostics, the encryption key |

Scrubbed prompts would make every agent and reply run on pseudo-word instructions, so the clone
also gets working defaults: every `promptTemplate` is emptied (agents then run their package
defaults) and every chat uses Marinara's Universal Preset, which the server restores to stock text on
boot. A rebuild wipes connections added in the sandbox; to fix defaults without losing them, stop
the sandbox and run `--defaults-only`.

Two things follow from the first column. Structure is real: how many chats
exist, how long they are and when they were written survive. And a word the
code itself contains is not treated as content, so a setting whose value is a
provider or model name keeps it.

### Reading the report

Every `leaks by field`, `leaking strings` and `hit origins` line should read
`none`. The check samples about 20,000 words from the source's free text and
every name and lorebook key, then looks for them in the output.

- `hit origins ... copied` or `kept unchanged ...` with any entry means a rule
  passed source text through. The build exits 1 and leaves the folder unmarked.
  Fix the rule the entry names (field and rule, never the text) and rebuild.
- `matches shaped like generated words (unverifiable)` is expected to be large.
  Pseudo-words are consonant-vowel runs, and a real word of that shape cannot
  be told from one, so those matches prove nothing either way.

## Working with real data while building

The build reads private data. Nothing it or you print may contain a value.

- Print table names, field names, shapes and counts. Never a row, a string, a
  file name derived from content, or a `head` of a data file.
- Diagnostics that need to look inside go in a scratch script that reports
  counts, as the scrubber's own check does.
- Server log lines are metadata, but a boot prints a one-time setup code when no
  remote login is set. It lives only in that process's memory and is useless
  once the process exits; still, do not paste boot logs wholesale.

## Why a hand-rolled start is dangerous

`getFileStorageDir()` in `packages/server/src/config/runtime-config.ts` reads
`FILE_STORAGE_DIR` before `DATA_DIR`, and the repo `.env` may set it. Exported
variables win over the env file, but only the ones you export:

| Command | What it opens |
| --- | --- |
| `PORT=7880 DATA_DIR=<x> pnpm dev` | **Real storage**: `FILE_STORAGE_DIR` still comes from the repo `.env` |
| `MARINARA_ENV_FILE=<file> PORT=7880 pnpm dev` | Whatever the file names; **real data** if it names no `DATA_DIR` |
| `pnpm sandbox` | The sandbox: all three exported, checked first |

A second server on the real storage triggers the running-copy takeover and the
user's live server shuts down. On 2026-11-20 the first row did exactly that:
the live server went down and a few minutes of package background writes
landed in real data. The mistake then stayed armed for half an hour, because
killing the dev stack's background task on Windows left two `tsx watch`
processes alive with that environment; any watched file change would have
restarted a server on the real storage.

`scripts/run-regressions.mjs` and `e2e/start-servers.mjs` isolate their servers
the same way the launcher does (their own env file plus exported folders),
which is why the test suites are safe.

This checkout may carry a local guard that blocks the hand-rolled forms and
names this skill. Treat the block as the answer, not as an obstacle.

### The only other legitimate second server

A throwaway empty instance, to watch a boot. Set all three inline, with the env
file inside the scratch folder:

```bash
cd packages/server && MARINARA_ENV_FILE=<dir>/.env DATA_DIR=<dir> FILE_STORAGE_DIR=<dir>/storage \
  PORT=7975 LOG_LEVEL=info AUTO_OPEN_BROWSER=false AUTO_CREATE_DEFAULT_CONNECTION=false \
  ./node_modules/.bin/tsx src/index.ts
```

## Stopping, and leftovers

Stop with `pnpm sandbox --stop`. It asks the server to exit through its own
shutdown route (the writer lease names the process), and the launcher then
stops the client. A clean stop leaves no process, no listener on either port
and no `storage/.writer-lease` in the sandbox.

**Do not stop any dev stack by killing its background task.** On Windows the
children survive. After any abnormal stop, look:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'Marinara-Engine' -and $_.CommandLine -match 'tsx|vite' } |
  Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine
```

A `tsx ... watch` line with no server under it is a leftover watcher. Stop it:
it restarts its server, with whatever environment it was born with, the next
time a watched file changes.

## Maintenance

- `scripts/sandbox-paths.mjs` holds the default locations, the marker name and
  the overlap checks. `scripts/run-sandbox.mjs` is the launcher,
  `scripts/make-sandbox-data.mjs` the scrubber.
- `scripts/regressions/tooling/sandbox-launcher.regression.mjs` pins the
  launcher's refusals and the exported environment. It fails if the storage
  export is dropped, with the real storage path as the actual value.
- The scrubber mirrors `encodeShardKey` and `decodeShardKey` from
  `packages/server/src/db/file-backed-store.ts` to rename shard files after it
  maps their keys. If the shard naming changes, change the mirror, then check
  that a rebuilt sandbox boots with no storage healing or quarantine lines.
- A storage format bump needs no scrubber change by itself: the scrub walks
  JSON by shape, not by schema. Rebuild from data the new format has migrated.
