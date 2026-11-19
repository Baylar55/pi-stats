# pi-stats-web

Local observability dashboard for [pi](https://pi.dev): `/stats` opens a live web dashboard of AI usage statistics built from your session transcripts.

## Install

```bash
pi install npm:pi-stats-web     # from npm
pi install ./pi-stats           # from a checkout (run `npm install && npm run build` in it first)
pi -e ./pi-stats                # try it for one invocation
```

npm is the only remote install source: `dist/` is not committed, so `pi install git:…` would get no built files.

Requires Node 22.16+ on the 22.x line, or Node 24+ (`node:sqlite`'s `isTransaction` and `setReturnArrays`; Node 23 lacks them). pi itself needs 22.19+. No runtime dependencies: the client ships pre-built in `dist/client`.

## Usage

### In pi

```
/stats [--port|-p <port>] [--host <host>]
```

Starts the dashboard (default `http://127.0.0.1:3847`), opens it in the system browser and returns at once; sessions sync in the background. Over SSH or without a display the URL is printed instead. A second `/stats` reuses the running server. The dashboard stays up across `/new`, `/resume`, `/fork` and `/reload` and stops when pi exits.

If port 3847 is held by another pi-stats dashboard (another pi session, or the bin), that one is reused; if another program holds it, a free port is picked.

### Standalone

```bash
pi-stats                  # start the dashboard, Ctrl+C to stop
pi-stats --port 8080
pi-stats --summary        # sync, then print a summary of the last 24 hours
pi-stats --json -r all    # sync, then print getDashboardStats("all") as JSON
```

`--range`/`-r` sets the window of `--summary` and `--json`: `1h`, `24h` (default), `7d`, `30d`, `90d` or `all`.

The bin has no judge: the Frustration page shows the regex fallback and says so.

**Prices.** The bin seeds an empty rate card from pi-ai's built-in catalog when `@earendil-works/pi-ai` resolves (e.g. pi installed globally next to it); a card already stored is left alone. Without either, zero-cost requests (subscription, OAuth) stay N/A until `/stats` has run once inside pi, which stores pi's full registry, including `models.json` and extension providers.

### Programmatic

```ts
import { getDashboardStats, refreshRollups, syncAllSessions } from "pi-stats-web";

await syncAllSessions({ onProgress: ({ current, total }) => {} });
await refreshRollups();
const stats = await getDashboardStats("all"); // "1h" | "24h" | "7d" | "30d" | "90d" | "all", default "24h"
console.log(stats.overall.totalCost);
```

Also exported: `getTotalMessageCount()`, `printStatsSummary(range)`, `startServer(port, host, opts)`, `closeDb()`, `formatStatsDashboardUrl()`. Type declarations ship in `dist/types`.

## Dashboard

Pages: Overview `o`, Models `m`, Providers `p`, Costs `c`, Requests `r`, Errors `e`, Traces `t`, Tools `l`, Frustration `f`, Projects `j`. Keys `1`–`6` pick the time range; `g` then a letter jumps to a page. URLs are hash-routed, so a URL is a shareable view. Every page revalidates when the live data version moves; there is no refresh button.

## Metrics

| Metric | Calculation |
|---|---|
| Tokens/s | `output_tokens / (duration / 1000)`, timed requests only |
| Cache rate | `cache_read / (input + cache_read) * 100` |
| Cache savings | `(uncached prompt cost - actual prompt cost) / uncached prompt cost * 100` |
| Error rate | `count(stopReason = error) / total_calls * 100` |
| API-equivalent estimate | recorded cost; zero-cost usage priced at the public rate of the same model |
| Avg latency | mean `duration`, timed requests only |
| TTFT | mean time to first token, timed requests only |

**Cost.** pi records a cost per request. Subscription and OAuth providers record zero; those requests are priced at the public API rate of the same model (from pi's model registry) and are an estimate of API-equivalent usage, not your bill. When several providers list that model id at different prices (a reseller markup), the alphabetically first provider's price is used. Models nobody prices are reported as N/A and kept out of dollar totals.

**Timing.** pi records no time to first token, so pi-stats measures it from the moment the extension is loaded: TTFT for earlier messages is N/A (*timing captured since install*), never 0. Request duration comes from the transcript (`durationMs`, or request start to persist time on older pi versions) and is available for history too.

## Data

- **Session logs**: every directory pi writes sessions to: `<agentDir>/sessions`, `PI_CODING_AGENT_SESSION_DIR`, the `sessionDir` setting, and the live session's own directory (covers `--session-dir`). Scanned recursively; a transcript an extension nests below a session is counted as a subagent of it.
- **Stats database**: `<agentDir>/stats.db` (SQLite, WAL). A derived cache: delete it and the next sync rebuilds it, except live timings and judge verdicts.
- **Log**: `<agentDir>/pi-stats.log` (warnings only, e.g. skipped malformed transcript lines or port conflicts; `PI_STATS_DEBUG=1` for more). Not rotated.

Sync is incremental (per-file cursors, only appended bytes are parsed), commits rows and cursors atomically in bounded batches, and counts `/fork` and branch copies once. Usage counted: assistant messages, `usage` entries, and usage on compactions, branch summaries and tool results: the same set pi's own session totals use.

## Frustration judge

Heuristic scores (yelling, profanity, anguish, negation, repetition, blame) are computed for every user message at ingest. The optional LLM judge only runs when you click **Run** on the Frustration page, after a count and cost estimate; it can be cancelled, and verdicts are cached per message text. It uses the model picked in the dialog, which lists the session's scoped models (`--models`, `enabledModels`) when it has any, else every available model. The default is the session's current model (followed across `/model` changes), or `judgeModel` in `<agentDir>/pi-stats.json`:

```json
{ "judgeModel": "anthropic/claude-haiku-4-5" }
```

## Security

Transcripts contain code and secrets.

- Binds to loopback by default; `--host` with a non-loopback address shows a warning.
- No CORS headers. Requests whose `Host` header does not name the dashboard are refused (DNS rebinding). Every POST needs a custom header and, from a browser, a same-origin `Origin`.
- Serves only the built client and the API. Transcript reads are confined to the session directories.

## Development

```bash
npm install
npm run build       # dist/: extension, runtime, bin, sync worker, client
npm run typecheck
npm test            # builds first
```

## License

MIT. © 2026 Baylar Sadigov for the pi-stats changes. Includes code from oh-my-pi, © Mario Zechner, Can Bölük and Stencil Labs, Inc.; see [LICENSE](LICENSE).
