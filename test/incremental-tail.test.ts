import * as fs from "node:fs/promises";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncAllSessions } from "../src/aggregator";
import { getStatsDbPath } from "../src/config";
import { closeDb, getFileOffset, getRecentRequests, initDb } from "../src/db";
import { parseSessionFile } from "../src/parser";
import { getOverallStats } from "../src/rollup";
import { assistant, lines, replaceSession, sessionPath, T0, toolCall, user, writeSession } from "./helpers/session";
import { installStatsTestIsolation } from "./helpers/temp-agent";

const isolation = installStatsTestIsolation("@pi-stats-tail-");

beforeEach(() => {
	const temp = isolation.current();
	if (!temp || !getStatsDbPath().startsWith(`${temp.path()}${path.sep}`)) {
		throw new Error("Stats tests require an isolated temporary agent directory and database");
	}
});

const one = (id: string): string => lines([assistant(id)]);
const padding = (bytes: number, fill = "x"): string => lines([{ type: "custom", customType: "pad", data: fill.repeat(bytes) }]);
const storedIds = (limit = 100): string[] =>
	getRecentRequests(limit)
		.map(row => row.entryId)
		.sort();

/** Counts bytes read through file handles until `restore()`; `reset()` zeroes the count. */
async function observeReads(file: string): Promise<{ readonly bytes: number; reset(): void; restore(): void }> {
	const probe = await fs.open(file, "r");
	const prototype: { read: fs.FileHandle["read"] } = Object.getPrototypeOf(probe);
	await probe.close();
	const original = prototype.read;
	let bytes = 0;
	const observer = vi.spyOn(prototype, "read").mockImplementation(async function (this: fs.FileHandle, ...args: unknown[]) {
		const result = await Reflect.apply(original, this, args);
		bytes += result.bytesRead;
		return result;
	});
	return {
		get bytes() {
			return bytes;
		},
		reset() {
			bytes = 0;
		},
		restore() {
			observer.mockRestore();
		},
	};
}

