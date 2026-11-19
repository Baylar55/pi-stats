/**
 * pi-stats runtime: programmatic API of the dashboard, and everything the pi
 * extension entry (`extension.ts`) and the `pi-stats` bin (`cli.ts`) call.
 * Host-free: it never imports `@earendil-works/*` values.
 */
import { parseArgs, styleText } from "node:util";
import { getDashboardStats } from "./aggregator";
import { formatErrorRate } from "./client/data/formatters";
import { DEFAULT_STATS_DASHBOARD_HOST, DEFAULT_STATS_DASHBOARD_PORT } from "./command";
import { type RequestTiming, recordTiming } from "./db";
import { statsLive } from "./live";
import { formatDuration, formatNumber, formatPercent } from "./util";

export {
	getDashboardStats,
	getToolDashboardStats,
	getTotalMessageCount,
	type SyncOptions,
	type SyncProgress,
	syncAllSessions,
} from "./aggregator";
export { isLoopbackHost, nonLoopbackWarning } from "./command";
export { addSessionRoot, getAgentDir, getSessionRoots, getStatsDbPath, setAgentDir } from "./config";
export { closeDb, initDb, type RequestTiming } from "./db";
export type { JudgeCompletion, JudgePrompt } from "./judge";
export { setStatsJudgeProvider, type StatsJudge, type StatsJudgeModel, type StatsJudgeProvider } from "./frustration";
export { canOpenBrowser, openBrowser } from "./open";
export { hasStoredPrices, type ModelPrice, setModelPrices } from "./pricing";
export { refreshRollups } from "./rollup";
export {
	formatStatsDashboardUrl,
	type StartServerOptions,
	type StatsServerHandle,
	setStatsCloseHandler,
	startServer,
} from "./server";
export type {
	AggregatedStats,
	DashboardStats,
	FolderStats,
	MessageStats,
	ModelPerformancePoint,
	ModelStats,
	ModelTimeSeriesPoint,
	TimeSeriesPoint,
	ToolDashboardStats,
	ToolModelStats,
	ToolTimeSeriesPoint,
	ToolUsageStats,
} from "./types";

/**
 * Store a live request timing (see the `timings` table) and let an open
 * dashboard pick it up: the timing lands after the transcript sync, on this
 * process's own connection, so nothing else would tell the pages to refetch.
 */
export function recordRequestTiming(timing: RequestTiming & { sessionFile: string; entryId: string }): void {
	recordTiming(timing);
	statsLive().dataChanged();
}

const bold = (text: string): string => styleText("bold", text);

/** Format an API-equivalent estimate in dollars, or N/A for unpriced usage. */
function formatCost(n: number, unpricedRequests = 0): string {
	if (n === 0 && unpricedRequests > 0) return "N/A";
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

/** Print the dashboard summary to the console (`pi-stats --summary`). */
export async function printStatsSummary(): Promise<void> {
	const stats = await getDashboardStats();
	const { overall, byModel, byFolder } = stats;

	console.log(bold("\n=== AI Usage Statistics ===\n"));

	console.log(bold("Overall:"));
	console.log(`  Requests: ${formatNumber(overall.totalRequests)} (${formatNumber(overall.failedRequests)} errors)`);
	console.log(`  Error Rate: ${formatErrorRate(overall.errorRate)}`);
	console.log(`  Total Tokens: ${formatNumber(overall.totalInputTokens + overall.totalOutputTokens)}`);
	console.log(`  Input Tokens: ${formatNumber(overall.totalInputTokens)}`);
	console.log(`  Output Tokens: ${formatNumber(overall.totalOutputTokens)}`);
	console.log(`  Cache Rate: ${formatPercent(overall.cacheRate)}`);
	console.log(`  Cache Savings: ${formatPercent(overall.cacheSavings)}`);
	console.log(`  API-equivalent estimate: ${formatCost(overall.totalCost, overall.unpricedRequests)}`);
	// Untimed history is N/A, never 0: pi records no TTFT, and durations only on newer messages.
	console.log(`  Avg Duration: ${overall.avgDuration !== null ? formatDuration(overall.avgDuration) : "N/A"}`);
	console.log(`  Avg TTFT: ${overall.avgTtft !== null ? formatDuration(overall.avgTtft) : "N/A"}`);
	console.log(
		`  Avg Tokens/s: ${overall.avgTokensPerSecond !== null ? overall.avgTokensPerSecond.toFixed(1) : "N/A"}`,
	);

	if (byModel.length > 0) {
		console.log(bold("\nBy Model (API-equivalent estimates):"));
		for (const m of byModel.slice(0, 10)) {
			console.log(
				`  ${m.model}: ${formatNumber(m.totalRequests)} reqs, ${formatCost(m.totalCost, m.unpricedRequests)}, ${formatPercent(m.cacheRate)} cache rate, ${formatPercent(m.cacheSavings)} cache savings`,
			);
		}
	}

	if (byFolder.length > 0) {
		console.log(bold("\nBy Folder (API-equivalent estimates):"));
		for (const f of byFolder.slice(0, 10)) {
			console.log(
				`  ${f.folder}: ${formatNumber(f.totalRequests)} reqs, ${formatCost(f.totalCost, f.unpricedRequests)}`,
			);
		}
	}

	console.log("");
}

/** Parsed arguments of the `pi-stats` bin. */
export interface StandaloneStatsArgs {
	port: number;
	host: string;
	json: boolean;
	summary: boolean;
	help: boolean;
}

/** Parse the `pi-stats` bin arguments; loopback unless a host is given. Throws on an unknown flag or a bad port. */
export function parseStandaloneStatsArgs(args: string[]): StandaloneStatsArgs {
	const { values } = parseArgs({
		args,
		options: {
			port: { type: "string", short: "p", default: String(DEFAULT_STATS_DASHBOARD_PORT) },
			host: { type: "string", default: DEFAULT_STATS_DASHBOARD_HOST },
			json: { type: "boolean", short: "j", default: false },
			summary: { type: "boolean", short: "s", default: false },
			help: { type: "boolean", short: "h", default: false },
		},
		allowPositionals: true,
	});
	const port = /^\d+$/.test(values.port) ? Number(values.port) : Number.NaN;
	if (!Number.isInteger(port) || port > 65_535) throw new Error(`Invalid port: ${values.port}`);
	return {
		port,
		host: values.host || DEFAULT_STATS_DASHBOARD_HOST,
		json: values.json,
		summary: values.summary,
		help: values.help,
	};
}
