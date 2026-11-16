import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { syncAllSessions } from "../src/aggregator";
import { addSessionRoot, getSessionRoots } from "../src/config";
import { closeDb, getRecentRequests } from "../src/db";
import { setModelPrices } from "../src/pricing";
import { initDb } from "../src/db";
import { getOverallStats, getStatsByFolder } from "../src/rollup";
import { assistant, header, sessionPath, usage, writeSession } from "./helpers/session";
import { installStatsTestIsolation } from "./helpers/temp-agent";

const isolation = installStatsTestIsolation("@pi-stats-sync-serial-");

describe("stats sync", () => {
	it("ingests a transcript and skips it while it is unchanged", async () => {
		await writeSession(sessionPath(), [header(), assistant("a1")]);

		expect(await syncAllSessions({ workers: 1 })).toEqual({ processed: 1, files: 1 });
		expect(getOverallStats().totalRequests).toBe(1);
		expect(await syncAllSessions()).toEqual({ processed: 0, files: 0 });
	});

	it("scans session roots recursively, dot directories included", async () => {
		const file = await writeSession(sessionPath(), [header(), assistant("a1")]);
		const nested = path.join(path.dirname(file), "session", ".runs", "child.jsonl");
		await writeSession(nested, [header(), assistant("child")]);

		expect((await syncAllSessions({ workers: 1 })).files).toBe(2);
		expect(getRecentRequests(5).find(row => row.entryId === "child")?.agentType).toBe("subagent");
	});

	it("prices legacy session usage that has no cost breakdown from the rate card", async () => {
		await initDb();
		setModelPrices([{ provider: "openai", model: "gpt-x", input: 2, output: 8, cacheRead: 0, cacheWrite: 0 }]);
		await writeSession(sessionPath(), [assistant("a1", { message: { usage: usage({ cost: undefined }) } })]);

		expect(await syncAllSessions({ workers: 1 })).toEqual({ processed: 1, files: 1 });
		expect(getOverallStats().totalCost).toBeCloseTo((10 * 2 + 5 * 8) / 1_000_000, 12);
	});

	it("syncs only the named files when a watcher passes them", async () => {
		const first = await writeSession(sessionPath("first.jsonl"), [assistant("a1")]);
		await writeSession(sessionPath("second.jsonl"), [assistant("a2")]);

		await syncAllSessions({ files: [first] });

		expect(getRecentRequests(5).map(row => row.entryId)).toEqual(["a1"]);
	});

	it("stores the header's cwd as the folder, also for Windows paths", async () => {
		await writeSession(sessionPath("win.jsonl", "--C--Users-x-my-proj--"), [header("C:\\Users\\x\\my-proj"), assistant("win")]);
		await writeSession(sessionPath("wt.jsonl", "--work-app-.worktrees-lane-src--"), [
			header("/work/app/.worktrees/lane/src"),
			assistant("worktree"),
		]);
		// No usable header: the lossy directory name is all there is.
		await writeSession(sessionPath("bare.jsonl", "--home-me-proj--"), [assistant("bare")]);

		await syncAllSessions({ workers: 1 });

		expect(
			getStatsByFolder()
				.map(folder => folder.folder)
				.sort(),
		).toEqual(["/home/me/proj", "/work/app", "C:/Users/x/my-proj"]);
	});

	it("scans a custom flat session dir and remembers it for later launches", async () => {
		const custom = isolation.current()?.join("custom-sessions");
		if (!custom) throw new Error("no temp dir");
		await writeSession(path.join(custom, "flat.jsonl"), [header("/work/elsewhere"), assistant("flat")]);
		addSessionRoot(custom);

		await syncAllSessions({ workers: 1 });
		expect(getRecentRequests(5)).toMatchObject([{ entryId: "flat", agentType: "main", folder: "/work/elsewhere" }]);

		// A later process (the standalone bin) never hears about the dir from pi: the database remembers it.
		closeDb();
		await fs.appendFile(path.join(custom, "flat.jsonl"), `${JSON.stringify(assistant("later", { timestamp: Date.now() }))}\n`);
		await syncAllSessions({ workers: 1 });
		expect(getSessionRoots()).toContain(path.resolve(custom));
		expect(getOverallStats(null).totalRequests).toBe(2);
	});
});
