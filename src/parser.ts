import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage, ToolCall, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { findSessionRoot, getSessionRoots } from "./config";
import { projectFolder } from "./projects";
import type {
	AgentType,
	MessageStatsInput,
	SessionEntry,
	SessionMessageEntry,
	SessionUsageEntry,
	ToolCallStats,
	ToolResultLink,
	UserMessageLink,
	UserMessageStats,
} from "./types";
import { computeUserMessageMetrics, judgeProse } from "./user-metrics";
import { hashHex, isEnoent } from "./util";

/** Characters a persisted tool name may consist of without sanitization. */
const TOOL_NAME_PATTERN = /^[\w.:-]+$/;

/** Provider/model/api of usage no model can be named for. */
const UNKNOWN = "unknown";

/** Characters of the first user message kept as an unnamed session's title. */
const TITLE_MAX = 80;

/**
 * Classify which agent produced a transcript from its path below its session
 * root. `<root>/<project>/<file>.jsonl` (or `<root>/<file>.jsonl` in a custom,
 * flat session dir) is the `main` agent; a transcript nested deeper belongs to
 * a `subagent`. pi core writes no nested transcripts; only extensions that
 * persist child sessions produce them.
 */
export function classifyAgentType(sessionPath: string): AgentType {
	const rel = path.relative(findSessionRoot(sessionPath), sessionPath);
	if (rel.startsWith("..")) return "main";
	return rel.split(path.sep).length <= 2 ? "main" : "subagent";
}

/**
 * Project folder from the session directory name, for transcripts whose header
 * records no `cwd`. pi names the directory `--<cwd>--` with `/`, `\` and `:`
 * replaced by `-`, which is lossy (a dash in a folder name reads as a
 * separator), so this is only the fallback: the header's `cwd` wins.
 */
export function extractFolderFromPath(sessionPath: string): string {
	const rel = path.relative(findSessionRoot(sessionPath), sessionPath);
	const projectDir = rel.split(path.sep)[0];
	const match = /^--(.*)--$/.exec(projectDir);
	if (!match) return UNKNOWN;
	const drive = /^([A-Za-z])--(.*)$/.exec(match[1]);
	// `C--Users-me` is `C:\Users\me`; anything else is a POSIX path without its leading slash.
	if (drive) return `${drive[1]}:/${drive[2].replaceAll("-", "/")}`;
	return `/${match[1].replaceAll("-", "/")}`;
}

function hasId(entry: SessionEntry): entry is SessionEntry & { id: string } {
	return "id" in entry && typeof entry.id === "string" && entry.id.length > 0;
}

/** A message entry with an id; id-less entries are not linkable and would violate the NOT NULL `entry_id` columns. */
function isMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message" && hasId(entry) && "message" in entry && entry.message != null;
}

function isUsageEntry(entry: SessionEntry): entry is SessionUsageEntry {
	return entry.type === "usage" && hasId(entry);
}

/**
 * Extract plain text from a user message content payload.
 */
function extractUserText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
			if (typeof block.text === "string") parts.push(block.text);
		}
	}
	return parts.join("");
}

/**
 * Build user-message stats from an entry. Returns null for empty content.
 * pi has no synthetic or agent-attributed user messages: every one is typed by the user.
 */
function extractUserStats(sessionFile: string, folder: string, entry: SessionMessageEntry): UserMessageStats | null {
	const text = extractUserText("content" in entry.message ? entry.message.content : undefined);
	if (!text.trim()) return null;
	const metrics = computeUserMessageMetrics(text);
	const prose = judgeProse(text);
	const ts = Date.parse(entry.timestamp);
	return {
		sessionFile,
		entryId: entry.id,
		folder,
		timestamp: Number.isFinite(ts) ? ts : 0,
		model: null,
		provider: null,
		chars: metrics.chars,
		words: metrics.words,
		yelling: metrics.yelling,
		profanity: metrics.profanity,
		anguish: metrics.anguish,
		negation: metrics.negation,
		repetition: metrics.repetition,
		blame: metrics.blame,
		prose,
		proseHash: prose ? hashHex(prose) : "",
	};
}

/**
 * Session JSONL is written by older versions and foreign producers, so a token
 * counter is whatever was persisted, not what `Usage` declares. A non-numeric
 * bucket (`input: "10"`) must never be parsed and must never be summed: `+`
 * would concatenate it into the derived total and SQLite would coerce the
 * resulting string to a different, far larger number. A non-finite one
 * (`input: 1e999` is legal JSON) must not reach a NOT NULL column either.
 * Malformed input counts as absent.
 */
function isFiniteCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function finiteTokenCount(value: unknown): number {
	return isFiniteCount(value) ? value : 0;
}

/**
 * Token-bucket view for total derivation. Persisted session payloads are
 * outside-controlled (old versions, foreign producers), so every counter is
 * `unknown` and validated at read time.
 */
export interface UsageBucketView {
	totalTokens?: unknown;
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
}

/**
 * Total tokens for one usage payload. A present finite provider total stays
 * authoritative; a missing or malformed one (absent, string, NaN) is derived
 * from the buckets, which would otherwise persist a zero total next to real
 * token counts. `reasoning` is a subset of `output` and never added. Shared by
 * ingest and the trace builder so stored and displayed totals cannot disagree.
 */
export function resolveUsageTotal(usage: UsageBucketView | null | undefined): number {
	if (typeof usage?.totalTokens === "number" && Number.isFinite(usage.totalTokens)) return usage.totalTokens;
	if (!usage || typeof usage !== "object") return 0;
	return (
		finiteTokenCount(usage.input) +
		finiteTokenCount(usage.output) +
		finiteTokenCount(usage.cacheRead) +
		finiteTokenCount(usage.cacheWrite)
	);
}

/** The model the session is talking to: the last `model_change` or assistant message seen. */
interface CurrentModel {
	provider: string;
	model: string;
	api: string;
}

/** One usage payload and everything needed to store it as a request row. */
interface UsageSource {
	entryId: string;
	provider: unknown;
	model: unknown;
	api: unknown;
	usage: unknown;
	timestamp: number;
	duration: number | null;
	stopReason: MessageStatsInput["stopReason"];
	errorMessage: string | null;
}

/**
 * Build one request row from a usage payload.
 *
 * Session JSONL on disk is not guaranteed to match the current shapes:
 * crash-truncated turns, sessions written by older versions, and foreign
 * producers all flow through this parser. Every field returned here feeds a
 * NOT NULL column in stats.db, so malformed entries are coerced (token
 * counts) or skipped (missing `model`/`provider`/`api`/`usage`) instead of
 * crashing the whole sync with a constraint violation.
 */
function extractUsageStats(
	sessionFile: string,
	folder: string,
	agentType: AgentType,
	source: UsageSource,
): MessageStatsInput | null {
	const { provider, model, api } = source;
	if (typeof model !== "string" || typeof provider !== "string" || typeof api !== "string") return null;
	if (!source.usage || typeof source.usage !== "object") return null;
	const rawUsage: Partial<Usage> = source.usage;
	const wellFormed =
		isFiniteCount(rawUsage.input) &&
		isFiniteCount(rawUsage.output) &&
		isFiniteCount(rawUsage.cacheRead) &&
		isFiniteCount(rawUsage.cacheWrite) &&
		isFiniteCount(rawUsage.totalTokens);
	const usage: MessageStatsInput["usage"] = wellFormed
		? (rawUsage as Usage)
		: {
				...rawUsage,
				input: finiteTokenCount(rawUsage.input),
				output: finiteTokenCount(rawUsage.output),
				cacheRead: finiteTokenCount(rawUsage.cacheRead),
				cacheWrite: finiteTokenCount(rawUsage.cacheWrite),
				// A present finite provider total stays authoritative; a missing
				// or malformed one (absent, string, NaN) is derived from the buckets.
				totalTokens: resolveUsageTotal(rawUsage),
				// An omitted `cost` must stay omitted: absence reads as "no recorded
				// price", which ingest estimates from the rate card.
				cost: rawUsage.cost,
			};
	return {
		sessionFile,
		entryId: source.entryId,
		folder,
		model,
		provider,
		api,
		timestamp: source.timestamp,
		// pi never records a time to first token: it stays NULL until a live timing
		// fills it (see `timings`). The duration is recorded or derived, see `requestDuration`.
		duration: source.duration,
		ttft: null,
		stopReason: source.stopReason,
		errorMessage: source.errorMessage,
		usage,
		agentType,
	};
}

