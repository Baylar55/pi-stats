import { afterEach, describe, expect, it, vi } from "vitest";
import { getStatsDbPath } from "../src/config";
import { initDb, insertMessageStats, recordTiming } from "../src/db";
import { StatsLive } from "../src/live";
import type { LiveStatus } from "../src/shared-types";
import { Database } from "../src/sqlite";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-live-external-");

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Run one full sync and resolve with the status emitted when it finishes. */
async function syncOnce(live: StatsLive): Promise<LiveStatus> {
	const { promise, resolve } = Promise.withResolvers<LiveStatus>();
	const before = live.status().sync.lastSyncedAt;
	const unsubscribe = live.subscribe(status => {
		if (status.sync.phase === "idle" && status.sync.lastSyncedAt !== before) resolve(status);
	});
	try {
		live.requestSync();
		return await promise;
	} finally {
		unsubscribe();
	}
}

/** Sync, then fire any pending (throttled) version bump. */
async function syncAndFlush(live: StatsLive): Promise<number> {
	await syncOnce(live);
	vi.advanceTimersByTime(5_000);
	return live.status().version;
}

function freezeClock(): void {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	// Distinct lastSyncedAt per sync while timers are frozen.
	let now = 1_000_000;
	vi.spyOn(Date, "now").mockImplementation(() => (now += 10_000));
}

describe("StatsLive external writes", () => {
	it("bumps the version only when another connection committed since the last sync", async () => {
		freezeClock();
		const live = new StatsLive();
		try {
			const baseline = await syncAndFlush(live);

			expect(await syncAndFlush(live)).toBe(baseline);

			const other = new Database(getStatsDbPath());
			other.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('external-writer-probe', '1')");
			other.close();

			expect(await syncAndFlush(live)).toBe(baseline + 1);
			expect(await syncAndFlush(live)).toBe(baseline + 1);
		} finally {
			live.stop();
		}
	});

	it("lets open pages refetch when a live request timing lands after the sync", async () => {
		freezeClock();
		const live = new StatsLive();
		try {
			// Idle hub: a timing recorded while no dashboard is open wakes nothing.
			live.dataChanged();
			vi.advanceTimersByTime(5_000);
			expect(live.status().version).toBe(1);

			live.start();
			await syncOnce(live);
			vi.advanceTimersByTime(5_000);
			const baseline = live.status().version;

			await initDb();
			insertMessageStats([
				{
					sessionFile: "/tmp/s.jsonl",
					entryId: "a1",
					folder: "/tmp",
					model: "m",
					provider: "p",
					api: "a",
					timestamp: 1_000,
					duration: null,
					ttft: null,
					stopReason: "stop",
					errorMessage: null,
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
					agentType: "main",
				},
			]);
			recordTiming({ sessionFile: "/tmp/s.jsonl", entryId: "a1", requestStart: 1_000, firstTokenAt: 1_200, endAt: 2_000 });
			live.dataChanged();
			vi.advanceTimersByTime(5_000);

			expect(live.status().version).toBe(baseline + 1);
		} finally {
			live.stop();
		}
	});
});
