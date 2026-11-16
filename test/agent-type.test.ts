import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { getOverviewStats } from "../src/aggregator";
import { addSessionRoot, getSessionsDir } from "../src/config";
import { initDb, insertMessageStats } from "../src/db";
import { classifyAgentType } from "../src/parser";
import { getStatsByAgentType } from "../src/rollup";
import type { AgentType, MessageStatsInput } from "../src/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

const isolation = installStatsTestIsolation("@pi-stats-agent-type-");

interface Tokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function makeMessage(entryId: string, agentType: AgentType, tokens: Tokens): MessageStatsInput {
	return {
		sessionFile: `/tmp/${agentType}.jsonl`,
		entryId,
		folder: "/tmp/project",
		model: "claude-s",
		provider: "anthropic",
		api: "anthropic-messages",
		timestamp: Date.now(),
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: tokens.input,
			output: tokens.output,
			cacheRead: tokens.cacheRead,
			cacheWrite: tokens.cacheWrite,
			totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		},
		agentType,
	};
}

describe("classifyAgentType", () => {
	it("classifies transcripts by their depth below the session root", () => {
		const project = path.join(getSessionsDir(), "--work-pi--");
		const session = path.join(project, "2026-01-01T00-00-00-000Z_abc");
		expect(classifyAgentType(path.join(project, "2026-01-01T00-00-00-000Z_abc.jsonl"))).toBe("main");
		expect(classifyAgentType(path.join(session, "AuthLoader.jsonl"))).toBe("subagent");
		// A subagent that spawned its own subagent is still a subagent.
		expect(classifyAgentType(path.join(session, "AuthLoader", "Nested.jsonl"))).toBe("subagent");
	});

	it("treats a transcript in a flat custom session dir as the main agent", () => {
		const custom = isolation.current()?.join("custom-sessions");
		if (!custom) throw new Error("no temp dir");
		addSessionRoot(custom);

		expect(classifyAgentType(path.join(custom, "2026-01-01T00-00-00-000Z_abc.jsonl"))).toBe("main");
	});
});

describe("getStatsByAgentType", () => {
	it("groups token usage and requests by agent type", async () => {
		await initDb();
		insertMessageStats([
			makeMessage("m1", "main", { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 }),
			makeMessage("m2", "main", { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 }),
			makeMessage("s1", "subagent", { input: 40, output: 20, cacheRead: 0, cacheWrite: 0 }),
		]);

		const byType = new Map(getStatsByAgentType().map(stat => [stat.agentType, stat]));
		expect(byType.get("main")).toMatchObject({
			totalRequests: 2,
			totalInputTokens: 200,
			totalOutputTokens: 100,
			totalCacheReadTokens: 20,
		});
		expect(byType.get("subagent")).toMatchObject({ totalRequests: 1, totalInputTokens: 40 });
	});

	it("surfaces the breakdown through the overview payload", async () => {
		await initDb();
		insertMessageStats([
			makeMessage("m1", "main", { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }),
			makeMessage("s1", "subagent", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
		]);

		const overview = await getOverviewStats("all");
		expect(overview.byAgentType.map(stat => stat.agentType).sort()).toEqual(["main", "subagent"]);
	});
});
