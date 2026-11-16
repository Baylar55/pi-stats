import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	getCostDashboardStats,
	getDashboardStats,
	getFolderStats,
	getModelDashboardStats,
	getOverviewStats,
	getProviderDashboardStats,
	getRecentErrors,
	getRecentRequests,
	getRequestDetails,
	getTimeRangeConfig,
	getToolDashboardStats,
} from "./aggregator";
import { isLoopbackHost } from "./command";
import { initDb } from "./db";
import {
	cancelFrustrationRun,
	estimateFrustrationRun,
	getFrustrationDashboardStats,
	type StatsJudgeProvider,
	setStatsJudgeProvider,
	startFrustrationRun,
} from "./frustration";
import { statsLive } from "./live";
import {
	prepareStatsPort,
	recoverStatsPort,
	STATS_DASHBOARD_HEADER,
	STATS_DASHBOARD_HOSTNAME,
	STATS_DASHBOARD_HOSTNAME_HEADER,
	STATS_DASHBOARD_SECURITY_VERSION,
} from "./port-conflict";
import { getStatsByModel, getTimeSeries } from "./rollup";
import {
	buildSessionTrace,
	getTraceEntry,
	listSessionSummaries,
	TRACE_ETAG_VERSION,
	type TraceFingerprint,
	traceEtagForFingerprint,
	traceFingerprintForEtag,
	TracePathError,
} from "./trace";
import { errorCode, isEnoent, logger } from "./util";

/** The only files the dashboard serves from disk, with their content types. */
const CLIENT_FILES: Record<string, string> = {
	"index.html": "text/html; charset=utf-8",
	"index.js": "text/javascript; charset=utf-8",
	"index.css": "text/css; charset=utf-8",
	"favicon.ico": "image/x-icon",
};

/**
 * The built client: `./client` beside this module in a built package,
 * `../dist/client` when running from source. Null until `npm run build` ran.
 */
function clientDir(): string | null {
	for (const relative of ["./client/", "../dist/client/"]) {
		const dir = fileURLToPath(new URL(relative, import.meta.url));
		if (fs.existsSync(path.join(dir, "index.html"))) return dir;
	}
	return null;
}

/**
 * Required on every POST. A custom header forces a CORS preflight, which this
 * server never approves, so a hostile page cannot trigger a paid judge run (or
 * a sync, or a close) through a cross-site form or `fetch`.
 */
const STATS_ACTION_HEADER = "X-Pi-Stats-Action";

/** What the page's Close calls; unset, the page offers none. */
let closeHandler: (() => void) | undefined;

/**
 * Let the page close the dashboard: while `close` is set, it shows a Close
 * button (and takes Esc and Ctrl+C) that calls it. For a launcher that shows
 * the page in place of its own UI; `undefined` takes Close away again. pi
 * opens the system browser, where closing would leave a dead tab, so the
 * bundled launchers never set it.
 */
export function setStatsCloseHandler(close: (() => void) | undefined): void {
	closeHandler = close;
}

/** Refuse a POST that could have been sent by another site; null when it may proceed. */
function rejectForeignPost(req: Request, url: URL): Response | null {
	if (req.headers.get(STATS_ACTION_HEADER) !== "1") {
		return Response.json({ error: `${STATS_ACTION_HEADER}: 1 header required` }, { status: 403 });
	}
	// Browsers send Origin on every cross-origin POST; the dashboard's own page sends its own origin.
	const origin = req.headers.get("origin");
	if (origin !== null && origin !== url.origin) {
		return Response.json({ error: "cross-origin request refused" }, { status: 403 });
	}
	return null;
}

/**
 * Handle API requests.
 */
