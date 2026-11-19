/**
 * Session trace assembly for the Traces dashboard section.
 *
 * Builds a span tree (turns, model calls, tool calls, child sessions) directly
 * from raw session JSONL — the only source with tool start/end times — while
 * stats.db supplies the session-list rollups, live request timings and the
 * rate card. Entry shapes are pi's session format, read structurally.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { findSessionRoot, getSessionRoots } from "./config";
import { currentDb, getFileOffsets, getSessionTimings, initDb, type RequestTiming } from "./db";
import { extractFolderFromPath, parseAllSessionEntries, requestDuration, resolveUsageTotal } from "./parser";
import { createRateLookup, estimateCost } from "./pricing";
import { projectFolder } from "./projects";
import { getSessionRollups } from "./rollup";
import type {
	SessionEntry,
	SessionSummary,
	SessionTrace,
	TraceMarker,
	TraceSpan,
	TraceSummary,
	TraceToolStat,
	TraceTrack,
} from "./types";
import { isEnoent } from "./util";

/** Client-supplied path escaped the session roots or is not a transcript. Maps to HTTP 400. */
export class TracePathError extends Error {}
/**
 * Trace payload schema/assembly revision, folded into the HTTP ETag. Bump when
 * span assembly changes so browsers don't revalidate stale cached bodies
 * against an unchanged transcript mtime.
 */
export const TRACE_ETAG_VERSION = 1;

const MAX_TRACK_DEPTH = 6;
const LABEL_MAX = 80;
const DETAIL_MAX = 160;
const HEADER_SCAN_BYTES = 4096;
const LIST_FOLD_LIMIT = 300;

// ---------------------------------------------------------------------------
// Structural entry views

/**
 * Loose structural view of one session entry. Session JSONL is
 * outside-controlled data (old versions, crash-truncated turns), so every
 * field is optional and reads are re-checked with `typeof` before use.
 */
interface EntryView {
	type?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: MessageView;
	// session header
	cwd?: string;
	// session_info
	name?: string;
	// compaction / branch_summary / usage
	tokensBefore?: number;
	usage?: UsageView;
	// model_change / usage
	provider?: string;
	modelId?: string;
	model?: string;
}

interface UsageView {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cacheWrite1h?: unknown;
	totalTokens?: unknown;
	cost?: { total?: unknown };
}

/** Loose structural view of a persisted message payload. */
interface MessageView {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	timestamp?: number;
	durationMs?: number;
	usage?: UsageView;
	model?: string;
	provider?: string;
	stopReason?: string;
	errorMessage?: string;
}

/** Pending tool call recorded from an assistant turn's `toolCall` blocks. */
interface PendingToolCall {
	callId: string;
	name: string;
	argsPreview?: string;
	assistantEntryId: string;
	modelEnd: number;
}

/** Everything one transcript contributes before cross-track assembly. */
interface TrackScan {
	track: TraceTrack;
	requests: number;
	toolCalls: number;
	/** Requests whose zero cost is unknown spend (mirrors db's unpriced predicate). */
	unpricedRequests: number;
	/** Tokens and cost of usage that has no model span: `usage` entries, summaries, tool usage. */
	sideTokens: number;
	sideCost: number;
	cwd: string | null;
	title: string | null;
	/** Session-header envelope timestamp (ms), for spanless traces. */
	headerTs: number | undefined;
	firstActivity: number | undefined;
	lastActivity: number | undefined;
}

/** Prices one usage payload the way ingest stores it: recorded cost, else the rate-card estimate. */
type UsagePricer = (usage: UsageView | undefined, provider: string, model: string) => { tokens: number; cost: number; unpriced: boolean };

// ---------------------------------------------------------------------------
// Path containment + transcript IO

/**
 * Resolve a client-supplied transcript path, enforcing containment in a
 * session root. The value arrives from an HTTP query string: anything that is
 * not a `.jsonl` file below a root is rejected before the filesystem is touched.
 */
function resolveSessionPath(fileParam: string): string {
	const resolved = path.resolve(fileParam);
	const inside = getSessionRoots().some(root => {
		const rel = path.relative(root, resolved);
		return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
	});
	if (!inside) throw new TracePathError(`Path is outside the session directories: ${fileParam}`);
	if (!resolved.endsWith(".jsonl")) throw new TracePathError(`Not a session transcript: ${fileParam}`);
	return resolved;
}

// ---------------------------------------------------------------------------
// Small pure helpers