describe("incremental stats ingestion", () => {
	for (const kind of ["message", "user", "tool", "tool-entry"] as const) {
		const title =
			kind === "tool-entry"
				? "preserves forked tool calls when a replacement reuses the call ID in a different entry"
				: `preserves forked ${kind} records when a replacement reuses an ID at a new timestamp`;
		it(title, async () => {
			const newTime = kind === "tool-entry" ? T0 : T0 + 3_600_000;
			const entry = (timestamp: number, id = "shared"): string =>
				lines([
					kind === "user"
						? user(id, "hello", { timestamp })
						: assistant(id, {
								timestamp,
								message: kind === "message" ? {} : { content: [toolCall("call", "read", { path: "README.md" })] },
							}),
				]);
			const owner = await writeSession(sessionPath(), entry(T0));
			const fork = await writeSession(sessionPath("fork.jsonl"), "");
			await syncAllSessions({ workers: 1 });
			await writeSession(fork, entry(T0));
			await syncAllSessions({ workers: 1 });
			await replaceSession(owner, entry(newTime, kind === "tool-entry" ? "new-entry" : "shared"));
			await syncAllSessions({ workers: 1 });

			const table = kind === "message" ? "messages" : kind === "user" ? "user_messages" : "tool_calls";
			const rows = (await initDb()).prepare<{ timestamp: number }>(`SELECT timestamp FROM ${table} ORDER BY timestamp`).all();
			// The fork still holds the old record, so it survives next to the replacement's.
			expect(rows.map(row => row.timestamp)).toEqual([T0, newTime]);
		});
	}

	it("detects a second replacement after interruption without forgetting its previous file identity", async () => {
		const fileA = await writeSession(sessionPath(), one("oldA"));
		const fileB = await writeSession(sessionPath("second.jsonl"), one("oldB"));
		await syncAllSessions({ workers: 1 });

		await fs.writeFile(fileA, one("newA"));
		await expect(
			syncAllSessions({
				workers: 1,
				onProgress(progress) {
					if (progress.sessionFile === fileA) throw new Error("interrupted after A");
				},
			}),
		).rejects.toThrow("interrupted after A");
		closeDb();
		await fs.writeFile(fileB, one("newB") + padding(8192));
		await syncAllSessions({ workers: 1 });

		expect(storedIds()).toEqual(["newA", "newB"]);
	});

	for (const state of [null, "invalid JSON"] as const) {
		it(`rebuilds a larger replacement when persisted parser state is ${state === null ? "missing" : "invalid"}`, async () => {
			const file = await writeSession(sessionPath(), one("old"));
			await syncAllSessions({ workers: 1 });
			const db = await initDb();
			db.prepare("UPDATE file_offsets SET parser_state = ? WHERE session_file = ?").run(state, file);
			closeDb();
			await fs.writeFile(file, one("new") + padding(8192));
			await syncAllSessions({ workers: 1 });

			expect(storedIds()).toEqual(["new"]);
		});
	}

	it("limits reads to appended bytes across restarts", async () => {
		const content = padding(2_000_000) + one("first");
		const file = await writeSession(sessionPath(), content);
		await writeSession(sessionPath("unrelated.jsonl"), padding(2_000_000, "y"));
		await syncAllSessions({ workers: 1 });
		closeDb();

		const tail = lines([assistant("second", { timestamp: T0 + 1 })]);
		await fs.appendFile(file, tail);
		const reads = await observeReads(file);
		try {
			await syncAllSessions({ workers: 1 });
			// The tail plus the two 256-byte cursor checkpoints; neither 2 MB transcript is re-read.
			expect(reads.bytes).toBeLessThan(Buffer.byteLength(tail) + 4096);

			reads.reset();
			await syncAllSessions({ workers: 1 });
			expect(reads.bytes).toBe(0);
		} finally {
			reads.restore();
		}
		expect(getOverallStats().totalRequests).toBe(2);
	});

	it("leaves a partial trailing line for the next sync", async () => {
		const complete = lines([assistant("second", { timestamp: T0 + 1 })]);
		const file = await writeSession(sessionPath(), one("first") + complete.slice(0, 40));
		await syncAllSessions({ workers: 1 });
		expect(storedIds()).toEqual(["first"]);
		expect(getFileOffset(file)?.offset).toBe(Buffer.byteLength(one("first")));

		await fs.appendFile(file, complete.slice(40));
		await syncAllSessions({ workers: 1 });
		expect(storedIds()).toEqual(["first", "second"]);
	});

	it("rebuilds cursor state from the prefix for an offset-only caller", async () => {
		const prefix = lines([user("u1", "why did you do that"), { type: "thinking_level_change", id: "t1", parentId: "u1", thinkingLevel: "high" }]);
		const file = await writeSession(sessionPath(), prefix + lines([assistant("a1", { parentId: "t1" })]));

		const result = await parseSessionFile(file, Buffer.byteLength(prefix));

		expect(result.userStats).toEqual([]);
		expect(result.userLinks).toEqual([{ sessionFile: file, entryId: "u1", model: "gpt-x", provider: "openai" }]);
	});

	for (const operation of ["replace", "truncate"] as const) {
		it(`rebuilds derived totals after ${operation} instead of reusing the old offset`, async () => {
			const file = await writeSession(sessionPath(), one("old") + padding(8192));
			await syncAllSessions({ workers: 1 });
			if (operation === "replace") await replaceSession(file, one("new"));
			else await fs.writeFile(file, one("new"));
			await syncAllSessions({ workers: 1 });

			expect(storedIds()).toEqual(["new"]);
			expect(getOverallStats().totalRequests).toBe(1);
		});
	}

	it("detects a same-inode rewrite that grows past the previous cursor", async () => {
		// The leading line makes the rewrite differ in the bytes before the old cursor too.
		const file = await writeSession(sessionPath(), padding(16) + one("old"));
		await syncAllSessions({ workers: 1 });
		await fs.writeFile(file, one("new") + padding(8192));
		await syncAllSessions({ workers: 1 });

		expect(storedIds()).toEqual(["new"]);
	});

	it("rolls back replacement deletions and the cursor when a derived-row write fails", async () => {
		const file = await writeSession(sessionPath(), padding(16) + one("old"));
		await syncAllSessions({ workers: 1 });
		const oldOffset = getFileOffset(file);
		const db = await initDb();
		db.exec(
			"CREATE TRIGGER reject_new BEFORE INSERT ON messages WHEN NEW.entry_id = 'new' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;",
		);
		await fs.writeFile(file, one("new"));

		await expect(syncAllSessions({ workers: 1 })).rejects.toThrow("injected write failure");
		expect(storedIds()).toEqual(["old"]);
		expect(getFileOffset(file)).toEqual(oldOffset);

		db.exec("DROP TRIGGER reject_new");
		await syncAllSessions({ workers: 1 });
		expect(storedIds()).toEqual(["new"]);
	});

	it("resumes after a sync killed between batches with identical totals", async () => {
		const count = 1025;
		const folder = path.dirname(sessionPath());
		await fs.mkdir(folder, { recursive: true });
		await Promise.all(
			Array.from({ length: count }, (_, index) => fs.writeFile(path.join(folder, `${index}.jsonl`), one(`entry-${index}`))),
		);
		let reports = 0;
		let committed: string[] = [];
		await expect(
			syncAllSessions({
				workers: 1,
				onProgress() {
					reports++;
					if (reports === 1) {
						committed = storedIds(count);
						throw new Error("interrupted batch progress");
					}
				},
			}),
		).rejects.toThrow("interrupted batch progress");
		closeDb();
		await initDb();
		// Only whole batches are durable: the first one committed, the rest never started.
		expect(committed.length).toBeGreaterThan(0);
		expect(committed.length).toBeLessThan(count);
		expect(storedIds(count)).toEqual(committed);

		await syncAllSessions({ workers: 1 });
		expect(getOverallStats().totalRequests).toBe(count);
		expect(getOverallStats().totalInputTokens).toBe(count * 10);

		expect(await syncAllSessions({ workers: 1 })).toEqual({ processed: 0, files: 0 });
		expect(getOverallStats().totalRequests).toBe(count);
	}, 60_000);

	it("takes over the sync lock of a process that died mid-sync", async () => {
		await writeSession(sessionPath(), one("only"));
		await fs.mkdir(path.dirname(getStatsDbPath()), { recursive: true });
		// A pid far above any real one: the owner is gone and never released its lock.
		await fs.writeFile(`${getStatsDbPath()}.sync.lock`, "2147483646");

		expect(await syncAllSessions({ workers: 1 })).toEqual({ processed: 1, files: 1 });
	});

	it("keeps a request still present in a fork when its original transcript is replaced", async () => {
		const file = await writeSession(sessionPath(), one("shared"));
		await syncAllSessions({ workers: 1 });
		await writeSession(sessionPath("fork.jsonl"), one("shared"));
		await syncAllSessions({ workers: 1 });
		expect(getOverallStats().totalRequests).toBe(1);

		await fs.writeFile(file, lines([assistant("new", { timestamp: T0 + 1 })]) + padding(64));
		await syncAllSessions({ workers: 1 });
		expect(storedIds()).toEqual(["new", "shared"]);
	});

	it("resumes fork reconciliation after interruption following a committed replacement", async () => {
		const file = await writeSession(sessionPath(), one("shared"));
		await syncAllSessions({ workers: 1 });
		await writeSession(sessionPath("fork.jsonl"), one("shared"));
		await syncAllSessions({ workers: 1 });
		await fs.writeFile(file, lines([assistant("new", { timestamp: T0 + 1 })]) + padding(64));
		await expect(
			syncAllSessions({
				workers: 1,
				onProgress(progress) {
					if (progress.sessionFile === file) throw new Error("interrupted after commit");
				},
			}),
		).rejects.toThrow("interrupted after commit");
		closeDb();

		await syncAllSessions({ workers: 1 });
		expect(storedIds()).toEqual(["new", "shared"]);
	});
});