/**
 * How long an assistant response took, in ms. Newer pi versions record it as
 * `durationMs`. Older messages still carry both ends: `message.timestamp` is
 * when the request started and the entry's own timestamp is when pi persisted
 * the finished message, so their difference is the same duration (they agree
 * with `durationMs` to within a few ms wherever both exist). Null when either
 * end is missing or they are out of order.
 */
export function requestDuration(msg: { durationMs?: unknown; timestamp?: unknown }, entryTimestamp: unknown): number | null {
	if (isFiniteCount(msg.durationMs) && msg.durationMs >= 0) return msg.durationMs;
	if (!isFiniteCount(msg.timestamp) || msg.timestamp <= 0 || typeof entryTimestamp !== "string") return null;
	const persistedAt = Date.parse(entryTimestamp);
	return Number.isFinite(persistedAt) && persistedAt >= msg.timestamp ? persistedAt - msg.timestamp : null;
}

/** Message timestamp, falling back to the entry's ISO timestamp, then 0. */
function coerceEntryTimestamp(timestamp: unknown, isoTimestamp: unknown): number {
	// A stored zero is the "no timestamp" sentinel, not 1970: fall through to the entry envelope.
	if (typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0) return timestamp;
	const ts = typeof isoTimestamp === "string" ? Date.parse(isoTimestamp) : Number.NaN;
	return Number.isFinite(ts) ? ts : 0;
}

/**
 * Extract one {@link ToolCallStats} per `toolCall` content block of an
 * assistant message. Returns an empty array for turns without tool calls.
 */
function extractToolCalls(
	sessionFile: string,
	folder: string,
	entry: SessionMessageEntry,
	msg: AssistantMessage,
	agentType: AgentType,
): ToolCallStats[] {
	if (!Array.isArray(msg.content)) return [];
	// `tool_calls` columns are NOT NULL: skip turns that can't be attributed
	// (malformed persisted entries — see extractUsageStats) and blocks missing ids.
	if (typeof msg.model !== "string" || typeof msg.provider !== "string") return [];

	const blocks = msg.content.filter(
		(block): block is ToolCall =>
			block !== null &&
			typeof block === "object" &&
			block.type === "toolCall" &&
			typeof block.id === "string" &&
			typeof block.name === "string",
	);
	if (blocks.length === 0) return [];

	const calls: ToolCallStats[] = [];
	for (const block of blocks) {
		// Names reduced to nothing by sanitization carry no tool identity:
		// skip them rather than attributing usage to garbage (see
		// sanitizeToolName). callsInTurn still counts the raw block total.
		const toolName = sanitizeToolName(block.name);
		if (toolName === null) continue;
		let argsChars = 0;
		try {
			argsChars = JSON.stringify(block.arguments ?? {}).length;
		} catch {
			// Non-serializable arguments (shouldn't happen in persisted JSONL); size unknown.
		}
		calls.push({
			sessionFile,
			entryId: entry.id,
			toolCallId: block.id,
			folder,
			toolName,
			model: msg.model,
			provider: msg.provider,
			timestamp: coerceEntryTimestamp(msg.timestamp, entry.timestamp),
			agentType,
			callsInTurn: blocks.length,
			argsChars,
		});
	}
	return calls;
}

/**
 * Tool names as persisted can be polluted by provider-side parse garbage — a
 * gateway may hand the model's whole invocation text back as the function
 * name (e.g. `bash command="ls -la …"` with a stray in-band closer), which
 * then shows up verbatim in every `GROUP BY tool_name` aggregate and the
 * dashboard tool filter. Reduce such names to their leading identifier token;
 * names that yield no identifier at all carry no tool identity and are
 * returned as `null` so the row is skipped.
 */
function sanitizeToolName(name: string): string | null {
	const trimmed = name.trim();
	if (trimmed.length === 0) return null;
	if (TOOL_NAME_PATTERN.test(trimmed)) return trimmed;
	const candidate = trimmed.split(/[^\w.:-]/)[0] ?? "";
	return candidate.length > 0 ? candidate : null;
}

/**
 * Build the result linkage for a `toolResult` entry: text characters fed back
 * into context plus the error flag, keyed to the originating call.
 */
function extractToolResultLink(sessionFile: string, msg: ToolResultMessage): ToolResultLink | null {
	if (typeof msg.toolCallId !== "string" || msg.toolCallId.length === 0) return null;
	let resultChars = 0;
	if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
				resultChars += block.text.length;
			}
		}
	}
	return { sessionFile, toolCallId: msg.toolCallId, resultChars, isError: msg.isError === true };
}