/** ISO string → ms epoch, undefined when absent/unparseable. */
function toMs(iso: string | undefined): number | undefined {
	if (typeof iso !== "string") return undefined;
	const ms = Date.parse(iso);
	return Number.isFinite(ms) ? ms : undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Whitespace-collapsed head of a string, capped at `max` chars. */
function headText(value: string, max: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** First text-block head of a message content payload. */
function contentHead(content: unknown, max: number): string | undefined {
	if (typeof content === "string") return content.trim() ? headText(content, max) : undefined;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") continue;
		if ("text" in block && typeof block.text === "string" && block.text.trim()) return headText(block.text, max);
	}
	return undefined;
}

/** Compact token count for marker labels (142_000 → "142k"). */
function compactTokens(value: unknown): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "?";
	return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

/** Merge intervals and return covered length. Mutates (sorts) its input. */
function unionLength(intervals: Array<[number, number]>): number {
	if (intervals.length === 0) return 0;
	intervals.sort((a, b) => a[0] - b[0]);
	let total = 0;
	let [curStart, curEnd] = intervals[0];
	for (let i = 1; i < intervals.length; i++) {
		const [s, e] = intervals[i];
		if (s > curEnd) {
			total += curEnd - curStart;
			curStart = s;
			curEnd = e;
		} else if (e > curEnd) {
			curEnd = e;
		}
	}
	return total + (curEnd - curStart);
}

/**
 * Usage pricing against the open database's rate card, matching ingest
 * (`resolveStoredCost`), so a trace's headline agrees with Costs and Requests.
 * Without a database only recorded costs count.
 */
function createUsagePricer(): UsagePricer {
	const database = currentDb();
	const ratesOf = database ? createRateLookup(database) : undefined;
	return (usage, provider, model) => {
		const tokens = resolveUsageTotal(usage);
		const recorded = finite(usage?.cost?.total);
		if (recorded !== undefined && recorded > 0) return { tokens, cost: recorded, unpriced: false };
		const estimate = estimateCost(
			ratesOf?.(provider, model) ?? null,
			{
				input: finite(usage?.input) ?? 0,
				output: finite(usage?.output) ?? 0,
				cacheRead: finite(usage?.cacheRead) ?? 0,
				cacheWrite: finite(usage?.cacheWrite) ?? 0,
				cacheWrite1h: finite(usage?.cacheWrite1h) ?? 0,
			},
			tokens,
		);
		return { tokens, cost: estimate.cost.total, unpriced: estimate.unpriced };
	};
}

// ---------------------------------------------------------------------------
// Single-transcript scan

/** Keep only the active branch: the parentId chain walked back from the last entry. */
function activeChain(views: readonly EntryView[]): EntryView[] {
	const byId = new Map<string, EntryView>();
	let last: EntryView | undefined;
	for (const entry of views) {
		if (typeof entry.id === "string" && entry.id.length > 0) {
			byId.set(entry.id, entry);
			last = entry;
		}
	}
	if (!last) return [];
	const keep = new Set<string>();
	let cursor: EntryView | undefined = last;
	while (cursor) {
		if (typeof cursor.id !== "string" || keep.has(cursor.id)) break;
		keep.add(cursor.id);
		cursor = typeof cursor.parentId === "string" ? byId.get(cursor.parentId) : undefined;
	}
	return views.filter(entry => typeof entry.id === "string" && keep.has(entry.id));
}

/** Tool-span detail: the command or path when the call has one, else a bounded preview of its arguments. */
function argsPreview(args: unknown): string | undefined {
	if (args === undefined || args === null) return undefined;
	if (typeof args === "object") {
		const candidate =
			"command" in args && typeof args.command === "string"
				? args.command
				: "path" in args && typeof args.path === "string"
					? args.path
					: undefined;
		if (candidate?.trim()) return headText(candidate, DETAIL_MAX);
	}
	try {
		return headText(JSON.stringify(args), DETAIL_MAX);
	} catch {
		return undefined;
	}
}

/**
 * Scan one transcript into a track: model/tool/turn spans plus markers, and
 * the cross-track facts (request counts, usage without a span).
 */
function scanTranscript(
	entries: readonly SessionEntry[],
	trackId: string,
	parentTrackId: string | null,
	file: string,
	timings: ReadonlyMap<string, RequestTiming>,
	price: UsagePricer,
): TrackScan {
	// Boundary cast: persisted JSONL entries are re-validated field-by-field below.
	const views = entries as readonly EntryView[];
	const chain = activeChain(views);
	const spans: TraceSpan[] = [];
	const markers: TraceMarker[] = [];
	const pendingTools: PendingToolCall[] = [];
	const toolResults = new Map<string, { start?: number; end: number; isError: boolean; entryId?: string }>();
	const turns: Array<{ time: number; label: string; entryId?: string }> = [];

	let cwd: string | null = null;
	let headerTs: number | undefined;
	let sessionName: string | null = null;
	let firstAssistantModel: string | null = null;
	let currentProvider = "unknown";
	let currentModel = "unknown";
	let requests = 0;
	let unpricedRequests = 0;
	let sideTokens = 0;
	let sideCost = 0;
	let lastChainTs = 0;

	// The session header and the name set with `/name` sit outside the id chain — scan all entries.
	for (const raw of views) {
		if (raw.type === "session") {
			if (typeof raw.cwd === "string") cwd = raw.cwd;
			headerTs = toMs(raw.timestamp);
		} else if (raw.type === "session_info") {
			sessionName = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null;
		}
	}

	/** Usage that produced no model span still counts as a request, as it does at ingest. */
	const countSideUsage = (usage: UsageView | undefined, provider: string, model: string): void => {
		if (!usage || typeof usage !== "object") return;
		const priced = price(usage, provider, model);
		requests++;
		sideTokens += priced.tokens;
		sideCost += priced.cost;
		if (priced.unpriced) unpricedRequests++;
	};

	for (const entry of chain) {
		const envelopeTs = toMs(entry.timestamp);
		if (envelopeTs !== undefined && envelopeTs > lastChainTs) lastChainTs = envelopeTs;

		if (entry.type === "usage") {
			countSideUsage(entry.usage, entry.provider ?? "unknown", entry.model ?? "unknown");
			continue;
		}
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			countSideUsage(entry.usage, currentProvider, currentModel);
			if (entry.type === "compaction" && envelopeTs !== undefined) {
				markers.push({ time: envelopeTs, kind: "compaction", label: `compaction ${compactTokens(entry.tokensBefore)}` });
			}
			continue;
		}
		if (entry.type === "model_change") {
			if (typeof entry.provider === "string" && typeof entry.modelId === "string") {
				currentProvider = entry.provider;
				currentModel = entry.modelId;
			}
			if (envelopeTs !== undefined) {
				markers.push({ time: envelopeTs, kind: "model_change", label: String(entry.modelId ?? "model change") });
			}
			continue;
		}

		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;

		if (msg.role === "assistant") {
			requests++;
			if (typeof msg.provider === "string") currentProvider = msg.provider;
			if (typeof msg.model === "string") currentModel = msg.model;
			// Counted before the span-timing `continue` below so a fully
			// dateless entry still surfaces rather than vanishing.
			const priced = price(msg.usage, currentProvider, currentModel);
			if (priced.unpriced) unpricedRequests++;

			const timing = typeof entry.id === "string" ? timings.get(entry.id) : undefined;
			// The response's duration: recorded, derived from its two timestamps, else the live timing.
			const duration = requestDuration(msg, entry.timestamp) ?? (timing ? timing.endAt - timing.requestStart : undefined);
			let start = finite(msg.timestamp);
			if (start !== undefined && start <= 0) start = undefined;
			let end = start !== undefined && duration !== undefined ? start + duration : undefined;
			if (start === undefined) {
				const fallbackEnd = envelopeTs;
				if (fallbackEnd === undefined) {
					sideTokens += priced.tokens;
					sideCost += priced.cost;
					continue;
				}
				end = fallbackEnd;
				start = end - (duration ?? 0);
			}
			if (end === undefined) end = envelopeTs ?? start;
			end = Math.max(start, end);
			if (typeof msg.model === "string" && firstAssistantModel === null) firstAssistantModel = msg.model;

			const span: TraceSpan = {
				id: `${trackId}:${entry.id}`,
				kind: "model",
				start,
				end,
				label: headText(msg.model ?? "model", LABEL_MAX),
			};
			const detail = contentHead(msg.content, DETAIL_MAX);
			if (detail) span.detail = detail;
			if (entry.id) span.entryId = entry.id;
			if (typeof msg.model === "string") span.model = msg.model;
			if (priced.tokens > 0) span.tokens = priced.tokens;
			// An unpriced request has no cost to show; the summary counts it instead.
			if (!priced.unpriced) span.cost = priced.cost;
			// pi records no time to first token: only a live timing knows it.
			if (timing && timing.firstTokenAt !== null) span.ttft = Math.max(0, timing.firstTokenAt - timing.requestStart);
			if (msg.stopReason === "error" || msg.errorMessage) span.isError = true;
			spans.push(span);
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (!block || typeof block !== "object" || !("type" in block) || block.type !== "toolCall") continue;
					if (!("id" in block) || typeof block.id !== "string") continue;
					if (!("name" in block) || typeof block.name !== "string") continue;
					pendingTools.push({
						callId: block.id,
						name: block.name,
						argsPreview: argsPreview("arguments" in block ? block.arguments : undefined),
						assistantEntryId: entry.id ?? "",
						modelEnd: end,
					});
				}
			}
			continue;
		}

		if (msg.role === "toolResult") {
			countSideUsage(msg.usage, currentProvider, currentModel);
			if (typeof msg.toolCallId !== "string") continue;
			const end = finite(msg.timestamp) ?? envelopeTs;
			if (end === undefined) continue;
			// Newer pi versions record how long the tool ran; older results only know when it ended.
			const ran = finite(msg.durationMs);
			toolResults.set(msg.toolCallId, {
				start: ran !== undefined && ran >= 0 ? end - ran : undefined,
				end,
				isError: msg.isError === true,
				entryId: entry.id,
			});
			continue;
		}

		if (msg.role === "user") {
			const time = finite(msg.timestamp) ?? envelopeTs;
			if (time === undefined) continue;
			turns.push({ time, label: contentHead(msg.content, LABEL_MAX) ?? "user", entryId: entry.id });
		}
	}

	// Tool spans: join call blocks with their results.
	for (const pending of pendingTools) {
		const result = toolResults.get(pending.callId);
		const start = result?.start ?? pending.modelEnd;
		// A call with no result was still running when the transcript ends.
		const end = result ? result.end : lastChainTs || start;
		const span: TraceSpan = {
			id: `${trackId}:${pending.assistantEntryId}:${pending.callId}`,
			kind: "tool",
			start,
			end: Math.max(start, end),
			label: headText(pending.name, LABEL_MAX),
			toolCallId: pending.callId,
		};
		if (pending.argsPreview) span.detail = pending.argsPreview;
		const entryId = result?.entryId ?? pending.assistantEntryId;
		if (entryId) span.entryId = entryId;
		if (result?.isError) span.isError = true;
		if (!result) span.unterminated = true;
		spans.push(span);
	}

	// Turn spans: user message → max end of spans starting before the next turn.
	turns.sort((a, b) => a.time - b.time);
	for (let i = 0; i < turns.length; i++) {
		const turn = turns[i];
		const nextTime = i + 1 < turns.length ? turns[i + 1].time : Number.POSITIVE_INFINITY;
		let end = turn.time;
		for (const span of spans) {
			if (span.start >= turn.time && span.start < nextTime && span.end > end) end = span.end;
		}
		const span: TraceSpan = {
			id: `${trackId}:${turn.entryId ?? `turn${i}`}`,
			kind: "turn",
			start: turn.time,
			end,
			label: turn.label,
		};
		if (turn.entryId) span.entryId = turn.entryId;
		spans.push(span);
	}

	spans.sort((a, b) => a.start - b.start || a.end - b.end);
	markers.sort((a, b) => a.time - b.time);

	let firstActivity: number | undefined;
	let lastActivity: number | undefined;
	for (const span of spans) {
		if (firstActivity === undefined || span.start < firstActivity) firstActivity = span.start;
		if (lastActivity === undefined || span.end > lastActivity) lastActivity = span.end;
	}

	return {
		track: {
			id: trackId,
			parentId: parentTrackId,
			label: "",
			model: firstAssistantModel,
			file,
			spans,
			markers,
		},
		requests,
		toolCalls: pendingTools.length,
		unpricedRequests,
		sideTokens,
		sideCost,
		cwd,
		// An unnamed session is titled by its first prompt, as in pi's `/resume`.
		title: sessionName ?? (turns.length > 0 ? turns[0].label : null),
		headerTs,
		firstActivity,
		lastActivity,
	};
}

