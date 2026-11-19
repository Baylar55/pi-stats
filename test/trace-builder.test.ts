/**
 * Contracts for the session trace builder: span timing joins (durations, tool
 * results, live timings), turn segmentation, child-session linkage, active
 * branch filtering, summary aggregation, session-list folding, and the
 * client-path containment boundary.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { syncAllSessions } from "../src/aggregator";
import { getSessionsDir } from "../src/config";
import { initDb, recordTiming } from "../src/db";
import { setModelPrices } from "../src/pricing";
import { getOverallStats } from "../src/rollup";
import {
	buildSessionTrace,
	getTraceEntry,
	listSessionSummaries,
	TracePathError,
} from "../src/trace";
import { assistant, header, sessionPath, toolCall, toolResult, usage, user, writeSession } from "./helpers/session";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-trace-");

const T = 1_700_000_000_000;
const ROOT_BASE = "2023-11-14T22-13-20-000Z_test.jsonl";
const iso = (ms: number) => new Date(ms).toISOString();
const USAGE = usage({ input: 60, output: 40, totalTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } });

/** An assistant entry that started at `start` and was persisted at `end`. */
function reply(id: string, parentId: string | null, start: number, end: number, message: Record<string, unknown> = {}) {
	return { ...assistant(id, { parentId, timestamp: start, message: { model: "m-1", usage: USAGE, ...message } }), timestamp: iso(end) };
}

/**
 * Main session: two turns. Turn 1 calls bash (3 s, result carries durationMs)
 * and read (no durationMs: starts when the model stopped); an abandoned branch
 * hangs off u1. Turn 2 starts after a 10 s pause and leaves a call running.
 */
const ROOT_ENTRIES = [
	header("/tmp/proj"),
	{ type: "session_info", id: "info", parentId: null, timestamp: iso(T), name: "Fixture Session" },
	user("u1", "first question", { timestamp: T + 1_000 }),
	reply("abandoned", "u1", T + 1_100, T + 1_900),
	{ type: "model_change", id: "mc", parentId: "u1", timestamp: iso(T + 1_950), provider: "prov", modelId: "m-1" },
	reply("a1", "mc", T + 2_000, T + 5_000, {
		durationMs: 3_000,
		content: [{ type: "text", text: "running things" }, toolCall("call1", "bash", { command: "ls -la" }), toolCall("call2", "read", { path: "/tmp/f" })],
	}),
	{ ...toolResult("r1", "call1", "out", { parentId: "a1", timestamp: T + 8_500, message: { durationMs: 3_000 } }), timestamp: iso(T + 8_500) },
	{ ...toolResult("r2", "call2", "boom", { parentId: "r1", timestamp: T + 9_000, isError: true }), timestamp: iso(T + 9_000) },
	// Older pi: no durationMs, the duration is the gap between request start and persist time.
	reply("a2", "r2", T + 9_500, T + 12_000),
	{ type: "compaction", id: "cmp", parentId: "a2", timestamp: iso(T + 12_500), summary: "s", firstKeptEntryId: "a2", tokensBefore: 142_000, usage: USAGE },
	user("u2", "second question", { parentId: "cmp", timestamp: T + 22_000 }),
	reply("a3", "u2", T + 22_500, T + 24_000, { content: [toolCall("call3", "bash", { command: "sleep 100" })], stopReason: "toolUse" }),
	{ type: "usage", id: "warm", parentId: "a3", timestamp: iso(T + 30_000), kind: "cache_warm", provider: "prov", model: "m-1", usage: USAGE },
];

async function writeFixture(): Promise<string> {
	return writeSession(sessionPath(ROOT_BASE), ROOT_ENTRIES);
}

