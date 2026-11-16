import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ChunkedInsert } from "./chunked-insert";
import { getStatsDbPath } from "./config";
import type { ParseSessionResult, SessionParserState } from "./parser";
import { createRateLookup, type EstimatedCost, estimateCost, type ModelRates, type UsageCost, uncachedInputCost } from "./pricing";
import { ensureRollupSchema, getDailyActivityFromRollup } from "./rollup";
import { Database } from "./sqlite";
import type {
	AgentType,
	DailyActivityPoint,
	FrustrationCounts,
	MessageStats,
	MessageStatsInput,
	ToolCallStats,
	ToolResultLink,
	UserMessageLink,
	UserMessageStats,
} from "./types";

/**
 * Predicate counting one stored request as "unpriced" — no provider has a
 * public price for its model, so its zero is unknown spend rather than free
 * usage. `cost_unpriced = 1` is set by `insertMessageStats` (and kept current
 * by `setModelPrices`) when a request that used tokens recorded no cost and
 * the rate card prices neither its model nor a pricing peer.
 *
 * Nothing else sets the marker: a recorded cost, an estimate from the rate
 * card, and a request that used no tokens keep `cost_unpriced = 0`.
 * `prefix` qualifies the columns for queries that alias `messages`.
 */
export function unpricedRequestSql(prefix = ""): string {
	return `CASE WHEN ${prefix}total_tokens > 0 AND ${prefix}cost_total = 0
		AND ${prefix}cost_unpriced = 1 THEN 1 ELSE 0 END`;
}

let db: Database | null = null;

/** The open stats database, or null before {@link initDb}. Used by the rollup query layer. */
export function currentDb(): Database | null {
	return db;
}

const BACKFILL_COMPLETE = "complete";
const FORK_DEDUPE_KEY = "fork_dedupe_v1";

// A live timing fills what the transcript lacks: pi records no time to first
// token, and only newer messages carry `durationMs`.
const TIMING_TTFT = (ttft: string) => `COALESCE(${ttft}, ttft)`;
const TIMING_DURATION = (duration: string) => `COALESCE(duration, ${duration})`;
const TIMING_OF_NEW_MESSAGE = "FROM timings t WHERE t.session_file = NEW.session_file AND t.entry_id = NEW.entry_id";
/** `AFTER INSERT/UPDATE ON timings` body: carry the timing onto its message, if that is stored and changes. */
const APPLY_TIMING_TO_MESSAGE = `
	UPDATE messages
	SET ttft = ${TIMING_TTFT("NEW.first_token_at - NEW.request_start")},
		duration = ${TIMING_DURATION("NEW.end_at - NEW.request_start")}
	WHERE session_file = NEW.session_file AND entry_id = NEW.entry_id
		AND (duration IS NULL OR ttft IS NOT ${TIMING_TTFT("NEW.first_token_at - NEW.request_start")});`;

/**
 * Initialize the database and create tables.
 */