// ---------------------------------------------------------------------------
// Recursive track tree

/** Strip the transcript extension. */
function transcriptStem(file: string): string {
	return file.slice(0, -".jsonl".length);
}

/**
 * Build the track for one transcript and recurse into the directory named
 * after it, where an extension that persists child sessions keeps them (pi
 * core writes none). Appends tracks to `out` in DFS order and places child
 * spans on parents.
 */
async function buildTrackTree(
	file: string,
	trackId: string,
	parentTrackId: string | null,
	depth: number,
	visited: Set<string>,
	out: TraceTrack[],
	scans: TrackScan[],
	price: UsagePricer,
): Promise<TrackScan | null> {
	if (visited.has(file)) return null;
	visited.add(file);

	let bytes: Uint8Array;
	try {
		bytes = await fs.readFile(file);
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}

	const scan = scanTranscript(parseAllSessionEntries(bytes), trackId, parentTrackId, file, getSessionTimings(file), price);
	out.push(scan.track);
	scans.push(scan);

	const children = new Map<string, TrackScan>();
	if (depth < MAX_TRACK_DEPTH) {
		const childDir = transcriptStem(file);
		let names: string[] = [];
		try {
			names = await fs.readdir(childDir);
		} catch (err) {
			// Almost always ENOENT; a plain file of that name is no directory either.
			if (!isEnoent(err) && !(err instanceof Error && "code" in err && err.code === "ENOTDIR")) throw err;
		}
		names.sort();
		for (const name of names) {
			if (!name.endsWith(".jsonl")) continue;
			const childFile = path.join(childDir, name);
			const stem = path.basename(transcriptStem(childFile));
			const childTrackId = trackId === "main" ? stem : `${trackId}/${stem}`;
			const childScan = await buildTrackTree(childFile, childTrackId, trackId, depth + 1, visited, out, scans, price);
			if (!childScan) continue;
			childScan.track.label = headText(`agent ${stem}`, LABEL_MAX);
			children.set(stem, childScan);
		}
	}

	linkChildTracks(scan, children);
	return scan;
}

