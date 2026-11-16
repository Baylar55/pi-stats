import * as fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { getRequestDetails } from "../src/aggregator";
import { getRecentRequests, initDb, insertMessageStats } from "../src/db";
import { parseSessionFile } from "../src/parser";
import { assistant, header, sessionPath, T0, toolCall, toolResult, usage, writeSession } from "./helpers/session";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-model-usage-");

const ISO = new Date(T0).toISOString();

/** A `usage` entry: model-attributed usage that is not an assistant message (pi's cache warming). */
function usageEntry(id: string): Record<string, unknown> {
	return {
		type: "usage",
		id,
		parentId: null,
		timestamp: ISO,
		kind: "cache_warm",
		provider: "anthropic",
		model: "claude-s",
		usage: usage({ input: 0, output: 0, cacheRead: 50_000, totalTokens: 50_000, cost: { input: 0, output: 0, cacheRead: 0.015, cacheWrite: 0, total: 0.015 } }),
	};
}

describe("non-message usage", () => {
	it("counts a usage entry once as a request of its model", async () => {
		const file = await writeSession(sessionPath(), [header(), usageEntry("warm-1")]);

		const result = await parseSessionFile(file);
		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);
		// A re-sync upserts the same row (re-deriving its cost) instead of adding one.
		insertMessageStats(result.stats);
		expect(getRecentRequests(5)).toHaveLength(1);
		expect(getRecentRequests(1)[0]).toMatchObject({
			entryId: "warm-1",
			provider: "anthropic",
			model: "claude-s",
			stopReason: "stop",
			timestamp: T0,
			duration: null,
			ttft: null,
			usage: { cacheRead: 50_000, totalTokens: 50_000, cost: { total: 0.015 } },
		});
	});

	it("attributes compaction, branch-summary and tool usage to the model in use", async () => {
		const file = await writeSession(sessionPath(), [
			header(),
			{ type: "model_change", id: "mc", parentId: null, timestamp: ISO, provider: "virtual", modelId: "router" },
			{ type: "compaction", id: "early", parentId: "mc", timestamp: ISO, summary: "s", firstKeptEntryId: "mc", tokensBefore: 1, usage: usage() },
			assistant("a1", { message: { provider: "anthropic", model: "claude-s", api: "anthropic-messages", content: [toolCall("call-1", "search")] } }),
			toolResult("tr1", "call-1", "found", { message: { usage: usage({ totalTokens: 7 }) } }),
			{ type: "branch_summary", id: "bs", parentId: "a1", timestamp: ISO, fromId: "tr1", summary: "s", usage: usage() },
			{ type: "compaction", id: "no-usage", parentId: "bs", timestamp: ISO, summary: "s", firstKeptEntryId: "bs", tokensBefore: 1 },
		]);

		const result = await parseSessionFile(file);

		expect(result.stats.map(s => [s.entryId, s.provider, s.model, s.api])).toEqual([
			// Before any response the selected model is all there is to name.
			["early", "virtual", "router", "unknown"],
			["a1", "anthropic", "claude-s", "anthropic-messages"],
			["tr1", "anthropic", "claude-s", "anthropic-messages"],
			["bs", "anthropic", "claude-s", "anthropic-messages"],
		]);
	});

	it("takes the duration from durationMs, else from the two timestamps, and leaves the TTFT unknown", async () => {
		const file = await writeSession(sessionPath(), [
			assistant("timed", { message: { durationMs: 4_200 } }),
			// Older pi: no durationMs, but the request start and the persist time are both recorded.
			{ ...assistant("legacy", { timestamp: T0 + 10_000 }), timestamp: new Date(T0 + 12_500).toISOString() },
			// Out of order or missing ends give no duration rather than a made-up one.
			{ ...assistant("skewed", { timestamp: T0 + 20_000 }), timestamp: new Date(T0 + 19_000).toISOString() },
			assistant("no-start", { timestamp: T0 + 30_000, message: { timestamp: undefined } }),
		]);

		const result = await parseSessionFile(file);

		expect(result.stats.map(s => [s.entryId, s.duration, s.ttft])).toEqual([
			["timed", 4_200, null],
			["legacy", 2_500, null],
			["skewed", null, null],
			["no-start", null, null],
		]);
	});

	it("opens a usage entry in the request details without a payload", async () => {
		const file = await writeSession(sessionPath(), [header(), usageEntry("warm-1")]);
		await initDb();
		insertMessageStats((await parseSessionFile(file)).stats);
		const [row] = getRecentRequests(1);
		if (row.id === undefined) throw new Error("stored request has no id");

		expect(await getRequestDetails(row.id)).toMatchObject({
			id: row.id,
			model: "claude-s",
			output: null,
			messages: [{ type: "usage", id: "warm-1", kind: "cache_warm" }],
		});

		await fs.writeFile(file, "");
		expect(await getRequestDetails(row.id)).toBeNull();
	});
});
