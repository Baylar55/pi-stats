import { describe, expect, it } from "vitest";
import { syncAllSessions } from "../src/aggregator";
import { closeDb, getRecentRequests, initDb, insertMessageStats } from "../src/db";
import { getOverallStats } from "../src/rollup";
import type { MessageStatsInput } from "../src/types";
import { assistant, header, sessionPath, T0, toolCall, toolResult, usage, user, writeSession } from "./helpers/session";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-fork-dedup-");

const USAGE = usage({ input: 100, output: 50, totalTokens: 150 });
const turn = (n: number, parentId: string | null): Record<string, unknown>[] => [
	user(`user-${n}`, "hello", { parentId, timestamp: T0 + n * 1000 }),
	assistant(`asst-${n}`, { parentId: `user-${n}`, timestamp: T0 + n * 1000 + 1, message: { usage: USAGE } }),
];

describe("stats sync deduplicates forked-session entries", () => {
	// `/fork` (`SessionManager.forkFrom`) writes a new header with `parentSession`
	// and copies every other entry of the source file verbatim.
	it("counts a verbatim /fork copy once and attributes it to the original transcript", async () => {
		const entries = [...turn(1, null), ...turn(2, "asst-1")];
		const parent = await writeSession(sessionPath("01_parent.jsonl"), [header(), ...entries]);
		await syncAllSessions({ workers: 1 });
		await writeSession(sessionPath("02_fork.jsonl"), [header("/work/project", { id: "fork", parentSession: parent }), ...entries]);
		await syncAllSessions({ workers: 1 });

		const requests = getRecentRequests(10);
		expect(requests.map(r => r.entryId).sort()).toEqual(["asst-1", "asst-2"]);
		expect(new Set(requests.map(r => r.sessionFile))).toEqual(new Set([parent]));
		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(2);
		expect(overall.totalInputTokens).toBe(200);
		expect(overall.totalOutputTokens).toBe(100);
		expect(overall.totalCost).toBeCloseTo(0.006, 8);
		const users = (await initDb()).prepare<{ n: number }>("SELECT COUNT(*) AS n FROM user_messages").get();
		expect(users?.n).toBe(2);
	});

	it("counts a fork once when both files are ingested from scratch in one pass", async () => {
		const entries = turn(1, null);
		const parent = await writeSession(sessionPath("01_parent.jsonl"), [header(), ...entries]);
		await writeSession(sessionPath("02_fork.jsonl"), [header("/work/project", { parentSession: parent }), ...entries]);

		await syncAllSessions({ workers: 1 });

		expect(getOverallStats()).toMatchObject({ totalRequests: 1, totalInputTokens: 100 });
	});

	// Branching (`createBranchedSession`) copies only the root-to-leaf path, keeps each
	// entry's id and timestamp, and re-chains `parentId` where labels were dropped.
	it("counts a branch copy with re-chained parents once", async () => {
		const parent = await writeSession(sessionPath("01_parent.jsonl"), [
			header(),
			...turn(1, null),
			{ type: "label", id: "label-1", parentId: "asst-1", timestamp: new Date(T0).toISOString(), targetId: "asst-1", label: "keep" },
			...turn(2, "label-1"),
			...turn(3, "asst-1"),
		]);
		const [user2, asst2] = turn(2, "asst-1");
		await writeSession(sessionPath("02_branch.jsonl"), [
			header("/work/project", { id: "branch", parentSession: parent }),
			...turn(1, null),
			user2,
			asst2,
		]);

		await syncAllSessions({ workers: 1 });

		expect(getOverallStats()).toMatchObject({ totalRequests: 3, totalInputTokens: 300 });
	});

	it("admits new entries appended in the forked session", async () => {
		const parent = await writeSession(sessionPath("01_parent.jsonl"), [header(), ...turn(1, null)]);
		// After the fork, the child appends a fresh turn: inherited entries dedupe, new ones count.
		await writeSession(sessionPath("02_fork.jsonl"), [
			header("/work/project", { parentSession: parent }),
			...turn(1, null),
			...turn(2, "asst-1"),
		]);

		await syncAllSessions({ workers: 1 });

		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(2);
		expect(overall.totalInputTokens).toBe(200);
		expect(overall.totalCost).toBeCloseTo(0.006, 8);
	});

	it("does not double-count tool calls and usage entries copied into a fork", async () => {
		const entries = [
			assistant("a1", { message: { content: [toolCall("call-1", "bash")] } }),
			toolResult("r1", "call-1", "out", { parentId: "a1" }),
			{ type: "usage", id: "warm", parentId: "r1", timestamp: new Date(T0).toISOString(), kind: "cache_warm", provider: "openai", model: "gpt-x", usage: usage() },
		];
		const parent = await writeSession(sessionPath("01_parent.jsonl"), [header(), ...entries]);
		await writeSession(sessionPath("02_fork.jsonl"), [header("/work/project", { parentSession: parent }), ...entries]);

		await syncAllSessions({ workers: 1 });

		expect(getOverallStats().totalRequests).toBe(2);
		const calls = (await initDb()).prepare<{ n: number }>("SELECT COUNT(*) AS n FROM tool_calls").get();
		expect(calls?.n).toBe(1);
	});

	it("collapses pre-existing duplicate rows on init (one-shot migration)", async () => {
		const db = await initDb();
		const stat = (sessionFile: string): MessageStatsInput => ({
			sessionFile,
			entryId: "dup",
			folder: "/work/project",
			model: "gpt-x",
			provider: "openai",
			api: "openai-responses",
			timestamp: T0,
			duration: null,
			ttft: null,
			stopReason: "stop",
			errorMessage: null,
			usage: USAGE,
			agentType: "main",
		});
		insertMessageStats([stat("/s/parent.jsonl")]);
		// A row an older build stored under the fork before the guard existed.
		db.run("INSERT INTO messages (session_file, entry_id, folder, model, provider, api, timestamp, stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total) SELECT '/s/fork.jsonl', entry_id, folder, model, provider, api, timestamp, stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, cost_input, cost_output, cost_cache_read, cost_cache_write, cost_total FROM messages");
		db.run("DELETE FROM meta WHERE key = 'fork_dedupe_v1'");
		closeDb();

		await initDb();

		const rows = getRecentRequests(10);
		expect(rows).toHaveLength(1);
		expect(rows[0].sessionFile).toBe("/s/parent.jsonl");
	});
});