export async function initDb(): Promise<Database> {
	if (db) return db;

	// Ensure directory exists
	await fs.mkdir(path.dirname(getStatsDbPath()), { recursive: true });
	// A concurrent caller may have opened the database while this one awaited.
	if (db) return db;

	db = new Database(getStatsDbPath());
	// Install the busy handler BEFORE any lock-taking statement. See
	// https://github.com/can1357/oh-my-pi/issues/2421.
	db.run("PRAGMA busy_timeout = 5000");
	db.run("PRAGMA journal_mode = WAL");
	// The database is a derived cache of the transcripts, so WAL's NORMAL sync
	// (fsync only at checkpoints) is safe: a crash can drop the newest batches,
	// which the next sync re-ingests from their unchanged cursors. Rarer, larger
	// checkpoints cut the F_FULLFSYNC stalls macOS pays per checkpoint. The
	// statement journal and temp b-tree every trigger-carrying insert opens stay
	// in memory instead of a temp file, and a 64 MiB page cache (default 8 MiB)
	// keeps more index pages of a multi-GB database resident between batches.
	db.run("PRAGMA synchronous = NORMAL");
	db.run("PRAGMA temp_store = MEMORY");
	db.run("PRAGMA cache_size = -65536");
	db.run("PRAGMA wal_autocheckpoint = 16384");

	// Create tables
	db.run(`
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			api TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			duration INTEGER,
			ttft INTEGER,
			stop_reason TEXT NOT NULL,
			error_message TEXT,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_tokens INTEGER NOT NULL,
			cache_write_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			premium_requests REAL NOT NULL DEFAULT 0,
			cost_input REAL NOT NULL,
			cost_output REAL NOT NULL,
			cost_cache_read REAL NOT NULL,
			cost_cache_write REAL NOT NULL,
			cost_total REAL NOT NULL,
			cost_no_cache_input REAL,
			cost_unpriced INTEGER NOT NULL DEFAULT 0,
			agent_type TEXT NOT NULL DEFAULT 'main',
			service_tier TEXT,
			-- The cost columns come from the rate card (1) or the transcript (0); only the former are re-priced.
			cost_estimated INTEGER NOT NULL DEFAULT 0,
			-- 1-hour subset of cache_write_tokens, billed at its own rate.
			cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
			UNIQUE(session_file, entry_id)
		);

		-- Fork-guard identity lookups key on (entry_id, timestamp). Time-first
		-- keeps one transcript's rows in a few neighbouring leaves; entry-first
		-- scattered every insert, delete and lookup across the whole index. The
		-- composite also serves every timestamp range scan.
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_entry ON messages(timestamp, entry_id);
		-- Re-pricing walks one (model, provider) at a time.
		CREATE INDEX IF NOT EXISTS idx_messages_model_provider ON messages(model, provider);
		CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder);
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_model_provider ON messages(timestamp, model, provider);
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_folder ON messages(timestamp, folder);
		CREATE INDEX IF NOT EXISTS idx_messages_stop_reason_timestamp ON messages(stop_reason, timestamp);
		CREATE INDEX IF NOT EXISTS idx_messages_timestamp_agent_type ON messages(timestamp, agent_type);

		CREATE TABLE IF NOT EXISTS file_offsets (
			session_file TEXT PRIMARY KEY,
			offset INTEGER NOT NULL,
			last_modified INTEGER NOT NULL,
			parser_state TEXT
		);

		CREATE TABLE IF NOT EXISTS user_messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			model TEXT,
			provider TEXT,
			chars INTEGER NOT NULL,
			words INTEGER NOT NULL,
			yelling INTEGER NOT NULL,
			profanity INTEGER NOT NULL,
			anguish INTEGER NOT NULL,
			negation INTEGER NOT NULL DEFAULT 0,
			repetition INTEGER NOT NULL DEFAULT 0,
			blame INTEGER NOT NULL DEFAULT 0,
			prose TEXT NOT NULL DEFAULT '',
			prose_hash TEXT NOT NULL DEFAULT '',
			UNIQUE(session_file, entry_id)
		);

		CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp_entry ON user_messages(timestamp, entry_id);
		CREATE INDEX IF NOT EXISTS idx_user_messages_timestamp_model ON user_messages(timestamp, model, provider);
		CREATE INDEX IF NOT EXISTS idx_user_messages_prose_hash ON user_messages(prose_hash);

		-- Judge verdicts keyed by prose hash: identical messages share one verdict,
		-- and verdicts outlive user_messages re-parses. No backfill wipes this table.
		CREATE TABLE IF NOT EXISTS frustration_verdicts (
			prose_hash TEXT PRIMARY KEY,
			p_annoyed REAL NOT NULL,
			p_angry REAL NOT NULL,
			target TEXT NOT NULL,
			judge TEXT NOT NULL,
			judged_at INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS tool_calls (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			tool_call_id TEXT NOT NULL,
			folder TEXT NOT NULL,
			tool_name TEXT NOT NULL,
			model TEXT NOT NULL,
			provider TEXT NOT NULL,
			timestamp INTEGER NOT NULL,
			agent_type TEXT NOT NULL DEFAULT 'main',
			calls_in_turn INTEGER NOT NULL DEFAULT 1,
			args_chars INTEGER NOT NULL DEFAULT 0,
			result_chars INTEGER,
			is_error INTEGER,
			UNIQUE(session_file, tool_call_id)
		);

		CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp_entry ON tool_calls(timestamp, entry_id);
		CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_timestamp ON tool_calls(tool_name, timestamp);

		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		-- Request timings the pi extension measures live (epoch ms), keyed like the
		-- message they belong to. They outlive re-parses of their transcript.
		CREATE TABLE IF NOT EXISTS timings (
			session_file TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			request_start INTEGER NOT NULL,
			first_token_at INTEGER,
			end_at INTEGER NOT NULL,
			PRIMARY KEY (session_file, entry_id)
		) WITHOUT ROWID;

		-- A timing and its message arrive in either order (and a rebuilt file
		-- re-inserts its messages), so each side applies the timing when it lands.
		-- The message update fires the rollup triggers like any other change.
		CREATE TRIGGER IF NOT EXISTS timings_insert_apply AFTER INSERT ON timings BEGIN${APPLY_TIMING_TO_MESSAGE}
		END;
		CREATE TRIGGER IF NOT EXISTS timings_update_apply AFTER UPDATE ON timings BEGIN${APPLY_TIMING_TO_MESSAGE}
		END;
		CREATE TRIGGER IF NOT EXISTS timings_message_insert_apply AFTER INSERT ON messages BEGIN
			UPDATE messages
			SET ttft = ${TIMING_TTFT(`(SELECT t.first_token_at - t.request_start ${TIMING_OF_NEW_MESSAGE})`)},
				duration = ${TIMING_DURATION(`(SELECT t.end_at - t.request_start ${TIMING_OF_NEW_MESSAGE})`)}
			WHERE id = NEW.id AND EXISTS (SELECT 1 ${TIMING_OF_NEW_MESSAGE});
		END;

		-- The rate card (USD per 1M tokens), replaced as a whole by setModelPrices.
		-- Model-first key: a pricing-peer lookup scans one model's providers.
		CREATE TABLE IF NOT EXISTS model_prices (
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			input REAL NOT NULL,
			output REAL NOT NULL,
			cache_read REAL NOT NULL,
			cache_write REAL NOT NULL,
			tiers TEXT,
			PRIMARY KEY (model, provider)
		) WITHOUT ROWID;
	`);

	backfillForkDuplicates(db);
	ensureRollupSchema(db);
	return db;
}

function normalizeUsageCost(cost: Partial<UsageCost>): UsageCost {
	const input = cost.input ?? 0;
	const output = cost.output ?? 0;
	const cacheRead = cost.cacheRead ?? 0;
	const cacheWrite = cost.cacheWrite ?? 0;
	const total = cost.total ?? input + output + cacheRead + cacheWrite;
	return { input, output, cacheRead, cacheWrite, total };
}