/** Give each child session a span on its parent track from its own activity bounds. */
function linkChildTracks(scan: TrackScan, children: ReadonlyMap<string, TrackScan>): void {
	if (children.size === 0) return;
	for (const [stem, child] of children) {
		if (child.firstActivity === undefined || child.lastActivity === undefined) continue;
		const span: TraceSpan = {
			id: `${scan.track.id}:sub:${stem}`,
			kind: "subagent",
			start: child.firstActivity,
			end: Math.max(child.firstActivity, child.lastActivity),
			label: headText(child.track.label, LABEL_MAX),
			childTrackId: child.track.id,
		};
		if (child.track.model) span.model = child.track.model;
		scan.track.spans.push(span);
	}
	scan.track.spans.sort((a, b) => a.start - b.start || a.end - b.end);
}

// ---------------------------------------------------------------------------
// Public surface

// Single-entry memo: the dashboard polls one open trace every 15s. Keyed on
// the root file's mtime PLUS a fingerprint of the child-transcript SET under
// the root's child directory (one cheap readdir+stat walk, no parse). A
// high-water mark alone is blind to deletions and to older-mtime
// replacements, so the fingerprint encodes every child's (name, mtimeMs)
// pair: any append, delete, rename, or content swap changes the key and the
// memo misses. Membership diffs are bounded (depth + file count caps) so a
// pathological tree cannot blow the key.
interface TraceMemoEntry {
	mtimeMs: number;
	childFingerprint: string;
	trace: SessionTrace;
}