describe("buildSessionTrace", () => {
	it("assembles model, tool and turn spans with correct timing joins", async () => {
		const trace = await buildSessionTrace(await writeFixture());

		expect(trace).toMatchObject({ title: "Fixture Session", cwd: "/tmp/proj" });
		const main = trace.tracks[0];
		expect(main).toMatchObject({ id: "main", label: "Main", model: "m-1", parentId: null });
		const byId = new Map(main.spans.map(span => [span.id, span]));

		// Model spans: recorded durationMs, and the two-timestamp gap where there is none.
		expect(byId.get("main:a1")).toMatchObject({ kind: "model", start: T + 2_000, end: T + 5_000, tokens: 100, cost: 0.01, detail: "running things" });
		expect(byId.get("main:a2")).toMatchObject({ kind: "model", start: T + 9_500, end: T + 12_000 });
		// The abandoned branch is not on the active chain.
		expect(byId.has("main:abandoned")).toBe(false);
		// No live timing was captured for this session: no span claims a time to first token.
		expect(main.spans.every(span => span.ttft === undefined)).toBe(true);

		// Tool spans: a recorded durationMs places the start; otherwise the call starts when the model stopped.
		expect(byId.get("main:a1:call1")).toMatchObject({ kind: "tool", label: "bash", start: T + 5_500, end: T + 8_500, detail: "ls -la", entryId: "r1" });
		expect(byId.get("main:a1:call2")).toMatchObject({ kind: "tool", label: "read", start: T + 5_000, end: T + 9_000, isError: true });
		// A call with no result was still running at the transcript's last entry.
		expect(byId.get("main:a3:call3")).toMatchObject({ kind: "tool", start: T + 24_000, end: T + 30_000, unterminated: true });

		// Turns run from the user message to the last span that started before the next one.
		expect(byId.get("main:u1")).toMatchObject({ kind: "turn", label: "first question", start: T + 1_000, end: T + 12_000 });
		expect(byId.get("main:u2")).toMatchObject({ kind: "turn", start: T + 22_000, end: T + 30_000 });

		expect(main.markers).toEqual([
			{ time: T + 1_950, kind: "model_change", label: "m-1" },
			{ time: T + 12_500, kind: "compaction", label: "compaction 142k" },
		]);
	});

	it("aggregates summary counts, tool stats, and idle time", async () => {
		const { summary } = await buildSessionTrace(await writeFixture());

		expect(summary.turns).toBe(2);
		// a1, a2, a3 plus the compaction's and the usage entry's own usage; the abandoned branch is excluded.
		expect(summary.requests).toBe(5);
		expect(summary.toolCalls).toBe(3);
		expect(summary.subagents).toBe(0);
		expect(summary.totalTokens).toBe(500);
		expect(summary.costTotal).toBeCloseTo(0.05, 10);
		expect(summary.unpricedRequests).toBe(0);

		// bash: call1 (3 s) + call3 (6 s); read: call2 (4 s). Sorted by total desc.
		expect(summary.toolStats).toEqual([
			{ tool: "bash", calls: 2, errors: 0, totalMs: 9_000, maxMs: 6_000 },
			{ tool: "read", calls: 1, errors: 1, totalMs: 4_000, maxMs: 4_000 },
		]);
		expect(summary.modelMs).toBe(3_000 + 2_500 + 1_500);
		// Wall = first turn start → running tool's end; idle = the 10 s before turn 2.
		expect(summary.wallMs).toBe(29_000);
		expect(summary.idleMs).toBe(10_000);
	});

	it("shows a live timing's time to first token, and uses it for a span with no other duration", async () => {
		const file = await writeSession(sessionPath(ROOT_BASE), [
			header("/tmp/proj"),
			user("u1", "hi", { timestamp: T }),
			// Persist time before the request start: nothing in the transcript gives this span a width.
			reply("a1", "u1", T + 1_000, T + 500),
		]);
		await initDb();
		recordTiming({ sessionFile: file, entryId: "a1", requestStart: T + 1_000, firstTokenAt: T + 1_300, endAt: T + 4_000 });

		const span = (await buildSessionTrace(file)).tracks[0].spans.find(candidate => candidate.kind === "model");

		expect(span).toMatchObject({ start: T + 1_000, end: T + 4_000, ttft: 300 });
	});

	it("rebuilds a polled trace when a live timing lands without the transcript changing", async () => {
		const file = await writeFixture();
		const before = await buildSessionTrace(file);
		recordTiming({ sessionFile: file, entryId: "a3", requestStart: T + 22_500, firstTokenAt: T + 22_900, endAt: T + 24_000 });
		const after = await buildSessionTrace(file);

		expect(after.etag).not.toBe(before.etag);
		expect(after.tracks[0].spans.find(span => span.id === "main:a3")?.ttft).toBe(400);
	});

	it("prices zero-cost usage like the Costs page and reports unpriced requests instead of free ones", async () => {
		const zero = usage({ input: 1_000, output: 500, totalTokens: 1_500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
		const file = await writeSession(sessionPath(ROOT_BASE), [
			header("/tmp/proj"),
			user("u1", "hi", { timestamp: T }),
			reply("sub", "u1", T + 1_000, T + 2_000, { provider: "openai-codex", model: "gpt-x", usage: zero }),
			// A legacy entry with tokens but no total and no cost still classifies as unpriced.
			reply("mystery", "sub", T + 3_000, T + 4_000, { provider: "antigravity", model: "gemini-z", usage: { input: 70, output: 30, cacheRead: 0, cacheWrite: 0 } }),
		]);
		await initDb();
		setModelPrices([{ provider: "openai", model: "gpt-x", input: 2, output: 8, cacheRead: 0, cacheWrite: 0 }]);

		const trace = await buildSessionTrace(file);
		await syncAllSessions({ workers: 1 });

		expect(trace.summary).toMatchObject({ requests: 2, totalTokens: 1_600, unpricedRequests: 1 });
		expect(trace.summary.costTotal).toBeCloseTo(0.006, 10);
		// The trace headline and the dashboard totals come from the same rule.
		expect(getOverallStats(null)).toMatchObject({ totalRequests: 2, unpricedRequests: 1 });
		expect(getOverallStats(null).totalCost).toBeCloseTo(trace.summary.costTotal, 10);
		const mystery = trace.tracks[0].spans.find(span => span.id === "main:mystery");
		expect(mystery?.cost).toBeUndefined();
	});

	it("folds a nested child transcript in as its own track with a span on the parent", async () => {
		const rootFile = await writeFixture();
		await writeSession(path.join(rootFile.slice(0, -".jsonl".length), "Scout1.jsonl"), [
			header("/tmp/proj"),
			user("cu", "scout this", { timestamp: T + 6_000 }),
			reply("ca", "cu", T + 6_100, T + 7_000, { model: "m-scout" }),
		]);

		const trace = await buildSessionTrace(rootFile);

		expect(trace.tracks.map(track => [track.id, track.parentId, track.label])).toEqual([
			["main", null, "Main"],
			["Scout1", "main", "agent Scout1"],
		]);
		expect(trace.summary).toMatchObject({ subagents: 1, requests: 6 });
		expect(trace.tracks[0].spans.find(span => span.kind === "subagent")).toMatchObject({
			childTrackId: "Scout1",
			model: "m-scout",
			start: T + 6_000,
			end: T + 7_000,
		});
	});

	it("rejects paths outside the session roots", async () => {
		const rootFile = await writeFixture();
		await expect(buildSessionTrace("/etc/passwd.jsonl")).rejects.toThrow(TracePathError);
		await expect(buildSessionTrace(path.join(getSessionsDir(), "..", "escape.jsonl"))).rejects.toThrow(TracePathError);
		await expect(buildSessionTrace(path.join(path.dirname(rootFile), "..", "..", "stats.db"))).rejects.toThrow(TracePathError);
		// Inside a root, but not a transcript.
		await expect(buildSessionTrace(path.join(path.dirname(rootFile), "notes.txt"))).rejects.toThrow(TracePathError);
		await expect(getTraceEntry(path.join(getSessionsDir(), "..", "settings.json"), "x")).rejects.toThrow(TracePathError);
		// The sessions directory itself is not a file below it.
		await expect(buildSessionTrace(getSessionsDir())).rejects.toThrow(TracePathError);
	});

	it("reports a missing transcript inside a root as not found, not as a path error", async () => {
		await expect(buildSessionTrace(sessionPath("missing.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("getTraceEntry", () => {
	it("returns the full session entry by id and null for unknown ids", async () => {
		const rootFile = await writeFixture();
		expect(await getTraceEntry(rootFile, "a1")).toMatchObject({ type: "message", id: "a1" });
		expect(await getTraceEntry(rootFile, "nope")).toBeNull();
	});
});

describe("listSessionSummaries", () => {
	it("lists unsynced on-disk sessions with their cwd before any sync", async () => {
		const rootFile = await writeFixture();
		const bare = await writeSession(sessionPath("bare.jsonl", "--home-me-legacy--"), [user("u", "hello")]);

		const rows = await listSessionSummaries();

		expect(rows.find(row => row.file === rootFile)).toMatchObject({ folder: "/tmp/proj", requests: 0, startedAt: T });
		// No header: the directory name is the only clue.
		expect(rows.find(row => row.file === bare)?.folder).toBe("/home/me/legacy");
	});

	it("titles a synced session by its name, or by its first prompt when unnamed", async () => {
		const named = await writeFixture();
		const unnamed = await writeSession(sessionPath("unnamed.jsonl"), [header("/tmp/proj"), user("u", "refactor   the\nauth module"), reply("a", "u", T, T + 1)]);
		await syncAllSessions({ workers: 1 });

		const rows = await listSessionSummaries();

		expect(rows.find(row => row.file === named)?.title).toBe("Fixture Session");
		expect(rows.find(row => row.file === unnamed)?.title).toBe("refactor the auth module");
	});

	it("folds synced child transcripts into the root row and filters by q", async () => {
		const rootFile = await writeFixture();
		await writeSession(path.join(rootFile.slice(0, -".jsonl".length), "Scout1.jsonl"), [
			header("/tmp/proj"),
			reply("ca", null, T + 6_100, T + 7_000, { model: "m-scout" }),
		]);
		await syncAllSessions({ workers: 1 });

		const rows = await listSessionSummaries();
		const row = rows.find(r => r.file === rootFile);
		expect(row).toBeDefined();
		expect(row?.subagents).toBe(1);
		// 4 main assistant rows (incl. abandoned; sync is branch-agnostic) + compaction + usage entry + 1 child.
		expect(row?.requests).toBe(7);
		expect(row?.models).toEqual(["m-1", "m-scout"]);
		expect(rows).toHaveLength(1);

		expect((await listSessionSummaries(100, "fixture")).some(r => r.file === rootFile)).toBe(true);
		expect(await listSessionSummaries(100, "zzz-no-match")).toEqual([]);
	});

	it("never lists a file that is not below a session root", async () => {
		await writeFixture();
		await fs.writeFile(path.join(getSessionsDir(), "..", "stray.jsonl"), "{}\n");

		expect((await listSessionSummaries()).every(row => row.file.startsWith(getSessionsDir()))).toBe(true);
	});
});
