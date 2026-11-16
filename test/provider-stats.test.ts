import { describe, expect, it } from "vitest";
import { getProviderDashboardStats } from "../src/aggregator";
import { initDb, insertMessageStats } from "../src/db";
import type { MessageStatsInput } from "../src/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-providers-");

const T0 = Date.UTC(2026, 6, 20, 10, 0, 0);
const MINUTE = 60_000;

function message(overrides: Partial<MessageStatsInput> & { entryId: string }): MessageStatsInput {
	return {
		sessionFile: "/tmp/session.jsonl",
		folder: "/tmp/project",
		model: "model-x",
		provider: "prov-a",
		api: "openai-completions",
		timestamp: T0,
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 600,
			output: 300,
			cacheRead: 100,
			cacheWrite: 0,
			totalTokens: 1000,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
		},
		agentType: "main",
		...overrides,
	};
}

describe("getProviderDashboardStats", () => {
	it("aggregates per-provider totals, hourly burn, and the token series", async () => {
		await initDb();
		insertMessageStats([
			message({ entryId: "a1", provider: "prov-a", timestamp: T0 }),
			message({ entryId: "a2", provider: "prov-a", timestamp: T0 + MINUTE, stopReason: "error" }),
			message({
				entryId: "b1",
				provider: "prov-b",
				model: "model-y",
				timestamp: T0 + 2 * MINUTE,
				duration: null,
				ttft: null,
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
					cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
				},
			}),
		]);

		const stats = await getProviderDashboardStats("all");

		expect(stats.providers.map(p => p.provider)).toEqual(["prov-a", "prov-b"]);
		const [provA, provB] = stats.providers;
		expect(provA.totalRequests).toBe(2);
		expect(provA.failedRequests).toBe(1);
		expect(provA.totalTokens).toBe(2000);
		expect(provA.models).toBe(1);
		// 300 output tokens over 1 s for both timed requests.
		expect(provA.avgTokensPerSecond).toBe(300);
		// A provider with no timed request has no throughput, not a throughput of zero.
		expect(provB.avgTokensPerSecond).toBeNull();

		// All prov-a messages land in one local hour bucket.
		const provAHours = stats.hourly.filter(p => p.provider === "prov-a");
		expect(provAHours).toHaveLength(1);
		expect(provAHours[0].hour).toBeGreaterThanOrEqual(0);
		expect(provAHours[0].hour).toBeLessThan(24);
		expect(provAHours[0].totalTokens).toBe(2000);
		expect(provAHours[0].outputTokens).toBe(600);
		expect(provAHours[0].requests).toBe(2);
		expect(stats.series.some(p => p.provider === "prov-b" && p.totalTokens === 150)).toBe(true);
	});
});