let traceMemo: { file: string; entry: TraceMemoEntry } | undefined;

/**
 * Fingerprint of the child-transcript set: per-directory file COUNT plus
 * sorted `name@mtimeMs` pairs, mirroring buildTrackTree's discovery (stats
 * only, no parse). The count makes an empty directory distinguishable from a
 * missing one and keeps renames visible. The walk is depth-capped; the raw
 * string still grows with child count, but the wire ETag hashes it, so a large
 * tree cannot inflate the request header. Best-effort: a raced deletion is
 * recorded as `name@gone` (which itself changes the fingerprint and misses the
 * memo — the safe direction).
 */
async function childTranscriptsFingerprint(rootFile: string, depth = 0): Promise<string> {
	if (depth > MAX_TRACK_DEPTH) return "";
	const dir = transcriptStem(rootFile);
	let names: string[] = [];
	try {
		names = await fs.readdir(dir);
	} catch {
		return "";
	}
	names.sort();
	const transcriptNames = names.filter(name => name.endsWith(".jsonl"));
	const childParts = await Promise.all(
		transcriptNames.map(async name => {
			const childFile = path.join(dir, name);
			try {
				const stat = await fs.stat(childFile);
				// Recurse like the builder (nested children), without parsing.
				const nested = await childTranscriptsFingerprint(childFile, depth + 1);
				return nested ? `${name}@${stat.mtimeMs},${name}/{${nested}}` : `${name}@${stat.mtimeMs}`;
			} catch {
				return `${name}@gone`;
			}
		}),
	);
	return [`n=${transcriptNames.length}`, ...childParts].join(",");
}

/** Freshness of a root trace: root mtime+size plus the child-transcript set fingerprint. */
export interface TraceFingerprint {
	rootMtimeMs: number;
	rootSize: number;
	childFingerprint: string;
}

/**
 * Compact wire ETag key. The raw child fingerprint is unbounded — a
 * child-heavy session can produce tens of kilobytes of `name@mtime` pairs,
 * more than a request header may carry back in `If-None-Match`, so hash it to
 * a fixed-size key first. Root size is part of the key because a coarse mtime
 * can miss an append.
 */
function traceEtagKey(rootMtimeMs: number, rootSize: number, childFingerprint: string): string {
	const digest = createHash("sha256").update(childFingerprint).digest("hex");
	return `${rootMtimeMs}:${rootSize}:${digest}`;
}

/** Build the wire ETag from a fingerprint already computed by the caller. */
export function traceEtagForFingerprint(fingerprint: TraceFingerprint): string {
	return traceEtagKey(fingerprint.rootMtimeMs, fingerprint.rootSize, fingerprint.childFingerprint);
}

/**
 * Stat the root and walk its child transcripts (readdir+stat, no parse). The
 * count of live timings recorded for the root joins the child fingerprint: a
 * timing lands in the database after the transcript was written, and changes
 * what the trace shows without touching the file.
 */
async function readTraceFingerprint(resolved: string): Promise<TraceFingerprint> {
	const stat = await fs.stat(resolved);
	const childFingerprint = await childTranscriptsFingerprint(resolved);
	return {
		rootMtimeMs: stat.mtimeMs,
		rootSize: stat.size,
		childFingerprint: `t=${getSessionTimings(resolved).size},${childFingerprint}`,
	};
}

/**
 * Freshness fingerprint for the trace ETag pre-check; `SessionTrace.etag` is
 * the compact `${rootMtimeMs}:${rootSize}:${digest}` key for an unraced build.
 * Returns undefined when the path is rejected or missing (the caller falls
 * through to the full build, which maps those to 400/404).
 */
