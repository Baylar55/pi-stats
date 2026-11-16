import { describe, expect, it } from "vitest";
import { getRecentRequests, initDb, insertMessageStats, insertToolCalls } from "../src/db";
import { parseSessionFile } from "../src/parser";
import { assistant, header, lines, sessionPath, T0, toolCall, usage, writeSession } from "./helpers/session";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-malformed-");

const USAGE = usage();

describe("malformed session entries", () => {
	it("coerces a missing stopReason instead of failing the NOT NULL insert", async () => {
		const file = await writeSession(sessionPath(), [
			assistant("a1", { message: { stopReason: undefined } }),
			assistant("a2", { timestamp: T0 + 1000, message: { stopReason: undefined, errorMessage: "boom" } }),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats.map(s => s.stopReason)).toEqual(["aborted", "error"]);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(2);
	});

	it("zero-fills missing token counts and falls back to the entry timestamp", async () => {
		const file = await writeSession(sessionPath(), [
			assistant("a1", {
				message: { timestamp: undefined, usage: { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats).toHaveLength(1);
		expect(result.stats[0].usage.totalTokens).toBe(0);
		expect(result.stats[0].timestamp).toBe(T0);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);
	});

	it("recovers the entry timestamp when the message timestamp is the zero sentinel", async () => {
		const file = await writeSession(sessionPath(), [assistant("zero", { message: { timestamp: 0 } })]);

		expect((await parseSessionFile(file)).stats[0].timestamp).toBe(T0);
	});

	// Regression: legacy session files can carry a partially-populated
	// `usage.cost` (e.g. only `total`). The parser passes such objects through
	// untouched, and the raw cost used to bind NULL into the cost_* NOT NULL
	// columns and crash the entire sync with SQLITE_CONSTRAINT_NOTNULL.
	it("normalises a partial legacy usage.cost instead of failing the NOT NULL insert", async () => {
		const file = await writeSession(sessionPath(), [
			assistant("a1", { message: { usage: { ...USAGE, cost: { total: 1 } } } }),
		]);

		const result = await parseSessionFile(file);
		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);
		expect(getRecentRequests(1)[0]?.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 });
	});

	it("preserves partial legacy cost components when total is missing", async () => {
		const file = await writeSession(sessionPath(), [
			assistant("a1", { message: { usage: { ...USAGE, cost: { input: 1 } } } }),
		]);

		const result = await parseSessionFile(file);
		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);
		expect(getRecentRequests(1)[0]?.usage.cost).toEqual({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 });
	});

	it("skips assistant entries with no usage or model attribution", async () => {
		const file = await writeSession(sessionPath(), [
			assistant("no-usage", { message: { usage: undefined } }),
			assistant("no-model", { message: { model: undefined, provider: undefined, api: undefined } }),
			assistant("ok", { timestamp: T0 + 2000 }),
		]);

		expect((await parseSessionFile(file)).stats.map(s => s.entryId)).toEqual(["ok"]);
	});

	it("skips lines that are not JSON or not entries without losing the ones after them", async () => {
		const file = await writeSession(
			sessionPath(),
			`${lines([header()])}{"type":"message","id":"cut\nnot json at all\n42\n\r\n${lines([assistant("ok")])}`,
		);

		const result = await parseSessionFile(file);
		expect(result.stats.map(s => s.entryId)).toEqual(["ok"]);
		// Every line was newline-terminated, so the cursor is at the end of the file.
		expect(result.newOffset).toBe(result.parserState?.size);
	});

	it("ignores malformed content blocks without aborting later entries", async () => {
		const file = await writeSession(sessionPath(), [
			assistant("a1", { message: { content: [null, toolCall("call-1", "bash")] } }),
			assistant("a2", { timestamp: T0 + 1000, message: { content: [] } }),
		]);

		const result = await parseSessionFile(file);
		expect(result.stats.map(s => s.entryId)).toEqual(["a1", "a2"]);
		expect(result.toolCalls.map(c => c.toolCallId)).toEqual(["call-1"]);
	});

	it("keeps tool_calls insertable when the turn lacks a message timestamp", async () => {
		const file = await writeSession(sessionPath(), [
			assistant("a1", {
				message: {
					timestamp: undefined,
					// No id: unattributable, must be skipped.
					content: [toolCall("call-1", "bash", { command: "ls" }), { type: "toolCall", name: "broken" }],
				},
			}),
		]);

		const result = await parseSessionFile(file);
		expect(result.toolCalls.map(c => c.toolCallId)).toEqual(["call-1"]);
		expect(result.toolCalls[0].timestamp).toBe(T0);

		await initDb();
		expect(insertToolCalls(result.toolCalls)).toBe(1);
	});

	// Regression: the derived total is summed with `+` over runtime values a
	// foreign session can make any type. A string bucket passed the nullish
	// check and concatenated — `input: "10"` plus the absent buckets became a
	// string SQLite coerced to millions of tokens for a ten-token request.
	it("counts a non-numeric token bucket as absent instead of concatenating it", async () => {
		const file = await writeSession(sessionPath(), [
			assistant("string-bucket", { message: { usage: { input: "10", output: 0, cacheRead: 0, cacheWrite: 0 } } }),
		]);

		const result = await parseSessionFile(file);
		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);

		const request = getRecentRequests(1)[0];
		expect(request?.usage.totalTokens).toBe(0);
		expect(request?.usage.input).toBe(0);
	});

	// `1e999` is legal JSON and parses to `Infinity`, so a bucket can be a
	// number and still be unusable in a NOT NULL column.
	it("counts a non-finite token bucket as absent instead of binding it", async () => {
		const entry = (id: string, usageJson: string) =>
			JSON.stringify(assistant(id, { message: { usage: "USAGE" } })).replace('"USAGE"', usageJson);
		const file = await writeSession(
			sessionPath(),
			`${entry("infinite-bucket", '{"input":1e999,"output":0,"cacheRead":0,"cacheWrite":0}')}\n${entry(
				"infinite-total",
				'{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":1e999}',
			)}\n`,
		);

		const result = await parseSessionFile(file);
		expect(result.stats.map(s => [s.usage.input, s.usage.totalTokens])).toEqual([
			[0, 0],
			[10, 15],
		]);

		await initDb();
		expect(insertMessageStats(result.stats)).toBe(2);
	});

	it("gives id-less v1 entries the same id on every parse", async () => {
		const v1 = { ...assistant("x"), id: undefined, parentId: undefined };
		const file = await writeSession(sessionPath(), [{ type: "session", id: "s", cwd: "/work/project" }, v1]);

		const first = await parseSessionFile(file);
		const second = await parseSessionFile(file);
		expect(first.stats).toHaveLength(1);
		expect(first.stats[0].entryId).toMatch(/^[0-9a-f]{16}$/);
		expect(second.stats[0].entryId).toBe(first.stats[0].entryId);
	});
});
