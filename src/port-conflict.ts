import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "./util";

/**
 * Upper bound on the identity probe. A live dashboard ingests on its main thread
 * when no parser worker is available, which stalls its responses for over a second on large
 * histories; giving up sooner mistakes a busy dashboard for a hung listener.
 */
const STATS_PROBE_TIMEOUT_MS = 3_000;
/** Upper bound on each OS tool run while naming a port holder for the log. */
const HOLDER_LOOKUP_TIMEOUT_MS = 3_000;

interface PortHolder {
	pid: number;
	image: string;
}

/** Header stamped on every dashboard response so reuse probes can identify us. */
export const STATS_DASHBOARD_HEADER = "x-pi-stats-dashboard";
/** Header recording the server's requested bind host so reuse cannot change its exposure scope. */
export const STATS_DASHBOARD_HOSTNAME_HEADER = "x-pi-stats-hostname";

/** Identity-header value for dashboards enforcing an explicit bind host and same-origin access. */
export const STATS_DASHBOARD_SECURITY_VERSION = "1";

/** IPv4 loopback address shared by the dashboard server and reuse probe. */
export const STATS_DASHBOARD_HOSTNAME = "127.0.0.1";

/**
 * What answers on the dashboard port:
 * - `reusable`: a current dashboard bound to the requested host.
 * - `occupied`: any other HTTP answer (a foreign program, or a dashboard of another version or bind host).
 * - `unresponsive`: accepted the connection but did not answer in time (busy or hung).
 * - `unreachable`: the connection failed, typically because nothing listens there.
 */
type StatsDashboardProbe = "reusable" | "occupied" | "unresponsive" | "unreachable";

/**
 * How {@link startServer} proceeds with the requested port: bind it, reuse the
 * dashboard already serving it, or fall back to an ephemeral port because the
 * holder is not reusable.
 */
export type StatsPortClaim = "bind" | "reuse" | "fallback";

async function probeStatsDashboard(port: number, hostname: string): Promise<StatsDashboardProbe> {
	const probeHostname = hostname === "0.0.0.0" ? STATS_DASHBOARD_HOSTNAME : hostname === "::" ? "::1" : hostname;
	const urlHostname = probeHostname.includes(":") ? `[${probeHostname}]` : probeHostname;
	const signal = AbortSignal.timeout(STATS_PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(`http://${urlHostname}:${port}/api/stats/models`, { signal });
		const reusable =
			response.status === 200 &&
			response.headers.get(STATS_DASHBOARD_HEADER) === STATS_DASHBOARD_SECURITY_VERSION &&
			response.headers.get(STATS_DASHBOARD_HOSTNAME_HEADER) === hostname &&
			!response.headers.has("Access-Control-Allow-Origin");
		await response.body?.cancel();
		return reusable ? "reusable" : "occupied";
	} catch {
		return signal.aborted ? "unresponsive" : "unreachable";
	}
}

/** Stdout of an OS tool, or null when it is missing, fails, or overruns the lookup timeout. */
function run(file: string, args: string[]): Promise<string | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	execFile(file, args, { timeout: HOLDER_LOOKUP_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
		resolve(error ? null : stdout),
	);
	return promise;
}

async function findLinuxPortHolder(port: number): Promise<PortHolder | null> {
	const socketInodes = new Set<string>();
	for (const tablePath of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		let table: string;
		try {
			table = await fs.readFile(tablePath, "utf8");
		} catch {
			continue;
		}

		for (const line of table.split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			const localAddress = fields[1];
			const state = fields[3];
			const inode = fields[9];
			if (!localAddress || state !== "0A" || !inode) continue;
			const encodedPort = localAddress.slice(localAddress.lastIndexOf(":") + 1);
			if (Number.parseInt(encodedPort, 16) === port) socketInodes.add(inode);
		}
	}
	if (socketInodes.size === 0) return null;

	let processes: Dirent[];
	try {
		processes = await fs.readdir("/proc", { withFileTypes: true });
	} catch {
		return null;
	}

	for (const entry of processes) {
		if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
		const pid = Number.parseInt(entry.name, 10);
		let descriptors: string[];
		try {
			descriptors = await fs.readdir(`/proc/${pid}/fd`);
		} catch {
			continue;
		}

		let ownsSocket = false;
		for (const descriptor of descriptors) {
			try {
				const target = await fs.readlink(`/proc/${pid}/fd/${descriptor}`);
				const match = /^socket:\[(\d+)]$/.exec(target);
				if (match?.[1] && socketInodes.has(match[1])) {
					ownsSocket = true;
					break;
				}
			} catch {}
		}
		if (!ownsSocket) continue;

		try {
			const executable = await fs.readlink(`/proc/${pid}/exe`);
			return { pid, image: path.basename(executable) };
		} catch {
			return { pid, image: "unknown" };
		}
	}
	return null;
}