export async function traceFingerprintForEtag(fileParam: string): Promise<TraceFingerprint | undefined> {
	try {
		return await readTraceFingerprint(resolveSessionPath(fileParam));
	} catch {
		return undefined;
	}
}

/**
 * Assemble the full span tree for one root session transcript.
 * Throws {@link TracePathError} for paths outside the session roots; ENOENT
 * passes through for the caller's 404 mapping. `fingerprint` may carry the
 * {@link traceFingerprintForEtag} value the caller just computed for the same
 * file (its ETag pre-check), sparing a second walk.
 */
export async function buildSessionTrace(fileParam: string, fingerprint?: TraceFingerprint): Promise<SessionTrace> {
	const resolved = resolveSessionPath(fileParam);
	// Live timings and the rate card come from the database.
	await initDb();
	const memo = traceMemo?.file === resolved ? traceMemo.entry : undefined;
	// Pre-build child fingerprint on EVERY path (hit check and rebuild
	// alike): the post-build race guard compares against this, so a child
	// append landing mid-parse is detected even on first builds and
	// memo-less rebuilds, where no prior fingerprint exists to compare.
	const {
		rootMtimeMs,
		rootSize,
		childFingerprint: preChildFingerprint,
	} = fingerprint ?? (await readTraceFingerprint(resolved));
	if (memo && memo.mtimeMs === rootMtimeMs) {
		// Equality, not <=: a LOWER mark (delete/older-mtime replace) is
		// also stale — only an identical child set may reuse the trace.
		if (preChildFingerprint === memo.childFingerprint) return memo.trace;
	}

	const tracks: TraceTrack[] = [];
	const scans: TrackScan[] = [];
	const rootScan = await buildTrackTree(resolved, "main", null, 0, new Set(), tracks, scans, createUsagePricer());
	if (!rootScan) {
		throw Object.assign(new Error(`ENOENT: session not found: ${resolved}`), { code: "ENOENT" });
	}
	// Re-collect the fingerprint AFTER the parse: a child append landing
	// between the pre-build check and now would otherwise be baked into
	// neither the trace nor the key.
	const post = await readTraceFingerprint(resolved).catch(() => null);
	// Root rewritten mid-build: same no-cache rule as the child race below.
	const rootChanged = post?.rootMtimeMs !== rootMtimeMs;
	const raced = post?.childFingerprint !== preChildFingerprint;
	// Raced builds keep the PRE-build fingerprint as their ETag: the parsed
	// bytes predate the racy write, so claiming the post-write state would
	// 304 stale forever when that write was the child's last. The pre-build
	// key guarantees the next conditional poll misses (filesystem moved on)
	// and rebuilds — at most one stale response per race, never an
	// indefinitely cached one. Unraced builds use the post-build key, which
	// equals the pre-build key by construction.
	const trace = assembleSessionTrace(
		rootScan,
		tracks,
		scans,
		rootMtimeMs,
		traceEtagKey(rootMtimeMs, rootSize, preChildFingerprint),
	);
	if (!raced && !rootChanged) {
		traceMemo = {
			file: resolved,
			entry: { mtimeMs: rootMtimeMs, childFingerprint: preChildFingerprint, trace },
		};
	}
	return trace;
}

/** Shared aggregation after filesystem discovery. */
function assembleSessionTrace(
	rootScan: TrackScan,
	tracks: TraceTrack[],
	scans: TrackScan[],
	rootMtimeMs: number,
	etag: string,
): SessionTrace {
	rootScan.track.label = "Main";

	let startedAt: number | undefined;
	let endedAt: number | undefined;
	const intervals: Array<[number, number]> = [];
	let toolCalls = 0;
	let requests = 0;
	let totalTokens = 0;
	let costTotal = 0;
	let unpricedRequests = 0;
	const toolStats = new Map<string, TraceToolStat>();

	for (const scan of scans) {
		requests += scan.requests;
		toolCalls += scan.toolCalls;
		unpricedRequests += scan.unpricedRequests;
		totalTokens += scan.sideTokens;
		costTotal += scan.sideCost;
		for (const span of scan.track.spans) {
			intervals.push([span.start, span.end]);
			if (startedAt === undefined || span.start < startedAt) startedAt = span.start;
			if (endedAt === undefined || span.end > endedAt) endedAt = span.end;
			if (span.kind === "model") {
				if (span.tokens) totalTokens += span.tokens;
				if (span.cost) costTotal += span.cost;
			} else if (span.kind === "tool") {
				const duration = span.end - span.start;
				const agg = toolStats.get(span.label);
				if (agg) {
					agg.calls++;
					if (span.isError) agg.errors++;
					agg.totalMs += duration;
					if (duration > agg.maxMs) agg.maxMs = duration;
				} else {
					toolStats.set(span.label, {
						tool: span.label,
						calls: 1,
						errors: span.isError ? 1 : 0,
						totalMs: duration,
						maxMs: duration,
					});
				}
			}
		}
	}

	let modelMs = 0;
	let toolMs = 0;
	let turns = 0;
	for (const span of rootScan.track.spans) {
		if (span.kind === "model") modelMs += span.end - span.start;
		else if (span.kind === "tool") toolMs += span.end - span.start;
		else if (span.kind === "turn") turns++;
	}

	const start = startedAt ?? rootScan.headerTs ?? rootMtimeMs;
	const end = endedAt ?? start;
	const wallMs = end - start;

	const summary: TraceSummary = {
		wallMs,
		modelMs,
		toolMs,
		idleMs: Math.max(0, wallMs - unionLength(intervals)),
		turns,
		requests,
		toolCalls,
		subagents: tracks.length - 1,
		totalTokens,
		costTotal,
		unpricedRequests,
		toolStats: [...toolStats.values()].sort((a, b) => b.totalMs - a.totalMs),
	};

	return {
		file: rootScan.track.file,
		title: rootScan.title,
		cwd: rootScan.cwd,
		startedAt: start,
		endedAt: end,
		mtimeMs: rootMtimeMs,
		etag,
		tracks,
		summary,
	};
}