function resolveStoredCost(stats: MessageStatsInput, rates: ModelRates | null): EstimatedCost {
	// `usage.cost` is absent when the session entry recorded no price at all, and
	// legacy payloads can carry a partially-populated cost object (e.g. only
	// `total`). The messages table declares every cost_* column as REAL NOT NULL,
	// so any missing field must be normalised here before binding into SQLite.
	const raw: Partial<UsageCost> | undefined = stats.usage.cost;
	if (raw) {
		const storedCost = normalizeUsageCost(raw);
		// A recorded charge is what the request cost when it ran; keep it as is.
		if (Number.isFinite(storedCost.total) && storedCost.total > 0) {
			return { cost: storedCost, unpriced: false, estimated: false };
		}
	}
	// pi records zero for subscription and OAuth usage: price it at the public
	// rate of the same model, or mark it unpriced when no provider has one.
	return estimateCost(rates, stats.usage, stats.usage.totalTokens);
}

/** Timing the pi extension measured for one assistant request (epoch ms). */
export interface RequestTiming {
	requestStart: number;
	/** Null when the response ended before any token arrived. */
	firstTokenAt: number | null;
	endAt: number;
}

/**
 * Store (or replace) a live request timing. The triggers in {@link initDb}
 * copy it onto the request's `messages` row, now or when that row is ingested.
 * `sessionFile` must be the path the sync stores as `session_file`.
 */
export function recordTiming(t: {
	sessionFile: string;
	entryId: string;
	requestStart: number;
	firstTokenAt: number | null;
	endAt: number;
}): void {
	if (!db) return;
	db.query(`
		INSERT INTO timings (session_file, entry_id, request_start, first_token_at, end_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(session_file, entry_id) DO UPDATE SET
			request_start = excluded.request_start,
			first_token_at = excluded.first_token_at,
			end_at = excluded.end_at
	`).run(t.sessionFile, t.entryId, t.requestStart, t.firstTokenAt, t.endAt);
}

/** Live timings recorded for one transcript, by entry id. */
export function getSessionTimings(sessionFile: string): Map<string, RequestTiming> {
	const timings = new Map<string, RequestTiming>();
	if (!db) return timings;
	const rows = db
		.query<{ entry_id: string; request_start: number; first_token_at: number | null; end_at: number }>(
			"SELECT entry_id, request_start, first_token_at, end_at FROM timings WHERE session_file = ?",
		)
		.all(sessionFile);
	for (const row of rows) {
		timings.set(row.entry_id, {
			requestStart: row.request_start,
			firstTokenAt: row.first_token_at,
			endAt: row.end_at,
		});
	}
	return timings;
}