const LF = 0x0a;
const CR = 0x0d;
const jsonLineDecoder = new TextDecoder();

function parseJsonLine(bytes: Uint8Array, start: number, end: number): SessionEntry | null {
	while (end > start && bytes[end - 1] === CR) end--;
	if (end <= start) return null;
	try {
		const entry: unknown = JSON.parse(jsonLineDecoder.decode(bytes.subarray(start, end)));
		return entry && typeof entry === "object" && "type" in entry ? (entry as SessionEntry) : null;
	} catch {
		return null;
	}
}

/**
 * Version 1 transcripts carry no `id`/`parentId`. Such an entry gets an id
 * derived from its line, so a re-parse names it the same and re-syncs stay
 * idempotent, and the previous entry as its parent (v1 is linear). pi's own
 * `migrateSessionEntries` assigns random ids and needs the whole file.
 */
class LegacyIds {
	lastId: string | null;

	constructor(lastId: string | null) {
		this.lastId = lastId;
	}

	apply(entry: SessionEntry, line: Uint8Array): void {
		if (entry.type === "session") return;
		if (!hasId(entry)) Object.assign(entry, { id: hashHex(line), parentId: this.lastId });
		if (hasId(entry)) this.lastId = entry.id;
	}
}

type EntryVisitor = (entry: SessionEntry) => void;

/**
 * Visit every well-formed entry of an in-memory transcript; returns the bytes
 * consumed. A malformed line is skipped; an unterminated last line is only
 * consumed when it parses (a partial write waits for the next sync).
 */
function visitSessionEntriesLenient(bytes: Uint8Array, ids: LegacyIds, visit: EntryVisitor): number {
	let cursor = 0;
	let read = 0;

	while (cursor < bytes.length) {
		const newline = bytes.indexOf(LF, cursor);
		const hasNewline = newline !== -1;
		const lineEnd = hasNewline ? newline : bytes.length;
		const entry = parseJsonLine(bytes, cursor, lineEnd);
		if (entry) {
			ids.apply(entry, bytes.subarray(cursor, lineEnd));
			visit(entry);
			read = hasNewline ? newline + 1 : lineEnd;
		} else if (hasNewline) {
			read = newline + 1;
		} else {
			break;
		}
		cursor = hasNewline ? newline + 1 : lineEnd;
	}

	return read;
}

/** Parse every well-formed entry in a transcript buffer (malformed lines skipped). */
export function parseAllSessionEntries(bytes: Uint8Array): SessionEntry[] {
	const entries: SessionEntry[] = [];
	visitSessionEntriesLenient(bytes, new LegacyIds(null), entry => entries.push(entry));
	return entries;
}

/** Bytes read per step; a longer line grows the buffer for as long as it lasts. */
const READ_CHUNK_BYTES = 1 << 20;

/**
 * {@link visitSessionEntriesLenient} over `[start, end)` of an open file,
 * read in bounded chunks so a large transcript is never held in memory: each
 * entry is reduced by `visit` and dropped. Returns the offset consumed up to.
 */
async function visitFileRange(
	handle: fs.FileHandle,
	start: number,
	end: number,
	ids: LegacyIds,
	visit: EntryVisitor,
): Promise<number> {
	let buffer = Buffer.allocUnsafe(Math.max(1, Math.min(READ_CHUNK_BYTES, end - start)));
	let filled = 0;
	let position = start;
	let consumed = start;
	while (position < end) {
		if (filled === buffer.length) {
			const grown = Buffer.allocUnsafe(buffer.length * 2);
			buffer.copy(grown, 0, 0, filled);
			buffer = grown;
		}
		const want = Math.min(buffer.length - filled, end - position);
		const { bytesRead } = await handle.read(buffer, filled, want, position);
		if (bytesRead === 0) break;
		position += bytesRead;
		filled += bytesRead;
		const window = buffer.subarray(0, filled);
		let cursor = 0;
		for (let newline = window.indexOf(LF, cursor); newline !== -1; newline = window.indexOf(LF, cursor)) {
			const entry = parseJsonLine(window, cursor, newline);
			if (entry) {
				ids.apply(entry, window.subarray(cursor, newline));
				visit(entry);
			}
			cursor = newline + 1;
		}
		if (cursor > 0) {
			buffer.copyWithin(0, cursor, filled);
			filled -= cursor;
			consumed += cursor;
		}
	}
	if (filled > 0) {
		// Unterminated last line: complete JSON is consumed, a partial write waits for the next sync.
		const window = buffer.subarray(0, filled);
		const entry = parseJsonLine(window, 0, filled);
		if (entry) {
			ids.apply(entry, window);
			visit(entry);
			consumed += filled;
		}
	}
	return consumed;
}

