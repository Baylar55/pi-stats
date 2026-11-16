import * as fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseSessionFile } from "../src/parser";
import { assistant, header, lines, sessionPath, T0, writeSession } from "./helpers/session";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-large-session-");

describe("large session parsing", () => {
	it("parses a transcript with far more lines than fit one read chunk", async () => {
		const entry = lines([header("/tmp")]);
		const entryCount = 200_000;
		const file = await writeSession(sessionPath("large.jsonl"), entry.repeat(entryCount));

		const result = await parseSessionFile(file);

		// The lenient line scanner consumes the entire file (every line is `\n`-terminated),
		// so the resume offset is the full byte length rather than the byte before the final newline.
		expect(result.newOffset).toBe(entry.length * entryCount);
		expect(result.stats).toEqual([]);
		expect(result.userStats).toEqual([]);
		expect(result.userLinks).toEqual([]);
	});

	it("parses multi-megabyte JSONL whose lines straddle read chunks", async () => {
		const payload = "x".repeat(16 * 1024);
		const entries = Array.from({ length: 256 }, (_, i) =>
			assistant(`assistant-${i}`, { timestamp: T0 + i, message: { content: [{ type: "text", text: payload }] } }),
		);
		const file = await writeSession(sessionPath(), entries);

		const result = await parseSessionFile(file);

		expect(result.stats.map(s => s.entryId)).toEqual(entries.map(entry => entry.id));
		expect(result.newOffset).toBeGreaterThan(4 * 1024 * 1024);
	});

	it("parses a single line larger than the read chunk", async () => {
		const huge = assistant("huge", { message: { content: [{ type: "text", text: "y".repeat(3 * 1024 * 1024) }] } });
		const file = await writeSession(sessionPath(), [assistant("before"), huge, assistant("after", { timestamp: T0 + 1 })]);

		const result = await parseSessionFile(file);

		expect(result.stats.map(s => s.entryId)).toEqual(["before", "huge", "after"]);
		expect(result.newOffset).toBe((await fs.stat(file)).size);
	});
});
