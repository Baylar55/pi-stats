import { describe, expect, it } from "vitest";
import { getRecentRequests, getSessionTimings, initDb, insertMessageStats, recordTiming } from "../src/db";
import { type ModelPrice, setModelPrices } from "../src/pricing";
import { getOverallStats, getRollupStatus, getStatsByModel, refreshRollups } from "../src/rollup";
import type { MessageStatsInput } from "../src/types";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-db-");

/** Public API card and the same model listed at zero under a subscription provider. */
const PRICES: ModelPrice[] = [
	{ provider: "openai", model: "gpt-x", input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 },
	{ provider: "openai-codex", model: "gpt-x", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	{ provider: "anthropic", model: "claude-s", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	{
		provider: "xai",
		model: "grok-t",
		input: 2,
		output: 6,
		cacheRead: 0.2,
		cacheWrite: 0,
		tiers: [{ inputTokensAbove: 200_000, input: 4, output: 12, cacheRead: 0.4, cacheWrite: 0 }],
	},
];

function request(entryId: string, overrides: Partial<MessageStatsInput> = {}): MessageStatsInput {
	return {
		sessionFile: "/tmp/session.jsonl",
		entryId,
		folder: "/tmp/project",
		model: "gpt-x",
		provider: "openai-codex",
		api: "openai-codex-responses",
		timestamp: Date.now(),
		duration: null,
		ttft: null,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: 1_000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 0,
			totalTokens: 1_700,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		agentType: "main",
		...overrides,
	};
}

function stored(entryId: string) {
	const row = getRecentRequests(100).find(candidate => candidate.entryId === entryId);
	if (!row) throw new Error(`no stored request ${entryId}`);
	return row;
}

describe("API-equivalent cost", () => {
	it("prices zero-cost subscription usage at the public rate of the same model", async () => {
		await initDb();
		setModelPrices(PRICES);
		insertMessageStats([request("codex")]);

		const row = stored("codex");
		expect(row.usage.cost.input).toBeCloseTo(0.002, 10);
		expect(row.usage.cost.output).toBeCloseTo(0.004, 10);
		expect(row.usage.cost.cacheRead).toBeCloseTo(0.00004, 10);
		expect(row.usage.cost.total).toBeCloseTo(0.00604, 10);
		expect(row.costUnpriced).toBe(false);
	});

	it("keeps a recorded cost as it is, whatever the rate card says", async () => {
		await initDb();
		setModelPrices(PRICES);
		const paid = request("paid", { provider: "openai", api: "openai-responses" });
		paid.usage.cost = { input: 0.5, output: 0.25, cacheRead: 0, cacheWrite: 0, total: 0.75 };
		insertMessageStats([paid]);
		setModelPrices(PRICES.map(price => ({ ...price, input: price.input * 10, output: price.output * 10 })));

		expect(stored("paid").usage.cost.total).toBe(0.75);
	});

	it("selects the context tier by prompt size", async () => {
		await initDb();
		setModelPrices(PRICES);
		const big = request("big", { provider: "xai", model: "grok-t", api: "openai-completions" });
		big.usage = { ...big.usage, input: 150_000, cacheRead: 60_000, output: 1_000, totalTokens: 211_000 };
		insertMessageStats([big]);

		// 210K prompt tokens exceed the 200K tier: 150K * $4 + 60K * $0.4 + 1K * $12, per million.
		expect(stored("big").usage.cost.total).toBeCloseTo(0.6 + 0.024 + 0.012, 10);
	});

	it("reports usage of a model nobody prices as unpriced and keeps it out of dollar totals", async () => {
		await initDb();
		setModelPrices(PRICES);
		insertMessageStats([request("known"), request("mystery", { provider: "antigravity", model: "gemini-z" })]);

		expect(stored("mystery").costUnpriced).toBe(true);
		expect(stored("mystery").usage.cost.total).toBe(0);
		const overall = getOverallStats();
		expect(overall.unpricedRequests).toBe(1);
		expect(overall.totalCost).toBeCloseTo(0.00604, 10);
		const mystery = getStatsByModel().find(model => model.model === "gemini-z");
		expect(mystery).toMatchObject({ totalCost: 0, unpricedRequests: 1 });
	});

	it("treats a request that used no tokens as free, not unpriced", async () => {
		await initDb();
		const empty = request("empty", { provider: "antigravity", model: "gemini-z", stopReason: "aborted" });
		empty.usage = { ...empty.usage, input: 0, output: 0, cacheRead: 0, totalTokens: 0 };
		insertMessageStats([empty]);

		expect(stored("empty").costUnpriced).toBe(false);
		expect(getOverallStats().unpricedRequests).toBe(0);
	});

	it("re-prices stored estimates and unpriced rows when the rate card changes", async () => {
		await initDb();
		insertMessageStats([request("early")]);
		expect(stored("early").costUnpriced).toBe(true);

		// The rate card arrives after ingest (the bin synced before pi ever published prices).
		setModelPrices(PRICES);
		expect(stored("early").costUnpriced).toBe(false);
		expect(stored("early").usage.cost.total).toBeCloseTo(0.00604, 10);

		setModelPrices(PRICES.map(price => (price.provider === "openai" ? { ...price, output: 16 } : price)));
		expect(stored("early").usage.cost.total).toBeCloseTo(0.01004, 10);

		// Losing the price returns the request to unpriced instead of leaving a stale estimate.
		setModelPrices(PRICES.filter(price => price.model !== "gpt-x"));
		expect(stored("early").costUnpriced).toBe(true);
		expect(stored("early").usage.cost.total).toBe(0);
		await refreshRollups();
		expect(getOverallStats()).toMatchObject({ totalCost: 0, unpricedRequests: 1 });
	});
});

describe("live request timings", () => {
	const timing = { sessionFile: "/tmp/session.jsonl", requestStart: 1_000, firstTokenAt: 1_400, endAt: 3_000 };

	it("fills duration and TTFT whichever of the message and its timing arrives first", async () => {
		await initDb();
		insertMessageStats([request("message-first")]);
		recordTiming({ ...timing, entryId: "message-first" });
		recordTiming({ ...timing, entryId: "timing-first" });
		insertMessageStats([request("timing-first")]);

		for (const entryId of ["message-first", "timing-first"]) {
			expect(stored(entryId)).toMatchObject({ duration: 2_000, ttft: 400 });
		}
		expect(getSessionTimings("/tmp/session.jsonl").get("timing-first")).toEqual({
			requestStart: 1_000,
			firstTokenAt: 1_400,
			endAt: 3_000,
		});
	});

	it("keeps the transcript's own duration and only adds the TTFT", async () => {
		await initDb();
		insertMessageStats([request("recorded", { duration: 5_000 })]);
		recordTiming({ ...timing, entryId: "recorded" });

		expect(stored("recorded")).toMatchObject({ duration: 5_000, ttft: 400 });
	});

	it("marks the rollup hour dirty so averages pick the timing up", async () => {
		await initDb();
		insertMessageStats([request("late")]);
		await refreshRollups();
		expect(getRollupStatus().dirtyHours).toBe(0);
		expect(getOverallStats()).toMatchObject({ avgDuration: null, avgTtft: null, avgTokensPerSecond: null });

		recordTiming({ ...timing, entryId: "late" });
		expect(getRollupStatus().dirtyHours).toBe(1);
		await refreshRollups();
		expect(getOverallStats()).toMatchObject({ avgDuration: 2_000, avgTtft: 400, avgTokensPerSecond: 250 });
	});

	it("leaves untimed requests out of the averages instead of counting them as zero", async () => {
		await initDb();
		insertMessageStats([request("timed", { duration: 4_000 }), request("untimed")]);

		const overall = getOverallStats();
		expect(overall.totalRequests).toBe(2);
		expect(overall.avgDuration).toBe(4_000);
		expect(overall.avgTtft).toBeNull();
		expect(overall.avgTokensPerSecond).toBe(125);
	});
});

function cacheRequest(entryId: string, cacheRead: number, cacheWrite: number): MessageStatsInput {
	const base = request(entryId, { provider: "anthropic", model: "claude-s", api: "anthropic-messages" });
	base.usage = { ...base.usage, input: 1_000 - cacheRead - cacheWrite, output: 0, cacheRead, cacheWrite, totalTokens: 1_000 };
	return base;
}

describe("stats cache metrics", () => {
	it("subtracts 5-minute writes from the savings produced by cache reads", async () => {
		await initDb();
		setModelPrices(PRICES);
		insertMessageStats([cacheRequest("mixed-cache", 800, 100)]);

		// 100 uncached + 800 reads at 0.1x + 100 writes at 1.25x = 305,
		// versus 1,000 tokens at the uncached input rate.
		expect(getOverallStats().cacheSavings).toBeCloseTo(0.695, 8);
		expect(getOverallStats().cacheRate).toBeCloseTo(800 / 900, 8);
	});

	it("reports cache writes without reads as negative savings", async () => {
		await initDb();
		setModelPrices(PRICES);
		insertMessageStats([cacheRequest("cache-write", 0, 1_000)]);

		expect(getOverallStats().cacheSavings).toBeCloseTo(-0.25, 8);
	});

	it("charges 1-hour cache writes at twice the input rate", async () => {
		await initDb();
		setModelPrices(PRICES);
		const write = cacheRequest("one-hour-write", 0, 1_000);
		write.usage.cacheWrite1h = 1_000;
		insertMessageStats([write]);

		expect(stored("one-hour-write").usage.cost.cacheWrite).toBeCloseTo(0.006, 10);
		expect(getOverallStats().cacheSavings).toBeCloseTo(-1, 8);
	});

	it("excludes models without a rate card from the savings ratio", async () => {
		await initDb();
		setModelPrices(PRICES);
		const custom = cacheRequest("custom", 0, 0);
		custom.provider = "custom";
		custom.model = "custom-model";
		custom.usage.cost = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
		insertMessageStats([cacheRequest("known", 800, 100), custom]);

		expect(getOverallStats().cacheSavings).toBeCloseTo(0.695, 8);
	});
});