/**
 * Links each user message to its reply across tail reads. pi writes other entries (the system prompt message, model
 * and thinking-level changes, extension entries) between a user message and its reply, so the reply is the first
 * assistant message descending from the user message through such entries. Another conversation message on the way
 * ends that branch only; a sibling branch can still carry the reply.
 */
class ReplyTracker {
	/** User messages still awaiting a reply and the pass-through entries beneath them, each to its user message. */
	readonly #waiting: Map<string, string>;

	constructor(waiting?: Record<string, string>) {
		this.#waiting = new Map(waiting ? Object.entries(waiting) : undefined);
	}

	get state(): Record<string, string> {
		return Object.fromEntries(this.#waiting);
	}

	/** The user message `entry` answers, if `entry` is an assistant message descending from it through pass-through entries. */
	visit(entry: SessionEntry): string | undefined {
		const role = isMessageEntry(entry) ? entry.message.role : undefined;
		if (role === "user" && hasId(entry)) {
			this.#waiting.set(entry.id, entry.id);
			return undefined;
		}
		const parentId = "parentId" in entry ? entry.parentId : undefined;
		const user = typeof parentId === "string" ? this.#waiting.get(parentId) : undefined;
		if (!user) return undefined;
		if (role === "assistant") {
			for (const [waitingId, waitingUser] of this.#waiting) {
				if (waitingUser === user) this.#waiting.delete(waitingId);
			}
			return user;
		}
		// The system message carries the prompt, not a turn of the conversation.
		if ((entry.type !== "message" || role === "system") && hasId(entry)) this.#waiting.set(entry.id, user);
		return undefined;
	}
}

export interface SessionParserState {
	version: 1;
	offset: number;
	ino: number;
	birthtimeMs: number;
	size: number;
	mtimeMs: number;
	checkpoint: string;
	/** The header's `cwd`; null when the transcript has no usable header. */
	folder: string | null;
	/** Model in use at the cursor, for usage that names none (compaction, branch summary, tool usage). */
	model: CurrentModel | null;
	/** Last entry id before the cursor: the parent of an id-less (v1) entry that follows. */
	lastId: string | null;
	/** Name given with `/name`; null when unset. With `firstPrompt`, the session's title in the Traces list. */
	sessionName: string | null;
	/** Head of the first user message, the title of an unnamed session (as in pi's `/resume`). */
	firstPrompt: string | null;
	pendingReplies: Record<string, string>;
}

export interface ParseSessionResult {
	stats: MessageStatsInput[];
	userStats: UserMessageStats[];
	userLinks: UserMessageLink[];
	toolCalls: ToolCallStats[];
	toolResults: ToolResultLink[];
	newOffset: number;
	parserState?: SessionParserState;
	reset?: boolean;
}

const CHECKPOINT_BYTES = 256;

async function readCheckpoint(handle: fs.FileHandle, end: number): Promise<Uint8Array> {
	const start = Math.max(0, end - CHECKPOINT_BYTES);
	const bytes = new Uint8Array(end - start);
	let read = 0;
	while (read < bytes.length) {
		const result = await handle.read(bytes, read, bytes.length - read, start + read);
		if (result.bytesRead === 0) break;
		read += result.bytesRead;
	}
	return bytes.subarray(0, read);
}

/**
 * Whether `info` is still the file a cursor was taken from. The device number is deliberately not part of
 * this: ZFS and others renumber it across mounts and reboots while the transcript stays intact; `ino` +
 * `birthtimeMs` (plus size/mtime at call sites) identify the file.
 */
export function matchesSessionFile(state: SessionParserState, info: nodeFs.Stats): boolean {
	return state.ino === info.ino && state.birthtimeMs === info.birthtimeMs;
}

/** Offset-only callers reconstruct the cursor state once from the prefix; persisted cursors read only the appended tail. */
export async function parseSessionFile(
	sessionPath: string,
	fromOffset = 0,
	state?: SessionParserState,
	replay = false,
): Promise<ParseSessionResult> {
	let start = fromOffset;
	let reset = false;
	let info: nodeFs.Stats;
	let checkpoint: string;
	let newOffset: number;
	const agentType = classifyAgentType(sessionPath);
	const stats: MessageStatsInput[] = [];
	const userStats: UserMessageStats[] = [];
	const userLinks: UserMessageLink[] = [];
	const toolCalls: ToolCallStats[] = [];
	const toolResults: ToolResultLink[] = [];
	// First call per id: the row `INSERT OR IGNORE` keeps, so it can be written with its result.
	const callsById = new Map<string, ToolCallStats>();
	let headerFolder: string | null = null;
	let sessionName: string | null = null;
	let firstPrompt: string | null = null;
	let folder = "";
	let currentModel: CurrentModel | null = null;
	let replies = new ReplyTracker();
	let ids = new LegacyIds(null);

	/** Cursor state every entry moves, whether or not its rows are collected. */
	const track = (entry: SessionEntry): string | undefined => {
		if (entry.type === "session") {
			if ("cwd" in entry && typeof entry.cwd === "string" && entry.cwd) headerFolder = projectFolder(entry.cwd);
			return undefined;
		}
		if (entry.type === "model_change" && "provider" in entry && "modelId" in entry) {
			if (typeof entry.provider === "string" && typeof entry.modelId === "string") {
				currentModel = { provider: entry.provider, model: entry.modelId, api: currentModel?.api ?? UNKNOWN };
			}
		}
		if (entry.type === "session_info" && "name" in entry) {
			sessionName = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : null;
		} else if (firstPrompt === null && isMessageEntry(entry) && entry.message.role === "user") {
			const text = extractUserText("content" in entry.message ? entry.message.content : undefined).trim();
			if (text) firstPrompt = text.replace(/\s+/g, " ").slice(0, TITLE_MAX);
		}
		return replies.visit(entry);
	};

	const usageRow = (source: UsageSource): void => {
		const row = extractUsageStats(sessionPath, folder, agentType, source);
		if (row) stats.push(row);
	};

	/** Usage of an entry that names no model of its own: attributed to the model in use. */
	const sideUsage = (entryId: string, usage: unknown, timestamp: number): void => {
		if (!usage || typeof usage !== "object") return;
		usageRow({
			entryId,
			provider: currentModel?.provider ?? UNKNOWN,
			model: currentModel?.model ?? UNKNOWN,
			api: currentModel?.api ?? UNKNOWN,
			usage,
			timestamp,
			// How long the summary or tool took is not a model response time.
			duration: null,
			stopReason: "stop",
			errorMessage: null,
		});
	};

	// Reduce each entry immediately so full replays do not retain tool-output/message bodies.
	const visit = (entry: SessionEntry): void => {
		const answered = track(entry);
		if (!folder) folder = headerFolder ?? extractFolderFromPath(sessionPath);
		if (isUsageEntry(entry)) {
			usageRow({
				entryId: entry.id,
				provider: entry.provider,
				model: entry.model,
				api: UNKNOWN,
				usage: entry.usage,
				timestamp: coerceEntryTimestamp(undefined, entry.timestamp),
				duration: null,
				stopReason: "stop",
				errorMessage: null,
			});
			return;
		}
		if ((entry.type === "compaction" || entry.type === "branch_summary") && hasId(entry) && "usage" in entry) {
			const iso = "timestamp" in entry ? entry.timestamp : undefined;
			sideUsage(entry.id, entry.usage, coerceEntryTimestamp(undefined, iso));
			return;
		}
		if (!isMessageEntry(entry)) return;
		const role = entry.message.role;
		if (role === "user") {
			const userMsg = extractUserStats(sessionPath, folder, entry);
			if (userMsg) userStats.push(userMsg);
			return;
		}
		if (role === "toolResult") {
			const msg = entry.message as ToolResultMessage;
			sideUsage(entry.id, msg.usage, coerceEntryTimestamp(msg.timestamp, entry.timestamp));
			const link = extractToolResultLink(sessionPath, msg);
			if (!link) return;
			toolResults.push(link);
			const call = callsById.get(link.toolCallId);
			if (call && call.resultChars === undefined) {
				call.resultChars = link.resultChars;
				call.isError = link.isError;
			}
			return;
		}
		if (role !== "assistant") return;
		const msg = entry.message as AssistantMessage;
		if (typeof msg.provider === "string" && typeof msg.model === "string") {
			currentModel = { provider: msg.provider, model: msg.model, api: typeof msg.api === "string" ? msg.api : UNKNOWN };
		}
		usageRow({
			entryId: entry.id,
			provider: msg.provider,
			model: msg.model,
			api: msg.api,
			usage: msg.usage,
			timestamp: coerceEntryTimestamp(msg.timestamp, entry.timestamp),
			duration: requestDuration(msg, entry.timestamp),
			// A message persisted without a terminal stop reason never completed
			// normally: classify by whether it carried an error.
			stopReason: msg.stopReason ?? (msg.errorMessage ? "error" : "aborted"),
			errorMessage: msg.errorMessage ?? null,
		});
		for (const call of extractToolCalls(sessionPath, folder, entry, msg, agentType)) {
			toolCalls.push(call);
			if (!callsById.has(call.toolCallId)) callsById.set(call.toolCallId, call);
		}
		// Persist links even when the user entry was ingested in an earlier tail read.
		if (answered && msg.model && msg.provider) {
			userLinks.push({ sessionFile: sessionPath, entryId: answered, model: msg.model, provider: msg.provider });
		}
	};

	try {
		const handle = await fs.open(sessionPath, "r");
		try {
			info = await handle.stat();
			let resume = state?.version === 1 && state.offset === fromOffset;
			if (resume && state) {
				reset =
					!matchesSessionFile(state, info) ||
					info.size < state.size ||
					(info.size === state.size && info.mtimeMs !== state.mtimeMs);
				if (!reset) {
					const previous = await readCheckpoint(handle, fromOffset);
					reset = hashHex(previous) !== state.checkpoint;
				}
				resume = !reset;
			}
			if (fromOffset > info.size) reset = true;
			if (replay) resume = false;
			start = reset || replay ? 0 : Math.max(0, fromOffset);
			if (resume && state) {
				headerFolder = state.folder;
				sessionName = state.sessionName ?? null;
				firstPrompt = state.firstPrompt ?? null;
				currentModel = state.model;
				replies = new ReplyTracker(state.pendingReplies);
				ids = new LegacyIds(state.lastId);
			} else if (start > 0) {
				// No usable cursor state: rebuild it from the transcript prefix, collecting no rows.
				await visitFileRange(handle, 0, start, ids, track);
			}
			newOffset = await visitFileRange(handle, start, info.size, ids, visit);
			checkpoint = hashHex(await readCheckpoint(handle, newOffset));
		} finally {
			await handle.close();
		}
	} catch (err) {
		if (isEnoent(err)) {
			return { stats: [], userStats: [], userLinks: [], toolCalls: [], toolResults: [], newOffset: fromOffset };
		}
		throw err;
	}

	return {
		stats,
		userStats,
		userLinks,
		toolCalls,
		toolResults,
		newOffset,
		reset,
		parserState: {
			version: 1,
			offset: newOffset,
			ino: info.ino,
			birthtimeMs: info.birthtimeMs,
			size: info.size,
			mtimeMs: info.mtimeMs,
			checkpoint,
			folder: headerFolder,
			sessionName,
			firstPrompt,
			model: currentModel,
			lastId: ids.lastId,
			pendingReplies: replies.state,
		},
	};
}

/**
 * List all session files below a directory.
 */
export async function listSessionFiles(folderPath: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(folderPath, { recursive: true, withFileTypes: true });
		return entries
			.filter(e => e.isFile() && e.name.endsWith(".jsonl"))
			.map(e => path.join(e.parentPath, e.name));
	} catch {
		return [];
	}
}

/**
 * List all session files across every session root (see `getSessionRoots`).
 */
export async function listAllSessionFiles(): Promise<string[]> {
	const perRoot = await Promise.all(getSessionRoots().map(listSessionFiles));
	return [...new Set(perRoot.flat().map(file => path.resolve(file)))];
}

/**
 * Find a specific entry in a session file.
 */
export async function getSessionEntry(sessionPath: string, entryId: string): Promise<SessionEntry | null> {
	let found: SessionEntry | null = null;
	try {
		const handle = await fs.open(sessionPath, "r");
		try {
			const { size } = await handle.stat();
			await visitFileRange(handle, 0, size, new LegacyIds(null), entry => {
				if (!found && hasId(entry) && entry.id === entryId) found = entry;
			});
		} finally {
			await handle.close();
		}
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	return found;
}
