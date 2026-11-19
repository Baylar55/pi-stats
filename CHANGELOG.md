# Changelog

## [Unreleased]

## [0.1.0] - 2026-11-17

### Added

- `/stats` command: starts or reuses a local dashboard of AI usage statistics and opens it in the system browser.
- `pi-stats` bin with `--port`, `--host`, `--summary`, `--json` and `--range` (window of `--summary`/`--json`, default 24h).
- Dashboard pages: Overview, Models, Providers, Costs, Requests, Errors, Traces, Tools, Frustration and Projects, ported from oh-my-pi's `/stats`.
- Incremental ingest of pi session transcripts into `<agentDir>/stats.db`, with live updates while pi writes.
- Time to first token measured live per request; request duration read from transcripts.
- API-equivalent cost estimates for subscription and OAuth usage from pi's model registry.
- Optional LLM judge for the Frustration page, run on demand through the session's models.
- Type declarations for the programmatic API in `dist/types`.
- Malformed transcript lines are skipped and logged to `<agentDir>/pi-stats.log`.