export async function handleApi(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;

	if (req.method === "POST") {
		const refusal = rejectForeignPost(req, url);
		if (refusal) return refusal;
	} else if (req.method !== "GET" && req.method !== "HEAD") {
		return Response.json({ error: "GET or POST required" }, { status: 405 });
	}

	// Stats reads are DB-only; ingest runs in the background (see `live.ts`).
	const range = url.searchParams.get("range");

	if (path === "/api/status") {
		return Response.json(statsLive().status());
	}

	if (path === "/api/stats") {
		const stats = await getDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/overview") {
		const stats = await getOverviewStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/model-dashboard") {
		const stats = await getModelDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/costs") {
		const stats = await getCostDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/frustration") {
		const stats = await getFrustrationDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/frustration/estimate") {
		const estimate = await estimateFrustrationRun(range, url.searchParams.get("model"));
		return Response.json(estimate);
	}

	if (path === "/api/frustration/judge" || path === "/api/frustration/cancel") {
		if (req.method !== "POST") return Response.json({ error: "POST required" }, { status: 405 });
		if (path === "/api/frustration/cancel") return Response.json(cancelFrustrationRun());
		const result = await startFrustrationRun(range, url.searchParams.get("model"));
		if (!result.started) return Response.json({ error: result.error }, { status: result.status });
		return Response.json(result.job, { status: 202 });
	}

	if (path === "/api/stats/tools") {
		const stats = await getToolDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/providers") {
		const stats = await getProviderDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/recent") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentRequests(limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/errors") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentErrors(range, limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/models") {
		// Also the port-conflict identity probe: keep it to the one query it serves.
		await initDb();
		return Response.json(getStatsByModel(getTimeRangeConfig(range).cutoff));
	}

	if (path === "/api/stats/folders") {
		const stats = await getFolderStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/timeseries") {
		await initDb();
		return Response.json(getTimeSeries(getTimeRangeConfig(range)));
	}

	if (path.startsWith("/api/request/")) {
		const id = path.slice("/api/request/".length);
		if (!/^[1-9]\d{0,15}$/.test(id)) return new Response("Bad Request", { status: 400 });
		const details = await getRequestDetails(Number(id));
		if (!details) return new Response("Not Found", { status: 404 });
		return Response.json(details);
	}

	if (path === "/api/close") {
		if (req.method !== "POST") return Response.json({ closable: closeHandler !== undefined });
		if (!closeHandler) return Response.json({ error: "this dashboard is not closed from its page" }, { status: 404 });
		closeHandler();
		return new Response(null, { status: 202 });
	}

	if (path === "/api/sync") {
		if (req.method !== "POST") return Response.json({ error: "POST required" }, { status: 405 });
		statsLive().requestSync();
		return Response.json(statsLive().status(), { status: 202 });
	}

	if (path === "/api/sessions") {
		const limitParam = Number(url.searchParams.get("limit") ?? "100");
		const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.floor(limitParam) : 100;
		const q = url.searchParams.get("q") ?? undefined;
		return Response.json(await listSessionSummaries(limit, q));
	}

	if (path === "/api/session/trace") {
		const file = url.searchParams.get("file");
		if (!file) return Response.json({ error: "file required" }, { status: 400 });
		try {
			// ETag-first: compare the client's etag against the
			// root+child fingerprint WITHOUT building the trace. A matching
			// (unchanged) poll returns 304 after stats only; only a changed
			// tree pays the full re-read/re-parse/rebuild in
			// buildSessionTrace (itself memoized for non-conditional polls).
			// The fingerprint covers child transcripts and live timings, so
			// neither a child-only append nor a new timing 304s stale.
			const clientEtag = req.headers.get("if-none-match");
			let fingerprint: TraceFingerprint | undefined;
			if (clientEtag) {
				await initDb();
				fingerprint = await traceFingerprintForEtag(file);
				if (fingerprint !== undefined) {
					const etag = `"${TRACE_ETAG_VERSION}:${traceEtagForFingerprint(fingerprint)}"`;
					if (clientEtag === etag) return new Response(null, { status: 304 });
				}
			}
			const trace = await buildSessionTrace(file, fingerprint);
			const etag = `"${TRACE_ETAG_VERSION}:${trace.etag}"`;
			if (clientEtag === etag) return new Response(null, { status: 304 });
			return Response.json(trace, { headers: { ETag: etag } });
		} catch (err) {
			if (err instanceof TracePathError) return Response.json({ error: err.message }, { status: 400 });
			if (isEnoent(err)) return Response.json({ error: "session not found" }, { status: 404 });
			throw err;
		}
	}

	if (path === "/api/session/entry") {
		const file = url.searchParams.get("file");
		const id = url.searchParams.get("id");
		if (!file || !id) return Response.json({ error: "file and id required" }, { status: 400 });
		try {
			const entry = await getTraceEntry(file, id);
			if (!entry) return Response.json({ error: "entry not found" }, { status: 404 });
			return Response.json({ entry });
		} catch (err) {
			if (err instanceof TracePathError) return Response.json({ error: err.message }, { status: 400 });
			throw err;
		}
	}

	return new Response("Not Found", { status: 404 });
}

/**
 * Serve the embedded client. The request path only selects among the fixed
 * {@link CLIENT_FILES}; it is never joined into a filesystem path, so nothing
 * else on disk is reachable. Any other path is the SPA's `index.html`.
 */
