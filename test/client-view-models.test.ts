import { describe, expect, it } from "vitest";
import { NAV } from "../src/client/app/nav";
import { formatDurationMs, formatEstimatedCost } from "../src/client/data/formatters";
import { parseHash } from "../src/client/data/useHashRoute";
import {
	buildAgentTokenShare,
	buildCostSummary,
	buildModelPerformanceLookup,
	summarizeRequests,
} from "../src/client/data/view-models";
import type { MessageStats } from "../src/client/types";
import type { AgentTypeStats, CostTimeSeriesPoint, ModelPerformancePoint } from "../src/shared-types";

const DAY = 24 * 60 * 60 * 1000;

describe("client view models", () => {
	it("keeps sparse model performance buckets in time order instead of dropping old points", () => {
		const points: ModelPerformancePoint[] = [
			{
				timestamp: DAY * 10,
				model: "gpt-5.5",
				provider: "openai-codex",
				requests: 2,
				avgTtft: 500,
				avgTokensPerSecond: 60,
			},
			{
				timestamp: DAY,
				model: "gpt-5.5",
				provider: "openai-codex",
				requests: 1,
				avgTtft: 250,
				avgTokensPerSecond: 40,
			},
			{
				timestamp: DAY * 5,
				model: "gpt-5.5",
				provider: "openai",
				requests: 3,
				avgTtft: null,
				avgTokensPerSecond: null,
			},
		];

		const lookup = buildModelPerformanceLookup(points);
		const series = lookup.get("gpt-5.5::openai-codex");

		expect(series?.map(point => point.timestamp)).toEqual([DAY, DAY * 10]);
		expect(series?.map(point => point.requests)).toEqual([1, 2]);
		expect(series?.map(point => point.avgTtftSeconds)).toEqual([0.25, 0.5]);
		// A bucket with no timed request is not a sample: it never reaches the chart.
		expect(lookup.has("gpt-5.5::openai")).toBe(false);
	});

	it("keeps a bucket that has throughput but no TTFT, leaving the TTFT point null", () => {
		// Transcript `durationMs` gives duration (and tokens/s) for messages pi never timed live.
		const lookup = buildModelPerformanceLookup([
			{ timestamp: DAY, model: "sonnet", provider: "anthropic", requests: 4, avgTtft: null, avgTokensPerSecond: 55 },
		]);
		expect(lookup.get("sonnet::anthropic")).toEqual([
			{ timestamp: DAY, avgTtftSeconds: null, avgTokensPerSecond: 55, requests: 4 },
		]);
	});
});

function request(id: number, timing: { duration: number | null; ttft: number | null }): MessageStats {
	return {
		id,
		sessionFile: "/sessions/a.jsonl",
		entryId: `entry-${id}`,
		folder: "/work/pi",
		model: "sonnet",
		provider: "anthropic",
		api: "anthropic-messages",
		timestamp: DAY + id,
		duration: timing.duration,
		ttft: timing.ttft,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
		},
	};
}

describe("summarizeRequests timing", () => {
	it("takes medians over timed requests only", () => {
		const summary = summarizeRequests([
			request(1, { duration: null, ttft: null }),
			request(2, { duration: 2000, ttft: null }),
			request(3, { duration: 4000, ttft: 300 }),
			request(4, { duration: null, ttft: null }),
		]);
		expect(summary.requests).toBe(4);
		expect(summary.medianDuration).toBe(2000);
		expect(summary.p95Duration).toBe(4000);
		expect(summary.medianTtft).toBe(300);
	});

	it("reports no latency at all when nothing was timed", () => {
		const summary = summarizeRequests([request(1, { duration: null, ttft: null })]);
		expect(summary.medianDuration).toBeNull();
		expect(summary.medianTtft).toBeNull();
		expect(formatDurationMs(summary.medianDuration)).toBe("N/A");
	});
});

function costPoint(timestamp: number, model: string, provider: string, cost: Partial<CostTimeSeriesPoint> = {}) {
	return {
		timestamp,
		model,
		provider,
		cost: 0,
		unpricedRequests: 0,
		costInput: 0,
		costOutput: 0,
		costCacheRead: 0,
		costCacheWrite: 0,
		requests: 1,
		...cost,
	} satisfies CostTimeSeriesPoint;
}