/** Fetch one full session entry by id from a transcript, for the span drawer. */
export async function getTraceEntry(fileParam: string, entryId: string): Promise<SessionEntry | null> {
	const resolved = resolveSessionPath(fileParam);
	let bytes: Uint8Array;
	try {
		bytes = await fs.readFile(resolved);
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	for (const entry of parseAllSessionEntries(bytes)) {
		if ("id" in entry && entry.id === entryId) return entry;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Session list

const headerCwdCache = new Map<string, { mtimeMs: number; cwd: string | null }>();

/** The `cwd` of a transcript the sync has not indexed yet, from its header line. */
async function readHeaderCwd(file: string): Promise<string | null> {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(file, "r");
		const { mtimeMs } = await handle.stat();
		const cached = headerCwdCache.get(file);
		if (cached && cached.mtimeMs === mtimeMs) return cached.cwd;
		const buffer = Buffer.allocUnsafe(HEADER_SCAN_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEADER_SCAN_BYTES, 0);
		const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
		let cwd: string | null = null;
		try {
			const parsed: unknown = JSON.parse(firstLine);
			if (parsed && typeof parsed === "object" && "cwd" in parsed && typeof parsed.cwd === "string") cwd = parsed.cwd;
		} catch {
			// A header longer than the scan window, or no header: fall back to the directory name.
		}
		headerCwdCache.set(file, { mtimeMs, cwd });
		return cwd;
	} catch {
		return null;
	} finally {
		await handle?.close();
	}
}

interface SummaryFold extends SessionSummary {
	modelSet: Set<string>;
}

/** Parse the ms timestamp from a session basename (`2026-09-01T10-24-49-741Z_<uuid>.jsonl`). */
function basenameTimestamp(base: string): number | undefined {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(base);
	if (!match) return undefined;
	const ms = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
	return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The root transcript a stored transcript belongs to: itself, unless it is
 * nested below `<root>/<project>/<session>/`, where it is a child of
 * `<root>/<project>/<session>.jsonl`. Null for a path outside every session root.
 */
function rootTranscriptOf(file: string): { rootFile: string; isChild: boolean } | null {
	const sessionRoot = findSessionRoot(file);
	const rel = path.relative(sessionRoot, file);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
	const segments = rel.split(path.sep);
	if (segments.length <= 2) return { rootFile: file, isChild: false };
	return { rootFile: path.join(sessionRoot, segments[0], `${segments[1]}.jsonl`), isChild: true };
}

/**
 * Root session transcripts found on disk, newest-first by mtime. Lets the
 * Traces list include sessions the sync pass hasn't indexed yet (most
 * importantly the currently running one).
 */
// Short-TTL memo for the disk sweep behind /api/sessions (30s poll): the
// session list changes only on create/edit, so readdir+stat of every file per
// poll is pure syscall churn. TTL is deliberately short so a just-created
// session appears within seconds. Only the newest `limit` roots are kept, so
// the memo stays small however many sessions exist.
let diskRootsMemo:
	| {
			atMs: number;
			sessionRoots: string;
			limit: number;
			roots: Array<{ file: string; mtimeMs: number; startedAt: number }>;
	  }
	| undefined;
const DISK_ROOTS_TTL_MS = 5_000;

async function scanDiskRoots(limit: number): Promise<Array<{ file: string; mtimeMs: number; startedAt: number }>> {
	const now = Date.now();
	const sessionRoots = getSessionRoots();
	const memoKey = sessionRoots.join("\0");
	const memo = diskRootsMemo;
	if (memo && memo.sessionRoots === memoKey && memo.limit >= limit && now - memo.atMs < DISK_ROOTS_TTL_MS) {
		return memo.roots.slice(0, limit);
	}
	const roots: Array<{ file: string; mtimeMs: number; startedAt: number }> = [];
	const addTranscripts = async (dir: string, names: readonly string[]): Promise<void> => {
		await Promise.all(
			names.map(async name => {
				if (!name.endsWith(".jsonl")) return;
				const file = path.join(dir, name);
				try {
					const stat = await fs.stat(file);
					roots.push({ file, mtimeMs: stat.mtimeMs, startedAt: basenameTimestamp(name) ?? stat.mtimeMs });
				} catch {
					// Deleted meanwhile — skip.
				}
			}),
		);
	};
	await Promise.all(
		sessionRoots.map(async sessionRoot => {
			let names: string[];
			try {
				names = await fs.readdir(sessionRoot);
			} catch {
				return; // The root does not exist yet.
			}
			// A custom session dir holds transcripts directly; the default one has a folder per project.
			await addTranscripts(sessionRoot, names);
			await Promise.all(
				names.map(async project => {
					if (project.endsWith(".jsonl")) return;
					try {
						await addTranscripts(path.join(sessionRoot, project), await fs.readdir(path.join(sessionRoot, project)));
					} catch {
						// Not a directory or unreadable — skip.
					}
				}),
			);
		}),
	);
	roots.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const newest = roots.slice(0, limit);
	diskRootsMemo = { atMs: Date.now(), sessionRoots: memoKey, limit, roots: newest };
	return newest.slice();
}

/**
 * List root sessions for the Traces section, folding every synced child
 * transcript into its root row.
 */
export async function listSessionSummaries(limit = 100, q?: string): Promise<SessionSummary[]> {
	// The Traces page may be the first thing a dashboard serves.
	await initDb();
	const byRoot = new Map<string, SummaryFold>();
	const emptyFold = (file: string, startedAt: number, endedAt: number): SummaryFold => ({
		file,
		folder: extractFolderFromPath(file),
		title: null,
		startedAt,
		endedAt,
		requests: 0,
		toolCalls: 0,
		subagents: 0,
		totalTokens: 0,
		costTotal: 0,
		unpricedRequests: 0,
		models: [],
		modelSet: new Set(),
	});

	for (const row of getSessionRollups()) {
		const owner = rootTranscriptOf(row.sessionFile);
		if (!owner) continue;
		let fold = byRoot.get(owner.rootFile);
		if (!fold) {
			fold = emptyFold(owner.rootFile, row.startedAt, row.endedAt);
			byRoot.set(owner.rootFile, fold);
		}
		fold.requests += row.requests;
		fold.toolCalls += row.toolCalls;
		if (owner.isChild) fold.subagents++;
		if (row.startedAt < fold.startedAt) fold.startedAt = row.startedAt;
		if (row.endedAt > fold.endedAt) fold.endedAt = row.endedAt;
		fold.totalTokens += row.totalTokens ?? 0;
		fold.costTotal += row.costTotal ?? 0;
		fold.unpricedRequests += row.unpricedRequests ?? 0;
		if (row.models) {
			for (const model of row.models.split(",")) {
				if (model) fold.modelSet.add(model);
			}
		}
	}

	// Fold in on-disk roots the sync pass hasn't indexed yet, so the currently
	// running session shows up without a manual Sync.
	for (const root of await scanDiskRoots(LIST_FOLD_LIMIT)) {
		const existing = byRoot.get(root.file);
		if (existing) {
			// Live sessions keep writing after the last sync; sort by real recency.
			if (root.mtimeMs > existing.endedAt) existing.endedAt = root.mtimeMs;
			continue;
		}
		byRoot.set(root.file, emptyFold(root.file, root.startedAt, root.mtimeMs));
	}

	const folds = [...byRoot.values()].sort((a, b) => b.endedAt - a.endedAt).slice(0, LIST_FOLD_LIMIT);
	// The sync cursor already holds each indexed session's folder and title; only unindexed files are read.
	const cursors = getFileOffsets(folds.map(fold => fold.file));
	await Promise.all(
		folds.map(async fold => {
			const state = cursors.get(fold.file)?.parserState;
			fold.title = state?.sessionName ?? state?.firstPrompt ?? null;
			const cwd = state ? state.folder : await readHeaderCwd(fold.file);
			if (cwd) fold.folder = projectFolder(cwd);
			fold.models = [...fold.modelSet].sort();
		}),
	);

	let rows: SessionSummary[] = folds.map(({ modelSet: _modelSet, ...summary }) => summary);
	if (q?.trim()) {
		const needle = q.trim().toLowerCase();
		rows = rows.filter(
			row =>
				(row.title ?? "").toLowerCase().includes(needle) ||
				row.folder.toLowerCase().includes(needle) ||
				path.basename(row.file).toLowerCase().includes(needle),
		);
	}
	return rows.slice(0, limit);
}
