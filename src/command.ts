/**
 * `/stats` argument handling and completion.
 */

export const DEFAULT_STATS_DASHBOARD_PORT = 3847;
export const DEFAULT_STATS_DASHBOARD_HOST = "127.0.0.1";

export interface StatsDashboardArgs {
	port: number;
	host: string;
}

const STATS_DASHBOARD_USAGE = "Usage: /stats [--port <port>] [--host <host>]";

function parsePort(value: string | undefined): number | string {
	if (!value) return `Missing port. ${STATS_DASHBOARD_USAGE}`;
	if (!/^\d+$/.test(value)) return `Invalid port: ${value}`;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) return `Invalid port: ${value}`;
	return port;
}

export function parseStatsDashboardArgs(args: string): StatsDashboardArgs | { error: string } {
	const tokens = args.split(/\s+/).filter(Boolean);
	let port = DEFAULT_STATS_DASHBOARD_PORT;
	let host = DEFAULT_STATS_DASHBOARD_HOST;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--port" || token === "-p") {
			const parsed = parsePort(tokens[++i]);
			if (typeof parsed === "string") return { error: parsed };
			port = parsed;
			continue;
		}
		if (token.startsWith("--port=")) {
			const parsed = parsePort(token.slice("--port=".length));
			if (typeof parsed === "string") return { error: parsed };
			port = parsed;
			continue;
		}
		if (token === "--host") {
			const value = tokens[++i];
			if (!value) return { error: `Missing host. ${STATS_DASHBOARD_USAGE}` };
			host = value;
			continue;
		}
		if (token.startsWith("--host=")) {
			const value = token.slice("--host=".length);
			if (!value) return { error: `Missing host. ${STATS_DASHBOARD_USAGE}` };
			host = value;
			continue;
		}
		return { error: `Unknown option: ${token}. ${STATS_DASHBOARD_USAGE}` };
	}

	return { port, host };
}

/** Shape of pi-tui's `AutocompleteItem`; structural so this module stays host-free. */
export interface StatsCompletion {
	value: string;
	label: string;
	description?: string;
}

const FLAGS: readonly { flag: string; description: string; hint: string }[] = [
	{ flag: "--port", description: `Dashboard port (default ${DEFAULT_STATS_DASHBOARD_PORT})`, hint: "3847" },
	{ flag: "--host", description: `Bind host (default ${DEFAULT_STATS_DASHBOARD_HOST})`, hint: "127.0.0.1" },
];

/**
 * Completions for the text typed after `/stats`. pi replaces the whole
 * argument text with the chosen `value`, so each value repeats what precedes
 * the token being completed.
 */
export function completeStatsDashboardArgs(argumentText: string): StatsCompletion[] | null {
	const cut = argumentText.search(/\S*$/);
	const head = argumentText.slice(0, cut);
	const token = argumentText.slice(cut);
	const before = head.split(/\s+/).filter(Boolean);
	const previous = before.at(-1);

	// After a flag that takes a value, offer its default as a hint.
	const awaiting = FLAGS.find(entry => entry.flag === previous || (entry.flag === "--port" && previous === "-p"));
	if (awaiting) {
		if (!awaiting.hint.startsWith(token)) return null;
		return [{ value: `${head}${awaiting.hint} `, label: awaiting.hint, description: awaiting.description }];
	}

	const items: StatsCompletion[] = [];
	for (const entry of FLAGS) {
		if (!entry.flag.startsWith(token)) continue;
		// A flag already given (in any spelling) is not offered again.
		const given = before.some(
			word => word === entry.flag || word.startsWith(`${entry.flag}=`) || (entry.flag === "--port" && word === "-p"),
		);
		if (!given) items.push({ value: `${head}${entry.flag} `, label: entry.flag, description: entry.description });
	}
	return items.length > 0 ? items : null;
}

/** Whether `host` only accepts connections from this machine. */
export function isLoopbackHost(host: string): boolean {
	const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
	return bare === "localhost" || bare === "::1" || /^127(\.\d{1,3}){3}$/.test(bare);
}

/** The warning both launchers show for a non-loopback bind: transcripts hold code and secrets. */
export function nonLoopbackWarning(host: string): string {
	return `Warning: the stats dashboard is bound to ${host}, not loopback. Anyone who can reach this address can read your session transcripts, including code and secrets.`;
}