describe("buildCostSummary", () => {
	it("aggregates per model+provider, ranks by estimate, and averages over active days", () => {
		const summary = buildCostSummary([
			costPoint(DAY, "sonnet", "anthropic", { cost: 3, costInput: 1, costOutput: 2, requests: 2 }),
			costPoint(DAY, "sonnet", "bedrock", { cost: 1, costOutput: 1 }),
			costPoint(DAY * 3, "sonnet", "anthropic", { cost: 2, costCacheRead: 0.5, costCacheWrite: 1.5 }),
			costPoint(DAY * 3, "grok", "xai-oauth", { unpricedRequests: 4, requests: 4 }),
		]);

		expect(summary.totalCost).toBe(6);
		expect(summary.activeDays).toBe(2);
		expect(summary.avgDailyCost).toBe(3);
		expect(summary.unpricedRequests).toBe(4);
		expect(summary.requests).toBe(8);
		expect([summary.costInput, summary.costOutput, summary.costCacheRead, summary.costCacheWrite]).toEqual([
			1, 3, 0.5, 1.5,
		]);
		expect(summary.models.map(m => m.key)).toEqual(["sonnet::anthropic", "sonnet::bedrock", "grok::xai-oauth"]);
		expect(summary.models[0]).toMatchObject({ cost: 5, requests: 3, costCacheWrite: 1.5 });
		expect(summary.models[0].share).toBeCloseTo(5 / 6, 8);
		expect(summary.topModel?.key).toBe("sonnet::anthropic");
	});

	it("reports no top model when every request is unpriced", () => {
		const summary = buildCostSummary([costPoint(DAY, "grok", "xai-oauth", { unpricedRequests: 2, requests: 2 })]);
		expect(summary.topModel).toBeNull();
		expect(summary.models[0].share).toBe(0);
		expect(formatEstimatedCost(summary.totalCost, summary.unpricedRequests)).toBe("N/A");
	});
});

describe("API-equivalent cost formatting", () => {
	it("distinguishes unpriced subscription usage from a zero-dollar estimate", () => {
		expect(formatEstimatedCost(0, 1)).toBe("N/A");
		expect(formatEstimatedCost(0, 0)).toBe("$0");
		expect(formatEstimatedCost(1.5, 1)).toBe("$1.50");
	});
});

function agentStats(
	agentType: AgentTypeStats["agentType"],
	tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
	totalRequests = 1,
): AgentTypeStats {
	return {
		agentType,
		totalRequests,
		totalInputTokens: tokens.input,
		totalOutputTokens: tokens.output,
		totalCacheReadTokens: tokens.cacheRead ?? 0,
		totalCacheWriteTokens: tokens.cacheWrite ?? 0,
		totalCost: 0,
	};
}

describe("buildAgentTokenShare", () => {
	it("orders segments main -> subagent and shares sum to 1", () => {
		// Insertion order is intentionally scrambled to prove the fixed ordering.
		const view = buildAgentTokenShare([
			agentStats("subagent", { input: 40, output: 20 }),
			agentStats("main", { input: 50, output: 30, cacheRead: 20 }),
		]);

		expect(view.segments.map(s => s.agentType)).toEqual(["main", "subagent"]);
		// Denominator is input+output+cacheRead+cacheWrite: 100 + 60 = 160.
		expect(view.totalTokens).toBe(160);
		expect(view.segments[0].tokens).toBe(100);
		expect(view.segments[0].share).toBeCloseTo(100 / 160, 8);
		expect(view.segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 8);
	});

	it("omits absent agent types and reports zero totals without dividing by zero", () => {
		const present = buildAgentTokenShare([agentStats("main", { input: 5, output: 5 })]);
		expect(present.segments.map(s => s.agentType)).toEqual(["main"]);
		expect(present.segments[0].share).toBe(1);

		const empty = buildAgentTokenShare([]);
		expect(empty.totalTokens).toBe(0);
		expect(empty.segments).toEqual([]);
	});
});

describe("dashboard navigation", () => {
	it("lists the three sidebar groups with their jump keys", () => {
		expect(NAV.map(group => [group.heading, group.items.map(item => `${item.id}:${item.hotkey}`)])).toEqual([
			["Usage", ["overview:o", "models:m", "providers:p", "costs:c"]],
			["Activity", ["requests:r", "errors:e", "traces:t"]],
			["Insights", ["tools:l", "frustration:f", "projects:j"]],
		]);
	});

	it("resolves every page by hash and sends unknown pages to the overview", () => {
		for (const item of NAV.flatMap(group => group.items)) {
			expect(parseHash(`#/${item.id}?range=7d`)).toEqual({ section: item.id, range: "7d", session: null });
		}
		expect(parseHash("#/nowhere").section).toBe("overview");
		expect(parseHash("#/nowhere?range=30d")).toEqual({ section: "overview", range: "30d", session: null });
	});
});