async function handleStatic(requestPath: string): Promise<Response> {
	const dir = clientDir();
	if (!dir) {
		return new Response("The stats dashboard client is not built. Run `npm run build` in the pi-stats package.", {
			status: 503,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}
	const requested = requestPath.slice(1);
	const name = Object.hasOwn(CLIENT_FILES, requested) ? requested : "index.html";
	const body = await fs.promises.readFile(path.join(dir, name));
	return new Response(body, { headers: { "Content-Type": CLIENT_FILES[name], "Cache-Control": "no-cache" } });
}

/** Format a dashboard origin, including brackets required by IPv6 literals. */
export function formatStatsDashboardUrl(hostname: string, port: number): string {
	const urlHostname = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
	return `http://${urlHostname}:${port}`;
}

/**
 * Whether a request's `Host` header names this dashboard. A page on another
 * site can point a DNS name it controls at 127.0.0.1 and read the API through
 * the browser (DNS rebinding); its requests carry that name as `Host`, which
 * is refused. A wildcard bind is reachable under names this process cannot
 * know, so it accepts any.
 */
function isAllowedHost(hostHeader: string | undefined, hostname: string, port: number): boolean {
	if (hostname === "0.0.0.0" || hostname === "::") return true;
	if (!hostHeader) return false;
	let requested: URL;
	try {
		requested = new URL(`http://${hostHeader}`);
	} catch {
		return false;
	}
	if ((requested.port || "80") !== String(port)) return false;
	const name = requested.hostname.toLowerCase();
	const bound = new URL(formatStatsDashboardUrl(hostname, port)).hostname.toLowerCase();
	return name === bound || name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

/** Keep-alive comment cadence so proxies and the browser keep the stream open. */
const EVENT_HEARTBEAT_MS = 15_000;

/**
 * Server-sent events of `LiveStatus`: the current status immediately,
 * then every change (sync progress, data version bumps, indexing backlog).
 * Disconnects unsubscribe, so ingest winds down once no page is listening.
 */
function streamLiveEvents(res: http.ServerResponse): void {
	const live = statsLive();
	// Ingest starts when the first page connects, not when the server binds.
	live.start();
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
	// A status frame is a full snapshot: while the socket is backed up the newest one replaces the rest.
	let blocked = false;
	let held: string | null = null;
	const write = (frame: string): void => {
		if (blocked) {
			held = frame;
			return;
		}
		blocked = !res.write(`data: ${frame}\n\n`);
	};
	res.on("drain", () => {
		blocked = false;
		if (held === null) return;
		const frame = held;
		held = null;
		write(frame);
	});
	write(JSON.stringify(live.status()));
	const unsubscribe = live.subscribe((_status, frame) => write(frame));
	const heartbeat = setInterval(() => {
		if (!blocked) res.write(": keep-alive\n\n");
	}, EVENT_HEARTBEAT_MS);
	heartbeat.unref();
	res.on("close", () => {
		unsubscribe();
		clearInterval(heartbeat);
	});
}

async function sendResponse(res: http.ServerResponse, response: Response): Promise<void> {
	response.headers.forEach((value, key) => res.setHeader(key, value));
	res.statusCode = response.status;
	res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

function createDashboardServer(hostname: string): http.Server {
	const server = http.createServer((req, res) => {
		void (async () => {
			// The identity headers let another pi session's reuse probe positively
			// recognize this dashboard without allowing cross-origin API reads.
			res.setHeader(STATS_DASHBOARD_HEADER, STATS_DASHBOARD_SECURITY_VERSION);
			res.setHeader(STATS_DASHBOARD_HOSTNAME_HEADER, hostname);
			const address = server.address();
			const port = address && typeof address === "object" ? address.port : 0;
			try {
				if (!isAllowedHost(req.headers.host, hostname, port)) {
					await sendResponse(res, Response.json({ error: "unrecognized Host header" }, { status: 403 }));
					return;
				}
				// No CORS headers are ever sent, so a preflight never approves anything.
				if (req.method === "OPTIONS") {
					await sendResponse(res, new Response(null, { status: 204 }));
					return;
				}
				const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
				if (url.pathname === "/api/events" && req.method === "GET") {
					streamLiveEvents(res);
					return;
				}
				if (!url.pathname.startsWith("/api/")) {
					await sendResponse(res, await handleStatic(url.pathname));
					return;
				}
				const headers = new Headers();
				for (const [name, value] of Object.entries(req.headers)) {
					if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
				}
				// No route reads a request body, so none is forwarded.
				await sendResponse(res, await handleApi(new Request(url, { method: req.method, headers })));
			} catch (error) {
				logger.error("Stats dashboard request failed", { url: req.url, error: String(error) });
				if (res.headersSent) {
					res.destroy();
					return;
				}
				const message = error instanceof Error ? error.message : "Unknown error";
				await sendResponse(res, Response.json({ error: message }, { status: 500 })).catch(() => res.destroy());
			}
		})();
	});
	// The dashboard also runs inside pi: neither the listener nor an open page (SSE) may keep that process alive.
	server.unref();
	server.on("connection", socket => socket.unref());
	return server;
}

/** A dashboard this process started or found; `reused` distinguishes another process's server from one we own. */
export interface StatsServerHandle {
	hostname: string;
	port: number;
	/** True when the dashboard belongs to another process and this process has no server to keep alive. */
	reused: boolean;
	stop: () => void;
}

// Dashboards this process already bound, keyed by requested and bound
// `hostname:port`. A second in-process start (e.g. `/stats` twice in one
// session, or a caller passing back a fallback port) must return the live
// handle: probing our own port can time out under load and would then start
// yet another dashboard on a fallback port.
const activeServers = new Map<string, StatsServerHandle>();
/** Dashboards bound by this process (any port); background ingest stops when the last one does. */
let liveServers = 0;

export interface StartServerOptions {
	/** Host judge for the Frustration dashboard's judge runs; replaces any previously registered one. */
	judge?: StatsJudgeProvider;
}

/**
 * Start the dashboard on `port`, or reuse the current dashboard already serving it.
 * Any other holder (a foreign program, a dashboard of another version, or one
 * too busy to answer the identity probe) is left running and the dashboard
 * binds an ephemeral port instead.
 */
export async function startServer(
	port = 3847,
	hostname = STATS_DASHBOARD_HOSTNAME,
	options: StartServerOptions = {},
): Promise<StatsServerHandle> {
	if (options.judge) setStatsJudgeProvider(options.judge);
	const requestedKey = `${hostname}:${port}`;
	if (port !== 0) {
		const active = activeServers.get(requestedKey);
		if (active) return active;
	}
	if (!isLoopbackHost(hostname)) {
		logger.warn("Stats dashboard bound to a non-loopback address: transcripts are readable from the network", {
			hostname,
		});
	}
	const register = (server: http.Server): StatsServerHandle => {
		liveServers++;
		let stopped = false;
		const address = server.address();
		const boundPort = address && typeof address === "object" ? address.port : port;
		const keys = port === 0 ? [`${hostname}:${boundPort}`] : [requestedKey, `${hostname}:${boundPort}`];
		const handle: StatsServerHandle = {
			hostname,
			port: boundPort,
			reused: false,
			stop: () => {
				for (const key of keys) activeServers.delete(key);
				if (stopped) return;
				stopped = true;
				server.close();
				server.closeAllConnections();
				// The last dashboard in this process takes background ingest down with it.
				if (--liveServers === 0) statsLive().stop();
			},
		};
		for (const key of keys) activeServers.set(key, handle);
		return handle;
	};

	let claim = await prepareStatsPort(port, hostname);
	if (claim === "bind") {
		const server = await bindDashboardServer(port, hostname);
		if (server) return register(server);
		claim = await recoverStatsPort(port, hostname);
	}
	if (claim === "reuse") return { hostname, port, reused: true, stop: () => {} };
	if (claim === "bind") {
		const server = await bindDashboardServer(port, hostname);
		if (server) return register(server);
	}
	logger.warn("Stats dashboard port is held by another process; serving on an ephemeral port", { hostname, port });
	const fallback = await bindDashboardServer(0, hostname);
	if (!fallback) throw new Error(`Could not bind the stats dashboard on ${hostname}`);
	return register(fallback);
}

/** A listening dashboard server, or null when the port is already in use. */
function bindDashboardServer(port: number, hostname: string): Promise<http.Server | null> {
	const { promise, resolve, reject } = Promise.withResolvers<http.Server | null>();
	const server = createDashboardServer(hostname);
	server.once("error", error => {
		if (errorCode(error) === "EADDRINUSE") resolve(null);
		else reject(error);
	});
	// exclusive: never share the port with another listener of this process's cluster.
	server.listen({ port, host: hostname, exclusive: true }, () => resolve(server));
	return promise;
}
