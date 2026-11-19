#!/usr/bin/env node
/**
 * `pi-stats`: the standalone dashboard / report bin. Port of omp's
 * `omp stats` (`cli/stats-cli.ts`) and `omp-stats` entry points.
 */
import { styleText } from "node:util";
import {
	closeDb,
	formatStatsDashboardUrl,
	getDashboardStats,
	getTotalMessageCount,
	hasStoredPrices,
	initDb,
	isLoopbackHost,
	type ModelPrice,
	nonLoopbackWarning,
	openBrowser,
	parseStandaloneStatsArgs,
	printStatsSummary,
	refreshRollups,
	setModelPrices,
	startServer,
	syncAllSessions,
} from "./index";

const HELP = `
pi-stats - AI usage statistics dashboard for pi

Usage:
  pi-stats [options]

Options:
  -p, --port <port>    Port for the dashboard server (default: 3847)
  --host <host>        Host to bind (default: 127.0.0.1)
  -s, --summary        Sync session files and print a summary
  -j, --json           Sync session files and print the stats as JSON
  -r, --range <range>  Window of --summary and --json: 1h, 24h, 7d, 30d, 90d or all (default: 24h)
  -h, --help           Show this help message

Examples:
  pi-stats                 # Start the dashboard server
  pi-stats --summary       # Print a summary of the last 24 hours
  pi-stats -s -r all       # Print an all-time summary
  pi-stats --json -r 7d    # Print the last 7 days as JSON
  pi-stats --host 0.0.0.0  # Explicitly expose on all IPv4 interfaces
`;

/**
 * Single-line TTY progress bar. On a non-TTY stream we just stay quiet -
 * the final "Synced ..." summary still prints either way.
 */
function createSyncProgressReporter(): {
	onProgress: (event: { current: number; total: number; sessionFile: string }) => void;
	finish: () => void;
} {
	const stream = process.stderr;
	const isTty = stream.isTTY === true;
	let lastWidth = 0;
	let lastRender = 0;
	return {
		onProgress(event) {
			if (!isTty) return;
			const now = Date.now();
			// Throttle to ~30 fps and always force a render for the last file.
			if (event.current < event.total && now - lastRender < 33) return;
			lastRender = now;
			const counter = `[${event.current}/${event.total}]`;
			const pct = ((event.current / event.total) * 100).toFixed(0).padStart(3, " ");
			// Truncate the plain text, then color: escape codes must not count toward the width.
			const room = (stream.columns ?? 120) - 1 - counter.length - pct.length - 4;
			const label = shortenSessionFile(event.sessionFile);
			const shown = label.length > room ? `${label.slice(0, Math.max(0, room - 1))}\u2026` : label;
			const width = counter.length + pct.length + 4 + shown.length;
			const line = `${styleText("cyan", counter, { stream })} ${pct}%  ${styleText("dim", shown, { stream })}`;
			stream.write(`\r${line}${" ".repeat(Math.max(0, lastWidth - width))}`);
			lastWidth = width;
		},
		finish() {
			if (!isTty || lastWidth === 0) return;
			stream.write(`\r${" ".repeat(lastWidth)}\r`);
			lastWidth = 0;
		},
	};
}

function shortenSessionFile(p: string): string {
	const idx = p.search(/[\\/]sessions[\\/]/);
	return idx >= 0 ? p.slice(idx + "/sessions/".length) : p;
}

/**
 * Seed an empty rate card from pi-ai's built-in catalog when the host package
 * can be resolved (a global `npm i -g` installs it as a peer). A stored card
 * is left alone: the extension's covers `models.json` and extension providers
 * too, and replacing it would re-price their requests.
 */
async function loadCatalogPrices(): Promise<void> {
	await initDb();
	if (hasStoredPrices()) return;
	// Not a literal: the bundler must leave this host import to the runtime.
	const specifier = "@earendil-works/pi-ai/providers/all";
	let catalog: {
		getBuiltinProviders(): string[];
		getBuiltinModels(provider: string): { id: string; provider: string; cost?: Omit<ModelPrice, "provider" | "model"> }[];
	};
	try {
		catalog = await import(specifier);
	} catch {
		return;
	}
	const prices: ModelPrice[] = [];
	for (const provider of catalog.getBuiltinProviders()) {
		for (const model of catalog.getBuiltinModels(provider)) {
			if (model.cost) prices.push({ ...model.cost, provider: model.provider, model: model.id });
		}
	}
	if (prices.length > 0) setModelPrices(prices);
}

async function main(): Promise<void> {
	const args = parseStandaloneStatsArgs(process.argv.slice(2));
	if (args.help) {
		console.log(HELP);
		return;
	}

	await loadCatalogPrices();

	// One-shot reports need fully ingested, fully rolled-up data before printing.
	if (args.json || args.summary) {
		const progress = createSyncProgressReporter();
		process.stderr.write("Syncing session files...\n");
		const { processed, files } = await syncAllSessions({ onProgress: progress.onProgress });
		progress.finish();
		await refreshRollups();
		const total = await getTotalMessageCount();
		process.stderr.write(`Synced ${processed} new entries from ${files} files (${total} total)\n\n`);
		if (args.json) {
			console.log(JSON.stringify(await getDashboardStats(args.range), null, 2));
		} else {
			await printStatsSummary(args.range);
		}
		closeDb();
		return;
	}

	// The dashboard starts immediately and ingests sessions in the background,
	// streaming progress to the page. The bin has no judge: the Frustration
	// page says so.
	if (!isLoopbackHost(args.host)) console.error(styleText("yellow", nonLoopbackWarning(args.host)));
	const server = await startServer(args.port, args.host);
	const url = formatStatsDashboardUrl(server.hostname, server.port);
	console.log(styleText("green", `Dashboard available at: ${url}`));
	openBrowser(url);

	// Another process owns a reused dashboard: show it, never stop it.
	if (server.reused) {
		closeDb();
		return;
	}

	console.log("Press Ctrl+C to stop\n");
	// The server never holds the process open by itself (it also runs inside pi): this timer does.
	const keepAlive = setInterval(() => {}, 1 << 30);
	const shutdown = (): void => {
		clearInterval(keepAlive);
		server.stop();
		closeDb();
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
}

main().catch(error => {
	console.error("Error:", error instanceof Error ? error.message : error);
	closeDb();
	process.exit(1);
});