/** Read one `meta` value, or null when the key is absent (or before {@link initDb}). */
export function getMetaValue(key: string): string | null {
	return db?.query<{ value: string }>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMetaValue(key: string, value: string): void {
	db?.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}


/** Persisted transcript identity and parser cursor used to resume stats ingestion. */
export interface FileOffset {
	offset: number;
	lastModified: number;
	parserState?: SessionParserState;
}

interface FileOffsetRow {
	session_file: string;
	offset: number;
	last_modified: number;
	parser_state: string | null;
}

function decodeFileOffset(row: FileOffsetRow): FileOffset {
	let parserState: SessionParserState | undefined;
	if (row.parser_state) {
		try {
			const state: SessionParserState = JSON.parse(row.parser_state);
			if (state?.version === 1 && state.offset === row.offset) parserState = state;
		} catch {
			/* A missing cursor is reconstructed from the transcript. */
		}
	}
	return { offset: row.offset, lastModified: row.last_modified, parserState };
}

/** Read one persisted cursor for callers inspecting an individual transcript. */
export function getFileOffset(sessionFile: string): FileOffset | null {
	if (!db) return null;
	const row = db
		.query<FileOffsetRow, [string]>(
			"SELECT session_file, offset, last_modified, parser_state FROM file_offsets WHERE session_file = ?",
		)
		.get(sessionFile);
	return row ? decodeFileOffset(row) : null;
}

/** Read a bounded sync work set's cursors with one SQLite snapshot instead of one lookup per file. */
export function getFileOffsets(sessionFiles: string[]): Map<string, FileOffset> {
	const offsets = new Map<string, FileOffset>();
	if (!db || sessionFiles.length === 0) return offsets;
	const placeholders = sessionFiles.map(() => "?").join(",");
	const rows = db
		.query<FileOffsetRow, string[]>(
			`SELECT session_file, offset, last_modified, parser_state FROM file_offsets WHERE session_file IN (${placeholders})`,
		)
		.all(...sessionFiles);
	for (const row of rows) offsets.set(row.session_file, decodeFileOffset(row));
	return offsets;
}

/**
 * Update the stored offset for a session file.
 */
export function setFileOffset(
	sessionFile: string,
	offset: number,
	lastModified: number,
	parserState?: SessionParserState,
): void {
	if (!db) return;

	const stmt = db.query(`
		INSERT OR REPLACE INTO file_offsets (session_file, offset, last_modified, parser_state)
		VALUES (?, ?, ?, ?)
	`);
	stmt.run(sessionFile, offset, lastModified, parserState ? JSON.stringify(parserState) : null);
}

/**
 * Run `fn` atomically: inline when the caller already holds a transaction,
 * otherwise in a fresh one. Nesting `db.transaction` would open a savepoint,
 * which copies every page the batch touches into the statement journal; each
 * statement end then rewinds that ever-growing journal, so a long batch
 * degrades quadratically.
 */
function atomically<T>(database: Database, fn: () => T): T {
	return database.inTransaction ? fn() : database.transaction(fn)();
}

/** Parsed transcript queued by the sync loop for an atomic database batch. */
export interface ParsedSession {
	sessionFile: string;
	result: ParseSessionResult;
	rebuild: boolean;
	/** Recover missing rows from a full-history scan without rewriting unchanged records. */
	replay: boolean;
}

function* parsedRows<T>(
	results: ParseSessionResult[],
	select: (result: ParseSessionResult) => Iterable<T>,
): Generator<T> {
	for (const result of results) yield* select(result);
}

/**
 * Commit distinct transcripts' rows, reconciliation state, and cursors together; failure rolls back the batch.
 * `changes` counts stored rows inserted, updated or deleted (cursor bookkeeping excluded), so callers can
 * tell a batch that changed nothing.
 */
export function applySessionParseResults(sessions: ParsedSession[]): {
	processed: number;
	files: number;
	reconcile: boolean;
	changes: number;
} {
	if (!db) return { processed: 0, files: 0, reconcile: false, changes: 0 };
	const database = db;
	return database.transaction(() => {
		let processed = 0;
		let files = 0;
		let reconcile = false;
		let changes = 0;
		const writes: ParseSessionResult[] = [];
		for (const { sessionFile, result, rebuild, replay } of sessions) {
			const parserState = result.parserState;
			if (!parserState) continue;
			let rows = result;
			if (result.reset || rebuild || replay) {
				const messages = database
					.query<{ entry_id: string; timestamp: number }, [string]>(
						"SELECT entry_id, timestamp FROM messages WHERE session_file = ?",
					)
					.all(sessionFile);
				const users = database
					.query<{ entry_id: string; timestamp: number; model: string | null }, [string]>(
						"SELECT entry_id, timestamp, model FROM user_messages WHERE session_file = ?",
					)
					.all(sessionFile);
				const tools = database
					.query<
						{ entry_id: string; timestamp: number; tool_call_id: string; result_chars: number | null },
						[string]
					>("SELECT entry_id, timestamp, tool_call_id, result_chars FROM tool_calls WHERE session_file = ?")
					.all(sessionFile);
				const replace = result.reset || rebuild;
				if (replace) {
					// Only removed owners require another full replay, not an identity-only file replacement.
					if (!reconcile && (messages.length > 0 || users.length > 0 || tools.length > 0)) {
						const retainedMessages = new Set(
							result.stats.map(row => JSON.stringify([row.entryId, row.timestamp])),
						);
						const retainedUsers = new Set(
							result.userStats.map(row => JSON.stringify([row.entryId, row.timestamp])),
						);
						const retainedTools = new Set(
							result.toolCalls.map(row => JSON.stringify([row.entryId, row.timestamp, row.toolCallId])),
						);
						reconcile =
							messages.some(row => !retainedMessages.has(JSON.stringify([row.entry_id, row.timestamp]))) ||
							users.some(row => !retainedUsers.has(JSON.stringify([row.entry_id, row.timestamp]))) ||
							tools.some(
								row => !retainedTools.has(JSON.stringify([row.entry_id, row.timestamp, row.tool_call_id])),
							);
					}
				} else {
					// A reconciliation replay only needs missing rows and unfinished links. Keep stable request
					// IDs and avoid rewriting every table/index for transcripts whose contents did not change.
					const messageById = new Map(messages.map(row => [row.entry_id, row.timestamp]));
					const userById = new Map(users.map(row => [row.entry_id, row]));
					const toolById = new Map(tools.map(row => [row.tool_call_id, row]));
					const absentMessages = new Set(messageById.keys());
					const absentUsers = new Set(userById.keys());
					const absentTools = new Set(toolById.keys());
					const stats = result.stats.filter(row => {
						if (messageById.get(row.entryId) !== row.timestamp) return true;
						absentMessages.delete(row.entryId);
						return false;
					});
					const userStats = result.userStats.filter(row => {
						if (userById.get(row.entryId)?.timestamp !== row.timestamp) return true;
						absentUsers.delete(row.entryId);
						return false;
					});
					const toolCalls = result.toolCalls.filter(row => {
						const stored = toolById.get(row.toolCallId);
						if (stored?.entry_id !== row.entryId || stored.timestamp !== row.timestamp) return true;
						absentTools.delete(row.toolCallId);
						return false;
					});
					rows = {
						...result,
						stats,
						userStats,
						toolCalls,
						// A reused ID needs fresh linkage after its old identity is removed.
						userLinks: result.userLinks.filter(
							row => absentUsers.has(row.entryId) || userById.get(row.entryId)?.model == null,
						),
						toolResults: result.toolResults.filter(
							row => absentTools.has(row.toolCallId) || toolById.get(row.toolCallId)?.result_chars == null,
						),
					};
					// Repair stale owners without invalidating IDs of records still present in the transcript.
					if (absentMessages.size > 0 || absentUsers.size > 0 || absentTools.size > 0) {
						reconcile = true;
						for (const id of absentMessages) {
							changes += database
								.query("DELETE FROM messages WHERE session_file = ? AND entry_id = ?")
								.run(sessionFile, id).changes;
						}
						for (const id of absentUsers) {
							changes += database
								.query("DELETE FROM user_messages WHERE session_file = ? AND entry_id = ?")
								.run(sessionFile, id).changes;
						}
						for (const id of absentTools) {
							changes += database
								.query("DELETE FROM tool_calls WHERE session_file = ? AND tool_call_id = ?")
								.run(sessionFile, id).changes;
						}
					}
				}
				if (replace) {
					if (messages.length > 0) {
						changes += database.query("DELETE FROM messages WHERE session_file = ?").run(sessionFile).changes;
					}
					if (users.length > 0) {
						changes += database
							.query("DELETE FROM user_messages WHERE session_file = ?")
							.run(sessionFile).changes;
					}
					if (tools.length > 0) {
						changes += database.query("DELETE FROM tool_calls WHERE session_file = ?").run(sessionFile).changes;
					}
				}
			}
			writes.push(rows);
			const count = rows.stats.length + rows.userStats.length;
			processed += count;
			if (count > 0) files++;
		}
		// Remove replaced rows before choosing new fork owners, then write each table once per batch.
		changes +=
			insertMessageStats(parsedRows(writes, result => result.stats)) +
			insertUserMessageStats(parsedRows(writes, result => result.userStats)) +
			updateUserMessageLinks(parsedRows(writes, result => result.userLinks)) +
			insertToolCalls(parsedRows(writes, result => result.toolCalls)) +
			updateToolResults(parsedRows(writes, result => result.toolResults));
		for (const { sessionFile, result } of sessions) {
			if (result.parserState) {
				setFileOffset(sessionFile, result.newOffset, result.parserState.mtimeMs, result.parserState);
			}
		}
		if (reconcile) {
			database.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('session_reconciliation', 'pending')").run();
		}
		return { processed, files, reconcile, changes };
	})();
}

/**
 * SQLite `PRAGMA data_version` of the open connection, or null before
 * {@link initDb}. It moves only when another connection (another pi process)
 * commits, so a caller can detect foreign writes without scanning.
 */
export function getDataVersion(): number | null {
	if (!db) return null;
	return db.query<{ data_version: number }, []>("PRAGMA data_version").get()?.data_version ?? null;
}

export function prepareSessionSync(): boolean {
	return Boolean(db?.query("SELECT 1 FROM meta WHERE key = 'session_reconciliation'").get());
}

export function completeSessionSync(reconcile: boolean): void {
	if (!reconcile) db?.query("DELETE FROM meta WHERE key = 'session_reconciliation'").run();
}

/**
 * Insert message stats into the database.
 *
 * Forked / branched sessions (see `SessionManager.forkFrom()` and
 * `createBranchedSession()` in `@earendil-works/pi-coding-agent`) copy a parent
 * session's entries into a new JSONL — same `entry_id`, `timestamp`, `model`,
 * `provider` and token counts. The `UNIQUE(session_file, entry_id)`
 * constraint alone keys each row by file, so without the guard
 * below the same provider request would land twice and inflate every
 * aggregate. The {@link ChunkedInsert} fork guard skips inserts whose
 * `(entry_id, timestamp)` already exists under a different `session_file` —
 * first-write-wins across the lineage. Same-file re-syncs still hit the
 * `ON CONFLICT(session_file, entry_id)` upsert below, which re-derives the
 * stored cost from the current rate card.
 */
export function insertMessageStats(stats: Iterable<MessageStatsInput>): number {
	if (!db) return 0;
	const writer = new ChunkedInsert(db, {
		verb: "INSERT",
		table: "messages",
		columns: [
			"session_file",
			"entry_id",
			"folder",
			"model",
			"provider",
			"api",
			"timestamp",
			"duration",
			"ttft",
			"stop_reason",
			"error_message",
			"input_tokens",
			"output_tokens",
			"cache_read_tokens",
			"cache_write_tokens",
			"cache_write_1h_tokens",
			"total_tokens",
			"cost_input",
			"cost_output",
			"cost_cache_read",
			"cost_cache_write",
			"cost_total",
			"cost_no_cache_input",
			"cost_unpriced",
			"cost_estimated",
			"agent_type",
		],
		identity: ["entry_id", "timestamp"],
		upsert: `ON CONFLICT(session_file, entry_id) DO UPDATE SET
			cost_input = excluded.cost_input,
			cost_output = excluded.cost_output,
			cost_cache_read = excluded.cost_cache_read,
			cost_cache_write = excluded.cost_cache_write,
			cost_total = excluded.cost_total,
			cost_no_cache_input = excluded.cost_no_cache_input,
			cost_unpriced = excluded.cost_unpriced,
			cost_estimated = excluded.cost_estimated`,
	});
	const ratesOf = createRateLookup(db);
	return atomically(db, () => {
		for (const s of stats) {
			const rates = ratesOf(s.provider, s.model);
			const { cost, unpriced, estimated } = resolveStoredCost(s, rates);
			writer.add(
				s.sessionFile,
				[s.entryId, s.timestamp],
				[
					s.sessionFile,
					s.entryId,
					s.folder,
					s.model,
					s.provider,
					s.api,
					s.timestamp,
					s.duration,
					s.ttft,
					s.stopReason,
					s.errorMessage,
					s.usage.input,
					s.usage.output,
					s.usage.cacheRead,
					s.usage.cacheWrite,
					s.usage.cacheWrite1h ?? 0,
					s.usage.totalTokens,
					cost.input,
					cost.output,
					cost.cacheRead,
					cost.cacheWrite,
					cost.total,
					uncachedInputCost(rates, s.usage),
					unpriced ? 1 : 0,
					estimated ? 1 : 0,
					s.agentType,
				],
			);
		}
		return writer.finish();
	});
}

/**
 * Get total message count.
 */
export function getMessageCount(): number {
	if (!db) return 0;
	const stmt = db.query("SELECT COUNT(*) as count FROM messages");
	const row = stmt.get() as { count: number };
	return row.count;
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
	if (db) {
		db.close();
		db = null;
	}
}

interface MessageRow {
	id: number;
	session_file: string;
	entry_id: string;
	folder: string;
	model: string;
	provider: string;
	api: string;
	timestamp: number;
	duration: number | null;
	ttft: number | null;
	stop_reason: MessageStats["stopReason"];
	error_message: string | null;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
	cost_input: number;
	cost_output: number;
	cost_cache_read: number;
	cost_cache_write: number;
	cost_total: number;
	cost_unpriced: number;
	agent_type: AgentType;
}

function rowToMessageStats(row: MessageRow): MessageStats {
	return {
		id: row.id,
		sessionFile: row.session_file,
		entryId: row.entry_id,
		folder: row.folder,
		model: row.model,
		provider: row.provider,
		api: row.api,
		timestamp: row.timestamp,
		duration: row.duration,
		ttft: row.ttft,
		stopReason: row.stop_reason,
		errorMessage: row.error_message,
		usage: {
			input: row.input_tokens,
			output: row.output_tokens,
			cacheRead: row.cache_read_tokens,
			cacheWrite: row.cache_write_tokens,
			totalTokens: row.total_tokens,
			cost: {
				input: row.cost_input,
				output: row.cost_output,
				cacheRead: row.cost_cache_read,
				cacheWrite: row.cost_cache_write,
				total: row.cost_total,
			},
		},
		agentType: row.agent_type,
		costUnpriced: row.cost_unpriced === 1,
	};
}

export function getRecentRequests(limit = 100): MessageStats[] {
	if (!db) return [];
	const stmt = db.query<MessageRow>(`
		SELECT * FROM messages 
		ORDER BY timestamp DESC 
		LIMIT ?
	`);
	return stmt.all(limit).map(rowToMessageStats);
}

export function getRecentErrors(limit = 100, cutoff?: number | null): MessageStats[] {
	if (!db) return [];
	const hasCutoff = cutoff !== undefined && cutoff !== null;
	const stmt = db.query<MessageRow>(`
		SELECT * FROM messages
		WHERE stop_reason = 'error'
		${hasCutoff ? "AND timestamp >= ?" : ""}
		ORDER BY timestamp DESC
		LIMIT ?
	`);
	const rows = hasCutoff ? stmt.all(cutoff, limit) : stmt.all(limit);
	return rows.map(rowToMessageStats);
}

export function getMessageById(id: number): MessageStats | null {
	if (!db) return null;
	const stmt = db.query<MessageRow>("SELECT * FROM messages WHERE id = ?");
	const row = stmt.get(id);
	return row ? rowToMessageStats(row) : null;
}

/**
 * Per-local-day activity aggregates for the last `days` days, oldest first.
 * Self-initializing (opens the stats DB on first use) so a caller can query
 * without the dashboard server's init flow. Days use the machine's
 * timezone — this is a localhost tool, same rationale as
 * {@link getProviderHourlyBurn}. Reads the hourly rollup, falling back to the
 * raw rows while its rebuild backlog is too large for exact reads.
 */
export async function getDailyActivity(days = 371): Promise<DailyActivityPoint[]> {
	const database = await initDb();
	const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
	const rolled = getDailyActivityFromRollup(cutoff);
	if (rolled) return rolled;
	const stmt = database.query(`
		SELECT
			date(timestamp / 1000, 'unixepoch', 'localtime') as day,
			SUM(cost_total) as cost,
			COUNT(*) as requests,
			SUM(total_tokens) as total_tokens
		FROM messages
		WHERE timestamp >= ?
		GROUP BY day
		ORDER BY day ASC
	`);
	const rows = stmt.all(cutoff) as Array<{
		day: string;
		cost: number | null;
		requests: number;
		total_tokens: number | null;
	}>;
	return rows.map(row => ({
		day: row.day,
		cost: row.cost ?? 0,
		requests: row.requests,
		totalTokens: row.total_tokens ?? 0,
	}));
}

/**
 * One-shot collapse of forked-session duplicates stored without the fork
 * guard, under the `UNIQUE(session_file, entry_id)`-only invariant.
 * `SessionManager.forkFrom()` and `createBranchedSession()` copy a parent's
 * entries into the new JSONL — same `entry_id`, `timestamp`, `model`, token
 * counts, cost — and an unguarded insert counts both files toward request /
 * token / cost totals. The migration keeps the lowest-`id` row per
 * `(entry_id, timestamp)` group and drops every other copy. Same fix on
 * `user_messages` since forks copy user entries too. Idempotent and
 * crash-safe: enrolled through the `meta` sentinel, marked
 * COMPLETE inside the same transaction so an aborted run rolls back and
 * retries on the next init.
 */
function backfillForkDuplicates(database: Database): void {
	const row = database.query<{ value: string }>("SELECT value FROM meta WHERE key = ?").get(FORK_DEDUPE_KEY);
	if (row?.value === BACKFILL_COMPLETE) return;

	const markComplete = database.query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
	const apply = database.transaction(() => {
		database.run(`
			DELETE FROM messages
			WHERE id NOT IN (
				SELECT MIN(id) FROM messages GROUP BY entry_id, timestamp
			)
		`);
		database.run(`
			DELETE FROM user_messages
			WHERE id NOT IN (
				SELECT MIN(id) FROM user_messages GROUP BY entry_id, timestamp
			)
		`);
		markComplete.run(FORK_DEDUPE_KEY, BACKFILL_COMPLETE);
	});
	apply();
}

/**
 * Insert user-message stats. Idempotent via UNIQUE(session_file, entry_id).
 * The fork guard matches {@link insertMessageStats}: forks copy user entries
 * verbatim into the child JSONL, so the same `(entry_id, timestamp)` must not
 * land twice across different session files.
 */
export function insertUserMessageStats(stats: Iterable<UserMessageStats>): number {
	if (!db) return 0;
	const writer = new ChunkedInsert(db, {
		verb: "INSERT OR IGNORE",
		table: "user_messages",
		columns: [
			"session_file",
			"entry_id",
			"folder",
			"timestamp",
			"model",
			"provider",
			"chars",
			"words",
			"yelling",
			"profanity",
			"anguish",
			"negation",
			"repetition",
			"blame",
			"prose",
			"prose_hash",
		],
		identity: ["entry_id", "timestamp"],
	});
	return atomically(db, () => {
		for (const s of stats) {
			writer.add(
				s.sessionFile,
				[s.entryId, s.timestamp],
				[
					s.sessionFile,
					s.entryId,
					s.folder,
					s.timestamp,
					s.model,
					s.provider,
					s.chars,
					s.words,
					s.yelling,
					s.profanity,
					s.anguish,
					s.negation,
					s.repetition,
					s.blame,
					s.prose,
					s.proseHash,
				],
			);
		}
		return writer.finish();
	});
}

/**
 * Backfill the responding `model`/`provider` on user-message rows that were
 * persisted before their assistant reply was parsed by an incremental tail
 * read. Each row is updated at most once because the `model IS NULL` guard
 * short-circuits subsequent passes.
 *
 * Returns the number of rows actually updated.
 */
export function updateUserMessageLinks(links: Iterable<UserMessageLink>): number {
	if (!db) return 0;

	const stmt = db.query(`
		UPDATE user_messages
		   SET model = ?, provider = ?
		 WHERE session_file = ? AND entry_id = ? AND model IS NULL
	`);

	let updated = 0;
	atomically(db, () => {
		for (const link of links) {
			const result = stmt.run(link.model, link.provider, link.sessionFile, link.entryId);
			if (result.changes > 0) updated++;
		}
	});
	return updated;
}

/** Frustration tallies of one responding (model, provider) pair, before identity merging. */
export interface FrustrationModelRow extends FrustrationCounts {
	model: string;
	provider: string | null;
	/** Earliest message timestamp (ms) in range. */
	firstSeen: number;
}

/** One unique unjudged prose text: identical messages share a hash and one verdict. */
export interface PendingProse {
	hash: string;
	prose: string;
}

/** Cached judge verdict for one prose hash. */
export interface FrustrationVerdict {
	proseHash: string;
	/** P(clearly annoyed) + P(angry) on the `annoyed` score question. */
	pAnnoyed: number;
	/** P(angry, hostile, or swearing). */
	pAngry: number;
	/** Most likely `target` choice: `assistant`, `other`, or `none`. */
	target: string;
	/** `provider/model` that produced the verdict. */
	judge: string;
	judgedAt: number;
}

interface FrustrationCountsRow {
	messages: number;
	judged: number;
	annoyed: number;
	at_assistant: number;
	angry: number;
}

interface FrustrationModelSqlRow extends FrustrationCountsRow {
	model: string;
	provider: string | null;
	first_seen: number;
}

// Each message is classified once: by its cached verdict when `v` joined,
// else by the regex signals stored at ingest. Keep in sync with the rules
// documented on `FrustrationCounts` / `frustration.ts`.
const JUDGED_SQL = "v.prose_hash IS NOT NULL";
const JUDGED_ANNOYED_SQL = "v.p_annoyed >= 0.5";
const JUDGED_AT_ASSISTANT_SQL = `${JUDGED_ANNOYED_SQL} AND v.target = 'assistant'`;
const REGEX_AT_ASSISTANT_SQL = "u.negation + u.repetition + u.blame > 0";
const FRUSTRATION_COUNTS_SQL = `
	COUNT(*) AS messages,
	COALESCE(SUM(${JUDGED_SQL}), 0) AS judged,
	COALESCE(SUM(CASE WHEN ${JUDGED_SQL} THEN ${JUDGED_ANNOYED_SQL}
		ELSE u.yelling + u.profanity + u.anguish + u.negation + u.repetition + u.blame > 0 END), 0) AS annoyed,
	COALESCE(SUM(CASE WHEN ${JUDGED_SQL} THEN ${JUDGED_AT_ASSISTANT_SQL}
		ELSE ${REGEX_AT_ASSISTANT_SQL} END), 0) AS at_assistant,
	COALESCE(SUM(CASE WHEN ${JUDGED_SQL} THEN ${JUDGED_AT_ASSISTANT_SQL} AND v.p_angry >= 0.5
		ELSE ${REGEX_AT_ASSISTANT_SQL} AND (u.profanity > 0 OR u.yelling > 0) END), 0) AS angry
`;

function hasRangeCutoff(cutoff: number | null | undefined): cutoff is number {
	return cutoff !== null && cutoff !== undefined && cutoff > 0;
}

function toFrustrationCounts(row: FrustrationCountsRow | undefined): FrustrationCounts {
	return {
		messages: row?.messages ?? 0,
		judged: row?.judged ?? 0,
		annoyed: row?.annoyed ?? 0,
		atAssistant: row?.at_assistant ?? 0,
		angry: row?.angry ?? 0,
	};
}

/** Frustration tallies over every user message with prose in range, linked to a model or not. */
export function getFrustrationOverall(cutoff?: number | null): FrustrationCounts {
	if (!db) return toFrustrationCounts(undefined);
	const hasCutoff = hasRangeCutoff(cutoff);
	const stmt = db.query(`
		SELECT ${FRUSTRATION_COUNTS_SQL}
		FROM user_messages u
		LEFT JOIN frustration_verdicts v ON v.prose_hash = u.prose_hash
		WHERE u.prose != ''${hasCutoff ? " AND u.timestamp >= ?" : ""}
	`);
	const row = (hasCutoff ? stmt.get(cutoff) : stmt.get()) as FrustrationCountsRow | undefined;
	return toFrustrationCounts(row);
}

/**
 * Frustration tallies per responding (model, provider) over the range. User
 * messages that never got a reply (null model) are only in the overall tally.
 */
export function getFrustrationByModel(cutoff?: number | null): FrustrationModelRow[] {
	if (!db) return [];
	const hasCutoff = hasRangeCutoff(cutoff);
	const stmt = db.query(`
		SELECT u.model AS model, u.provider AS provider, MIN(u.timestamp) AS first_seen, ${FRUSTRATION_COUNTS_SQL}
		FROM user_messages u
		LEFT JOIN frustration_verdicts v ON v.prose_hash = u.prose_hash
		WHERE u.prose != '' AND u.model IS NOT NULL${hasCutoff ? " AND u.timestamp >= ?" : ""}
		GROUP BY u.model, u.provider
	`);
	const rows = (hasCutoff ? stmt.all(cutoff) : stmt.all()) as FrustrationModelSqlRow[];
	return rows.map(row => ({
		model: row.model,
		provider: row.provider,
		firstSeen: row.first_seen,
		...toFrustrationCounts(row),
	}));
}

/** Unique unjudged prose in range, one row per prose hash. */
function pendingProseSql(hasCutoff: boolean): string {
	return `
		SELECT u.prose_hash AS hash, MIN(u.prose) AS prose
		FROM user_messages u
		WHERE u.prose != ''${hasCutoff ? " AND u.timestamp >= ?" : ""}
		  AND NOT EXISTS (SELECT 1 FROM frustration_verdicts v WHERE v.prose_hash = u.prose_hash)
		GROUP BY u.prose_hash
	`;
}

/** Unique prose texts in range that have no cached verdict yet. */
export function getPendingFrustrationProse(cutoff?: number | null): PendingProse[] {
	if (!db) return [];
	const hasCutoff = hasRangeCutoff(cutoff);
	const stmt = db.query(pendingProseSql(hasCutoff));
	return (hasCutoff ? stmt.all(cutoff) : stmt.all()) as PendingProse[];
}

/** Count and total characters of {@link getPendingFrustrationProse} without loading the text. */
export function getPendingFrustrationTotals(cutoff?: number | null): { messages: number; chars: number } {
	if (!db) return { messages: 0, chars: 0 };
	const hasCutoff = hasRangeCutoff(cutoff);
	const stmt = db.query(
		`SELECT COUNT(*) AS messages, COALESCE(SUM(LENGTH(prose)), 0) AS chars FROM (${pendingProseSql(hasCutoff)})`,
	);
	const row = (hasCutoff ? stmt.get(cutoff) : stmt.get()) as { messages: number; chars: number } | undefined;
	return { messages: row?.messages ?? 0, chars: row?.chars ?? 0 };
}

/**
 * Cache (or replace) verdicts, all in one transaction: a judge run lands
 * dozens per second, and a commit per verdict would contend with ingest for
 * the write lock every time.
 */
export function upsertFrustrationVerdicts(verdicts: readonly FrustrationVerdict[]): void {
	if (!db || verdicts.length === 0) return;
	const database = db;
	const stmt = database.query(
		`INSERT OR REPLACE INTO frustration_verdicts (prose_hash, p_annoyed, p_angry, target, judge, judged_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	database.transaction(() => {
		for (const v of verdicts) stmt.run(v.proseHash, v.pAnnoyed, v.pAngry, v.target, v.judge, v.judgedAt);
	})();
}

/**
 * Insert tool-call rows. Idempotent via UNIQUE(session_file, tool_call_id);
 * the fork guard mirrors {@link insertMessageStats}: forked
 * sessions deep-copy assistant entries (same `entry_id`, `timestamp`, and
 * tool-call ids under a new file), so first-write-wins across the lineage
 * keeps aggregates from double counting. Keyed on the assistant entry
 * identity, not the call id alone — provider call ids are not a global
 * namespace across unrelated sessions.
 */
export function insertToolCalls(calls: Iterable<ToolCallStats>): number {
	if (!db) return 0;
	const writer = new ChunkedInsert(db, {
		verb: "INSERT OR IGNORE",
		table: "tool_calls",
		columns: [
			"session_file",
			"entry_id",
			"tool_call_id",
			"folder",
			"tool_name",
			"model",
			"provider",
			"timestamp",
			"agent_type",
			"calls_in_turn",
			"args_chars",
			"result_chars",
			"is_error",
		],
		identity: ["entry_id", "timestamp", "tool_call_id"],
	});
	return atomically(db, () => {
		for (const c of calls) {
			writer.add(
				c.sessionFile,
				[c.entryId, c.timestamp, c.toolCallId],
				[
					c.sessionFile,
					c.entryId,
					c.toolCallId,
					c.folder,
					c.toolName,
					c.model,
					c.provider,
					c.timestamp,
					c.agentType,
					c.callsInTurn,
					c.argsChars,
					c.resultChars ?? null,
					c.isError === undefined ? null : c.isError ? 1 : 0,
				],
			);
		}
		return writer.finish();
	});
}

/**
 * Attach result size / error flag to persisted tool-call rows. Results can
 * land in a later incremental sync pass than the call that produced them, so
 * this is an UPDATE keyed by (session_file, tool_call_id). The `IS NULL`
 * guard makes re-syncs idempotent; rows skipped by the fork guard simply
 * never match.
 */
export function updateToolResults(links: Iterable<ToolResultLink>): number {
	if (!db) return 0;

	const stmt = db.query(`
		UPDATE tool_calls
		SET result_chars = ?, is_error = ?
		WHERE session_file = ? AND tool_call_id = ? AND result_chars IS NULL
	`);

	let updated = 0;
	atomically(db, () => {
		for (const link of links) {
			const result = stmt.run(link.resultChars, link.isError ? 1 : 0, link.sessionFile, link.toolCallId);
			updated += result.changes;
		}
	});
	return updated;
}