async function findMacPortHolder(port: number): Promise<PortHolder | null> {
	const args = ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"];
	const output = (await run("lsof", args)) ?? (await run("/usr/sbin/lsof", args));
	if (output === null) return null;

	let pid: number | null = null;
	let image = "unknown";
	for (const line of output.split("\n")) {
		if (line.startsWith("p")) {
			const parsed = Number.parseInt(line.slice(1), 10);
			pid = Number.isSafeInteger(parsed) ? parsed : null;
		} else if (line.startsWith("c") && pid !== null) {
			image = line.slice(1) || "unknown";
			break;
		}
	}
	return pid === null ? null : { pid, image };
}

async function findWindowsPortHolder(port: number): Promise<PortHolder | null> {
	const output = await run("netstat", ["-ano", "-p", "TCP"]);
	if (output === null) return null;

	let pid: number | null = null;
	for (const line of output.split("\n")) {
		const fields = line.trim().split(/\s+/);
		if (fields[0]?.toUpperCase() !== "TCP" || fields[3]?.toUpperCase() !== "LISTENING") continue;
		const localAddress = fields[1];
		if (!localAddress || Number.parseInt(localAddress.slice(localAddress.lastIndexOf(":") + 1), 10) !== port) {
			continue;
		}
		const parsed = Number.parseInt(fields[4] ?? "", 10);
		if (Number.isSafeInteger(parsed)) {
			pid = parsed;
			break;
		}
	}
	if (pid === null) return null;

	let image = "unknown";
	const task = await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]);
	if (task !== null) {
		const imageMatch = /^"((?:[^"]|"")*)"/.exec(task.trim());
		image = imageMatch?.[1]?.replaceAll('""', '"') || "unknown";
	}
	return { pid, image };
}

async function findPortHolder(port: number): Promise<PortHolder | null> {
	if (process.platform === "linux") return findLinuxPortHolder(port);
	if (process.platform === "darwin") return findMacPortHolder(port);
	if (process.platform === "win32") return findWindowsPortHolder(port);
	return null;
}

/**
 * Name the process left holding `port` in the log. The holder is never
 * stopped: a pi-stats dashboard lives inside the pi process that launched it
 * (image `node`), so killing the holder would end someone's agent session.
 */
function reportPortHolder(port: number, probe: StatsDashboardProbe): void {
	findPortHolder(port).then(
		holder => logger.warn("Stats dashboard port left to its holder", { port, probe, holder }),
		error => logger.debug("Stats dashboard port holder lookup failed", { port, error: String(error) }),
	);
}

async function claimStatsPort(port: number, hostname: string, ifUnreachable: StatsPortClaim): Promise<StatsPortClaim> {
	const probe = await probeStatsDashboard(port, hostname);
	switch (probe) {
		case "reusable":
			return "reuse";
		case "occupied":
		case "unresponsive":
			// Foreign, another version, or busy/hung: a dashboard stalled mid-ingest must never be stopped.
			reportPortHolder(port, probe);
			return "fallback";
		case "unreachable":
			return ifUnreachable;
	}
}

/**
 * Reuse a current dashboard before binding.
 * The preflight is needed on platforms that permit wildcard and loopback-specific
 * listeners to coexist on one port.
 */
export async function prepareStatsPort(port: number, hostname = STATS_DASHBOARD_HOSTNAME): Promise<StatsPortClaim> {
	if (port === 0) return "bind";
	return claimStatsPort(port, hostname, "bind");
}

/** Reuse a listener found after the server bind reports EADDRINUSE. */
export async function recoverStatsPort(port: number, hostname = STATS_DASHBOARD_HOSTNAME): Promise<StatsPortClaim> {
	return claimStatsPort(port, hostname, "fallback");
}
