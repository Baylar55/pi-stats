/**
 * Small runtime helpers: number/duration formatting, hashing, logging and a
 * cross-process file lock.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgentDir } from "./config";

export { sleep };

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Format a duration in milliseconds to a short human-readable string.
 * Examples: "123ms", "1.5s", "30m15s", "2h30m", "3d2h"
 */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0ms";
	if (ms < SEC) return `${Math.floor(ms)}ms`;
	if (ms < MIN) {
		// Round to tenths first: `toFixed(1)` alone turns 59.95s+ into an impossible `60.0s`.
		const tenths = Math.round(ms / 100);
		return tenths < 600 ? `${(tenths / 10).toFixed(1)}s` : "1m";
	}
	if (ms < HOUR) {
		const mins = Math.floor(ms / MIN);
		const secs = Math.floor((ms % MIN) / SEC);
		return secs > 0 ? `${mins}m${secs}s` : `${mins}m`;
	}
	if (ms < DAY) {
		const hours = Math.floor(ms / HOUR);
		const mins = Math.floor((ms % HOUR) / MIN);
		return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
	}
	const days = Math.floor(ms / DAY);
	const hours = Math.floor((ms % DAY) / HOUR);
	return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

/**
 * Format a number with K/M/B suffix for compact display.
 * Uses 1 decimal for small leading digits when non-zero, rounded otherwise.
 * Values below 1,000 print as-is unless `maxFractionDigits` caps their decimals.
 * Examples: "999", "1K", "1.5K", "25K", "1M", "1.5M", "25M", "1.5B"
 */
export function formatNumber(n: number, maxFractionDigits?: number): string {
	if (n < 1_000) {
		if (maxFractionDigits === undefined || Number.isInteger(n)) return n.toString();
		return Number(n.toFixed(maxFractionDigits)).toString();
	}
	if (n < 10_000) return `${trim1(n / 1_000)}K`;
	if (n < 1_000_000) return `${Math.round(n / 1_000)}K`;
	if (n < 10_000_000) return `${trim1(n / 1_000_000)}M`;
	if (n < 1_000_000_000) return `${Math.round(n / 1_000_000)}M`;
	if (n < 10_000_000_000) return `${trim1(n / 1_000_000_000)}B`;
	return `${Math.round(n / 1_000_000_000)}B`;
}

/** Format with up to 1 decimal place, dropping trailing `.0`. */
function trim1(n: number): string {
	const s = n.toFixed(1);
	return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** Format a ratio as a percentage. */
export function formatPercent(ratio: number): string {
	return `${(ratio * 100).toFixed(1)}%`;
}

/** The `code` of a Node system error, read without trusting an unchecked cast. */
export function errorCode(err: unknown): string | undefined {
	return err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;
}

export function isEnoent(err: unknown): boolean {
	return errorCode(err) === "ENOENT";
}

/**
 * Stable 64-bit hex digest. The values only key pi-stats' own rows (prose
 * hashes, cursor checkpoints), so any stable hash does.
 */
export function hashHex(data: string | Uint8Array): string {
	return createHash("sha1").update(data).digest("hex").slice(0, 16);
}

type LogContext = Record<string, unknown>;

function writeLog(level: string, message: string, context?: LogContext): void {
	const line = `${new Date().toISOString()} ${level} ${message}${context ? ` ${JSON.stringify(context)}` : ""}\n`;
	if (process.env.PI_STATS_DEBUG) process.stderr.write(line);
	// The dashboard runs inside pi's TUI, where stderr would corrupt the screen: log to a file.
	// ponytail: no rotation; warnings are rare (malformed lines, port conflicts). Rotate if it ever grows.
	fs.appendFile(path.join(getAgentDir(), "pi-stats.log"), line, () => {});
}

export const logger = {
	debug(message: string, context?: LogContext): void {
		if (process.env.PI_STATS_DEBUG) writeLog("debug", message, context);
	},
	info(message: string, context?: LogContext): void {
		if (process.env.PI_STATS_DEBUG) writeLog("info", message, context);
	},
	warn(message: string, context?: LogContext): void {
		writeLog("warn", message, context);
	},
	error(message: string, context?: LogContext): void {
		writeLog("error", message, context);
	},
};

export interface FileLockOptions {
	/** Maximum acquisition attempts, including the initial attempt. */
	retries?: number;
	/** Delay between acquisition attempts. */
	retryDelayMs?: number;
}

/** A lock file whose owner never wrote its pid is taken over after this long. */
const UNOWNED_LOCK_STALE_MS = 10_000;

/** Whether the process that wrote `lockPath` is gone (killed mid-sync), so the lock can be taken over. */
function isStaleLock(lockPath: string): boolean {
	try {
		const pid = Number.parseInt(fs.readFileSync(lockPath, "utf8"), 10);
		if (!Number.isInteger(pid) || pid <= 0) {
			return Date.now() - fs.statSync(lockPath).mtimeMs > UNOWNED_LOCK_STALE_MS;
		}
		if (pid === process.pid) return false;
		try {
			process.kill(pid, 0);
			return false;
		} catch (err) {
			return errorCode(err) === "ESRCH";
		}
	} catch {
		// Released between the failed create and this probe: retry the create.
		return false;
	}
}

/**
 * Run `fn` while holding an exclusive cross-process lock for `filePath`
 * (`<filePath>.lock`, created with `wx`, holding the owner's pid). Node has no
 * native OS lock, so a dead owner is detected by pid.
 */
export async function withFileLock<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const retries = options.retries ?? 50;
	const retryDelayMs = options.retryDelayMs ?? 100;
	const lockPath = `${path.resolve(filePath)}.lock`;
	for (let attempt = 0; ; attempt++) {
		try {
			const fd = fs.openSync(lockPath, "wx");
			try {
				fs.writeSync(fd, String(process.pid));
			} finally {
				fs.closeSync(fd);
			}
			break;
		} catch (err) {
			if (errorCode(err) !== "EEXIST") throw err;
			if (isStaleLock(lockPath)) {
				// ponytail: two processes can both reap a stale lock and briefly co-own it. Inserts are
				// idempotent (unique keys + SQLite transactions), so the cost is duplicate parse work.
				fs.rmSync(lockPath, { force: true });
				continue;
			}
			if (attempt + 1 >= retries) {
				throw new Error(`Failed to acquire lock for ${filePath} after ${retries} attempts`);
			}
			await sleep(retryDelayMs);
		}
	}
	try {
		return await fn();
	} finally {
		fs.rmSync(lockPath, { force: true });
	}
}
