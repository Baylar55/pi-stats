# Parity matrix: oh-my-pi `/stats` → `pi-stats`

Reference: [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) @ `7c49c11a` (`packages/stats`, MIT).
Host: `@earendil-works/pi-coding-agent` 1.5.2 on Node ≥ 22.13 (verified against the installed
`docs/*.md`, `dist/**/*.d.ts`, and 48 real transcripts under `~/.pi/agent/sessions`).

Status legend: **ported** (same logic, runtime shims only) · **adapted** (pi forces a change; the
change is listed) · **omitted** (no pi data source; the reason is listed).

## Facts verified in pi (they drive every "adapted" row)

| # | Fact | Evidence |
|---|------|----------|
| F1 | Extensions are loaded with jiti `moduleCache: false` and re-evaluated on `/new`, `/resume`, `/fork`, `/reload`. Module-level state does not survive a session switch. | `dist/core/extensions/loader.js:486-490` |
| F2 | `session_shutdown.reason` is `"quit" \| "reload" \| "new" \| "resume" \| "fork"`. Only `quit` means the process exits. | `dist/core/extensions/types.d.ts:657` |
| F3 | Assistant messages carry `durationMs` (monotonic, request start → response end) since pi-ai's `AssistantMessageEventStream` sets it; legacy messages lack it. 237 of 1535 real assistant messages have it. **No TTFT field exists.** | `pi-ai/dist/types.d.ts:407-412`, real data |
| F4 | `turn_end` carries `messageEntryId` (the persisted assistant entry id); `message_end` fires before persistence. | `dist/core/extensions/types.d.ts:848-855`, `agent-session.js:814-826` |
| F5 | Session totals in pi = assistant `usage` + `usage` entries + `compaction.usage` + `branch_summary.usage` + `toolResult.usage`. | `agent-session.js:3552-3585` (`getSessionStats`) |
| F6 | `/fork` (`SessionManager.forkFrom`) copies every non-header entry verbatim; `/clone`-style `createBranchedSession` copies the root→leaf path with the same `id`/`timestamp` (only `parentId` is re-chained, labels re-created). Both write `parentSession` in the header. | `session-manager.js` `forkFrom`, `createBranchedSession` |
| F7 | Session dir = `--session-dir` flag ?? `PI_CODING_AGENT_SESSION_DIR` ?? settings `sessionDir` ?? `<agentDir>/sessions/--<cwd>--/`. A custom dir is flat (no per-cwd folder). `agentDir` = `PI_CODING_AGENT_DIR` ?? `~/.pi/agent`. | `main.js:598-603`, `config.js:510-548` |
| F8 | The cwd encoding in the folder name is lossy (`/`, `\`, `:` all become `-`), but the header line records the real `cwd`. | `docs/session-format.md`, real data |
| F9 | `migrateSessionEntries` only (a) assigns ids/parents to v1 entries and (b) renames role `hookMessage` → `custom`. It needs the whole file in memory and assigns random ids. | `session-manager.js` `migrateV1ToV2/V2ToV3` |
| F10 | The bundled `subagent` example spawns `pi --mode json -p --no-session`: no nested transcripts are written. No real session dir has nested `.jsonl` files. | `examples/extensions/subagent/index.ts:389` |
| F11 | Host packages resolve only through jiti's alias map inside the extension entry; a natively imported module cannot import `@earendil-works/*` when installed with `pi install` (peers are not installed). | `docs/packages.md`, `loader.js:34-89` |
| F12 | pi has no service tiers, premium-request counters, snapcompact savings journal, read-tool spotlight journal, auth broker, or provider usage-window history. | `pi-ai/dist/types.d.ts` (`Usage`), `docs/` |

## Command surface

| omp feature | omp source | pi data source / API | Status |
|---|---|---|---|
| `/stats [--port\|-p n] [--port=n] [--host h] [--host=h]`, defaults `127.0.0.1:3847`, exact usage/error strings | `slash-commands/helpers/stats-dashboard.ts` `parseStatsDashboardArgs` | `pi.registerCommand("stats")` | ported (strings verbatim) |
| Flag completion | omp command registry | `getArgumentCompletions` | adapted: pi's completion callback |
| Start-or-reuse in process; `Dashboard already running at: <url> (requested <h>:<p> ignored)` | `launchStatsDashboard` | runtime singleton on `globalThis` (F1) | adapted: state lives on `globalThis`, not module scope |
| Report `Dashboard available at: <url> (sessions sync in the background)` | `launchStatsDashboard` | `ctx.ui.notify`; stdout when `!ctx.hasUI` | ported |
| Open the page | `openTernPage` → `openPath` | `cmd /c start "" <url>` / `open` / `xdg-open`; URL only over SSH or headless | adapted: no Tern in pi |
| Close button / `setStatsCloseHandler` | `server.ts`, `client/app/CloseButton.tsx` | API and button ported; no pi launcher can close a system-browser tab, so the handler is never set and the button stays hidden (omp's `setStatsCloseHandler(undefined)` path) | ported, inactive |
| `stopStatsDashboard` on exit | `stats-dashboard.ts` | `session_shutdown` with `reason === "quit"` only (F2); server sockets are `unref`'d | adapted |
| Standalone CLI `omp stats` / `omp-stats`: `--port --host --summary --json`, TTY progress bar (~30 fps, single line, stderr), keep-alive until Ctrl+C | `cli/stats-cli.ts`, `stats/src/index.ts` | bin `pi-stats` | ported (chalk → `node:util` `styleText`) |
| Programmatic exports `syncAllSessions`, `refreshRollups`, `getDashboardStats`, `getTotalMessageCount`, `printStatsSummary`, `startServer`, `closeDb`, `formatStatsDashboardUrl` | `stats/src/index.ts` | `dist/index.js` | ported |

## Ingestion

| omp feature | omp source | pi data source | Status |
|---|---|---|---|
| Server binds first; ingest starts on first `/api/events` subscriber; newest sessions first; SSE progress | `live.ts`, `server.ts` | same | ported |
| Per-file cursors (offset, mtime, serialized parser state, 256-byte checkpoint hash), skip unchanged, tail-only parse, partial trailing line deferred | `parser.ts`, `db.ts` `file_offsets` | same | ported (`Bun.hash` → sha1 prefix; `Bun.file().slice` → `fs` positional reads) |
| Malformed lines / entries skipped, never fatal | `parser.ts` | same | ported |
| Atomic stats + cursor commits in bounded batches; interrupted batches retry without double counting | `chunked-insert.ts`, `aggregator.ts` | same | ported |
| Full reconciliation (rebuild modified/truncated files, repair stale rows) | `aggregator.ts` | same | ported |
| Cross-process sync lock | `pi-utils/file-lock` (native) | `wx` lock file with pid liveness check | adapted: no native lock primitive in Node |
| Parser worker pool | `sync-worker.ts`, `aggregator.ts` | `node:worker_threads` from the built `dist/sync-worker.js`; inline parsing when unbuilt (tests) | adapted |
| File watcher re-sync | `live.ts` | `fs.watch` on every session root (F7) | ported |
| Bodies dropped after extraction, large files streamed | `parser.ts` | same | ported |
| Session discovery `<agent>/sessions/**.jsonl` | `parser.ts` `listAllSessionFiles` | default sessions dir + `PI_CODING_AGENT_SESSION_DIR` + settings `sessionDir` + the live session's dir (covers `--session-dir`); roots are remembered in `meta` | adapted (F7) |
| Folder from directory name | `extractFolderFromPath` | header `cwd`, falling back to the decoded directory name | adapted (F8) |
| Assistant message → `messages` row | `extractStats` | `message.role === "assistant"` with `api/provider/model/usage` | ported |
| `duration`, `ttft` from the message | `msg.duration`, `msg.ttft` | `duration` = `message.durationMs` ?? live timing; `ttft` = live timing only | adapted (F3) |
| `model_usage` entries (side-model usage) | `extractModelUsageStats` | `usage` entries (`kind`, `provider`, `model`, `usage`); also `compaction.usage`, `branch_summary.usage`, `toolResult.usage`, attributed to the session's current model | adapted (F5) |
| Service-tier tracking, premium-request derivation | `parser.ts`, `pi-ai` | none | omitted (F12); columns kept, always `0` / `NULL` |
| Tool calls + result linkage (`args_chars`, `result_chars`, `is_error`, `calls_in_turn`) | `extractToolCalls`, `extractToolResultLink` | `toolCall` content blocks, `toolResult` messages | ported |
| User message metrics + reply links | `extractUserStats`, `ReplyTracker` | `message.role === "user"` | ported (`synthetic`/`attribution` do not exist in pi; all user messages are human) |
| Agent type `main` / `subagent` / `advisor` | `classifyAgentType` | nesting depth below a session root → `subagent`; `advisor` dropped | adapted (F10): only `main` occurs today |
| Fork dedupe `(entry_id, timestamp)` first-writer-wins + `fork_dedupe_v1` migration | `db.ts`, `chunked-insert.ts` | same key; pi forks copy ids and timestamps verbatim (F6) | ported |
| v1/v2 sessions | n/a (omp skips id-less entries) | id-less v1 entries get a deterministic id from the line hash and a linear parent; `hookMessage` is not a stats-relevant role | adapted (F9): `migrateSessionEntries` is not called because it needs the whole file and random ids would break idempotent re-sync |
| Spotlight ingest | `spotlight-ingest.ts` | none | omitted (F12) |
| `omp gc --compress` scratch dirs, `.jsonl.gz` archives | `parser.ts`, `trace.ts` | none | omitted: pi never compresses sessions |

## Storage

| omp table / mechanism | omp source | Status |
|---|---|---|
| `bun:sqlite` | `db.ts` | adapted: one adapter (`src/sqlite.ts`) over `node:sqlite` `DatabaseSync`; `bun:sqlite` when `process.versions.bun` |
| DB path `~/.omp/stats.db` | `pi-utils` `getStatsDbPath` | adapted: `<getAgentDir()>/stats.db` |
| `messages`, `tool_calls`, `user_messages`, `frustration_verdicts`, `session_titles`, `file_offsets`, `meta` | `db.ts` | ported (same columns) |
| `message_rollup`, `tool_rollup`, `tool_agent_rollup`, `session_rollup` + dirty tables and triggers | `db.ts`, `rollup.ts` | ported |
| Newest-first re-roll of dirty hours in short immediate transactions; exact reads over dirty hours | `rollup.ts` | ported |
| Versioned migrations through `meta` keys | `db.ts` | ported; omp-only backfills of pre-existing omp databases are dropped (a pi-stats DB starts empty) |
| Spotlight tables | `db.ts` | omitted (F12) |
| `timings` (session_file, entry_id, request_start, first_token_at, end_at) | — | new: filled by extension hooks, joined into `messages.duration/ttft` by triggers |
| `model_prices` snapshot | `pi-catalog` bundled models | adapted: prices come from `ctx.modelRegistry` (extension) or pi-ai's catalog (CLI) and are stored so both launchers price identically |

## Metrics

| Metric | Formula | Status |
|---|---|---|
| Tokens/s | `output_tokens / (duration / 1000)`, timed rows only | ported; untimed rows excluded, shown as N/A |
| Cache rate | `cache_read / (input + cache_read) * 100` | ported |
| Cache savings | `(uncached prompt cost − actual prompt cost) / uncached prompt cost * 100` | ported |
| Error rate | `count(stopReason = error) / total_calls * 100` | ported |
| API-equivalent cost | recorded `usage.cost`; zero-cost subscription/OAuth usage is priced at the public rate of the same model; no public price → unpriced, N/A, excluded from dollar totals | adapted: rate card from pi's model registry instead of `pi-catalog` |
| Avg latency | mean `duration`, timed rows only | ported |
| TTFT | mean `ttft`, timed rows only | adapted: live capture only (F3) |
| Premium requests | `usage.premiumRequests` | omitted (F12); API field stays `0`, UI stat removed |
| Time ranges `1h/24h/7d/30d/90d/All`, buckets 5 min / 1 h / local-midnight days, `All` capped at 1500 buckets, empty buckets zero | `aggregator.ts` `getTimeRangeConfig`, `client/data/range.ts`, `rollup.ts` | ported |

## Dashboard pages

| Page (hotkey) | omp source | Status |
|---|---|---|
| Overview (`o`) | `routes/OverviewRoute.tsx` | ported |
| Models (`m`) | `routes/ModelsRoute.tsx` | ported |
| Providers (`p`) | `routes/ProvidersRoute.tsx` | adapted: subscription-window section removed (F12) |
| Costs (`c`) | `routes/CostsRoute.tsx` | ported |
| Requests (`r`) + request drawer | `routes/RequestsRoute.tsx`, `ui/RequestDrawer.tsx` | ported |
| Errors (`e`) | `routes/ErrorsRoute.tsx` | ported |
| Traces (`t`): timeline canvas, minimap, span drawer, transcript list, aggregates | `routes/TracesRoute.tsx`, `traces/*`, `trace.ts` | adapted: spans are built from pi entries (assistant `durationMs`/live timing, `toolResult.durationMs`); omp-only journal entries (`session_init`, `mode_change`, background jobs, subagent lanes, advisors) have no pi source |
| Tools (`l`) | `routes/ToolsRoute.tsx` | ported |
| Frustration (`f`) | `routes/FrustrationRoute.tsx`, `frustration.ts`, `user-metrics.ts` | ported; judge runs through `ctx.modelRegistry.complete()` |
| Projects (`j`) | `routes/ProjectsRoute.tsx`, `normalizeProjectPath` | ported |
| Gain (`g`) | `routes/GainRoute.tsx`, `gain-aggregator.ts` | omitted: reads omp's `snapcompact-savings.jsonl`; pi has no snapcompact |
| Spotlight (`s`) | `routes/SpotlightRoute.tsx`, `spotlight-*.ts` | omitted: reads omp's read-tool spotlight journal; pi's `read` tool records none |
| Shell, sidebar groups, `1`–`6` ranges, `g`+letter, keys ignored in fields/dialogs | `app/Shell.tsx`, `app/nav.ts`, `app/keys.ts` | ported |
| Hash routing | `data/useHashRoute.ts` | ported |
| Revalidate on SSE data version; LiveChip sync progress + rollup backlog | `data/live.tsx`, `data/query-store.ts`, `app/LiveChip.tsx` | ported |
| Auto/Light/Dark theme | `app/ThemeToggle.tsx`, `useSystemTheme.ts` | ported |
| Charts (Chart, TimeChart, BarList, ShareBar, Sparkline, DotWhisker, Waterfall, Legend), model colors | `charts/*`, `data/colors.ts` | ported |
| Visual design | `styles.css`, `routes/*.css`, `traces/traces.css`, `ui/*.css` | ported |
| Agent-type breakdown panels | `OverviewRoute`, `ToolsRoute` | adapted: rendered only when a non-`main` type has data (F10) |
| Untimed rows | — | adapted: N/A, never 0; pages say "timing captured since install" |

## HTTP API

| Endpoint | Status |
|---|---|
| `GET /api/status`, `GET /api/events` (SSE) | ported |
| `GET /api/stats`, `/overview`, `/model-dashboard`, `/models`, `/providers`, `/costs`, `/recent`, `/errors`, `/folders`, `/timeseries`, `/tools`, `/frustration` | ported (shapes from `shared-types.ts`) |
| `GET /api/request/:id`, `/api/sessions`, `/api/session/trace` (ETag), `/api/session/entry` | ported |
| `POST /api/sync`, `/api/frustration/judge`, `/api/frustration/cancel`, `/api/close`; `GET /api/frustration/estimate` | ported |
| `GET /api/stats/gain`, `/api/stats/spotlight`, `/api/stats/spotlight/session`, `/api/stats/provider-windows` | omitted (F12) |
| Dashboard identity headers for the reuse probe | adapted: `X-Pi-Stats-*` names, so a pi-stats never "reuses" an omp dashboard on the shared default port 3847 |
| Action header on spending/mutating POSTs | ported (`X-Pi-Stats-Action: 1`) |
| Security | adapted, stricter: `Host` allow-list (DNS rebinding), same-origin `Origin` on POST, no CORS headers, static allow-list of built client files |
| Transport | adapted: `Bun.serve` → `node:http` |
| Client assets | adapted: omp embeds a gzip archive in its binary; pi-stats ships `dist/client/*` built by esbuild |

## Frustration

| Feature | Status |
|---|---|
| Heuristic metrics (yelling, profanity, anguish, negation, repetition, blame), markup stripped | ported (`user-metrics.ts` verbatim) |
| Judge rubric `prompts/judge/frustration.json` | ported verbatim |
| Judge transport | adapted: omp `judgeQuestions` over its model roles → `ctx.modelRegistry.complete()` with the model chosen in the dashboard, defaulting to the session's current model |
| Run only on click; estimate first; cancel; verdict cache by `prose_hash` | ported |
| Standalone bin has no judge; UI says so | ported |

## Tests (omp `packages/stats/test`, run with vitest on Node)

| omp test | Status |
|---|---|
| `parser-malformed-entries`, `parser-large-session`, `parser-model-usage`, `incremental-tail`, `sync-serial`, `reply-links`, `agent-type` | ported |
| `fork-dedup` | ported |
| `rollup`, `db-cost`, `db-range`, `errors-range`, `provider-stats`, `tool-stats`, `local-day-buckets` | ported |
| `user-metrics`, `frustration` | ported |
| `server-port-conflict`, `live-external-writes`, `stats-cli`, `server-embedded-client` (→ static client) | ported |
| `trace-builder`, `trace-etag`, `trace-lane-axes`, `trace-scale` | ported where the spans exist in pi |
| `client-number-format`, `client-query`, `client-view-models`, `model-color-consistency`, `errors-route-range` | ported |
| `gain-aggregator` | project-path normalization cases ported; snapcompact cases omitted |
| `spotlight`, `spotlight-measures`, `embedded-client-archive`, `smoke-worker-darwin`, `behavior-backfill`, `priority-premium-requests` | omitted: test omp-only data, packaging, or legacy-DB migrations |
