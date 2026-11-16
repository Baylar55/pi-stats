/**
 * Shared test isolation: every test gets a fresh agent directory (sessions +
 * stats.db) in a `TempDir`, and the stats DB handle is closed afterwards.
 * Port of omp's `test/helpers/temp-agent.ts`; pi has no XDG redirection, so
 * pinning the agent dir is all the isolation there is.
 */
import { afterEach, beforeEach } from "vitest";
import { setAgentDir } from "../../src/config";
import { closeDb } from "../../src/db";
import { TempDir } from "./temp-dir";

const ENV_KEYS = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"] as const;

export interface StatsTestIsolation {
	/** Active per-test `TempDir`. Null between tests. */
	current(): TempDir | null;
}

export function installStatsTestIsolation(prefix: string): StatsTestIsolation {
	const originalEnv: Record<string, string | undefined> = {};
	let tempDir: TempDir | null = null;

	beforeEach(() => {
		tempDir = TempDir.createSync(prefix);
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		setAgentDir(tempDir.join("agent"));
	});

	afterEach(() => {
		closeDb();
		for (const key of ENV_KEYS) {
			const prior = originalEnv[key];
			if (prior === undefined) delete process.env[key];
			else process.env[key] = prior;
		}
		setAgentDir(undefined);
		tempDir?.removeSync();
		tempDir = null;
	});

	return {
		current() {
			return tempDir;
		},
	};
}
