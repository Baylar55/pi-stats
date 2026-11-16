import * as http from "node:http";
import * as net from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
	STATS_DASHBOARD_HEADER,
	STATS_DASHBOARD_HOSTNAME,
	STATS_DASHBOARD_HOSTNAME_HEADER,
	STATS_DASHBOARD_SECURITY_VERSION,
} from "../src/port-conflict";
import { startServer } from "../src/server";
import { sleep } from "../src/util";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-port-conflict-");

/**
 * Directly probe a TCP endpoint. Resolves true when the connection is accepted,
 * false when refused or unanswered: a firewall in stealth mode drops the SYN to
 * a closed port instead of refusing it, so a real one-second bound keeps the
 * probe inside the test timeout.
 */
function tcpConnects(hostname: string, port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const socket = net.connect({ host: hostname, port, timeout: 1_000 });
	const settle = (connected: boolean) => {
		socket.destroy();
		resolve(connected);
	};
	socket.once("connect", () => settle(true));
	socket.once("error", () => settle(false));
	socket.once("timeout", () => settle(false));
	return promise;
}

function getNonLoopbackHostname(): string | undefined {
	const interfaces = networkInterfaces();
	for (const name in interfaces) {
		for (const address of interfaces[name] ?? []) {
			if (address.family === "IPv4" && !address.internal) return address.address;
		}
	}
	return undefined;
}

const holders: http.Server[] = [];

/** Some other program holding a port: answers every request through `respond`. */
async function startHolder(respond: (res: http.ServerResponse) => void): Promise<{ port: number; requests: () => number }> {
	let requests = 0;
	const server = http.createServer((_req, res) => {
		requests++;
		respond(res);
	});
	holders.push(server);
	const { promise, resolve } = Promise.withResolvers<void>();
	server.listen(0, STATS_DASHBOARD_HOSTNAME, resolve);
	await promise;
	const address = server.address();
	if (!address || typeof address !== "object") throw new Error("holder did not bind");
	return { port: address.port, requests: () => requests };
}

function dashboardHeaders(version = STATS_DASHBOARD_SECURITY_VERSION, hostname = STATS_DASHBOARD_HOSTNAME) {
	return { "content-type": "application/json", [STATS_DASHBOARD_HEADER]: version, [STATS_DASHBOARD_HOSTNAME_HEADER]: hostname };
}

/** Assert that a current, same-origin-only dashboard answers on `port`. */
async function expectCurrentDashboard(port: number): Promise<void> {
	const response = await fetch(`http://${STATS_DASHBOARD_HOSTNAME}:${port}/api/stats/models`);
	expect(response.status).toBe(200);
	expect(response.headers.get(STATS_DASHBOARD_HEADER)).toBe(STATS_DASHBOARD_SECURITY_VERSION);
	expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
	await response.body?.cancel();
}

afterEach(() => {
	for (const holder of holders) {
		holder.close();
		holder.closeAllConnections();
	}
	holders.length = 0;
});

describe("startServer access", () => {
	it("only serves loopback requests without cross-origin access", async () => {
		const server = await startServer(0);
		try {
			expect(server.hostname).toBe(STATS_DASHBOARD_HOSTNAME);
			const response = await fetch(`http://${server.hostname}:${server.port}/api/stats/models`);
			expect(response.status).toBe(200);
			expect(response.headers.get(STATS_DASHBOARD_HEADER)).toBe(STATS_DASHBOARD_SECURITY_VERSION);
			expect(response.headers.get(STATS_DASHBOARD_HOSTNAME_HEADER)).toBe(STATS_DASHBOARD_HOSTNAME);
			expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
			await response.body?.cancel();

			const nonLoopbackHostname = getNonLoopbackHostname();
			expect(await tcpConnects(server.hostname, server.port)).toBe(true);
			if (nonLoopbackHostname) expect(await tcpConnects(nonLoopbackHostname, server.port)).toBe(false);
		} finally {
			server.stop();
		}
	});

	it("serves non-loopback requests only when explicitly requested", async () => {
		const nonLoopbackHostname = getNonLoopbackHostname();
		if (!nonLoopbackHostname) return;
		const server = await startServer(0, "0.0.0.0");
		try {
			expect(server.hostname).toBe("0.0.0.0");
			expect(await tcpConnects(nonLoopbackHostname, server.port)).toBe(true);
			const response = await fetch(`http://${STATS_DASHBOARD_HOSTNAME}:${server.port}/api/stats/models`);
			expect(response.status).toBe(200);
			expect(response.headers.get(STATS_DASHBOARD_HOSTNAME_HEADER)).toBe("0.0.0.0");
			expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
			await response.body?.cancel();
		} finally {
			server.stop();
		}
	});

	it("stops answering once stopped and frees the port", async () => {
		const server = await startServer(0);
		server.stop();
		server.stop();

		expect(await tcpConnects(server.hostname, server.port)).toBe(false);
	});
});

describe("startServer port conflicts", () => {
	it("returns the live in-process handle when started twice on the same port", async () => {
		const reserved = await startHolder(res => res.end());
		holders.pop()?.close();
		const first = await startServer(reserved.port);
		try {
			// Regression: the second start used to probe our own port and could
			// dead-end in "Port X is held by the current process".
			const second = await startServer(reserved.port);
			expect(second.port).toBe(first.port);
			expect(second).toBe(first);
		} finally {
			first.stop();
		}
	});

	it("reuses a live stats dashboard identified by its headers", async () => {
		const existing = await startHolder(res => res.writeHead(200, dashboardHeaders()).end("[]"));

		const server = await startServer(existing.port);

		expect(server.port).toBe(existing.port);
		expect(server.reused).toBe(true);
		server.stop();
		// The existing dashboard is untouched: it still answers on the port.
		await expectCurrentDashboard(existing.port);
	});

	it("reuses a live dashboard that answers slowly while it ingests", async () => {
		// A dashboard stalled by ingest must not be mistaken for a hung listener.
		const existing = await startHolder(res => {
			void sleep(1_000).then(() => res.writeHead(200, dashboardHeaders()).end("[]"));
		});

		const server = await startServer(existing.port);

		expect(server).toMatchObject({ port: existing.port, reused: true });
	});

	for (const fixture of [
		{ name: "an omp stats dashboard on the shared default port", respond: (res: http.ServerResponse) => res.writeHead(200, { "x-omp-stats-dashboard": "3", "x-omp-stats-hostname": "127.0.0.1" }).end("[]") },
		{ name: "a dashboard of another version", respond: (res: http.ServerResponse) => res.writeHead(200, dashboardHeaders(String(Number(STATS_DASHBOARD_SECURITY_VERSION) + 1))).end("[]") },
		{ name: "a dashboard bound to another host", respond: (res: http.ServerResponse) => res.writeHead(200, dashboardHeaders(STATS_DASHBOARD_SECURITY_VERSION, "0.0.0.0")).end("[]") },
		{ name: "a dashboard look-alike that allows cross-origin reads", respond: (res: http.ServerResponse) => res.writeHead(200, { ...dashboardHeaders(), "Access-Control-Allow-Origin": "*" }).end("[]") },
		{ name: "a foreign 200 responder", respond: (res: http.ServerResponse) => res.writeHead(200).end('{"app":"spa"}') },
		{ name: "a foreign listener that fails the probe", respond: (res: http.ServerResponse) => res.writeHead(404).end("foreign") },
		// Never answering is what a dashboard stalled mid-ingest looks like; it must be left alone.
		{ name: "a listener that never answers", respond: () => {} },
	]) {
		it(`serves on a free port beside ${fixture.name}`, async () => {
			const holder = await startHolder(fixture.respond);

			const server = await startServer(holder.port);
			try {
				expect(server.port).not.toBe(holder.port);
				expect(server.reused).toBe(false);
				await expectCurrentDashboard(server.port);
				// The holder was probed, never stopped: it still accepts connections.
				expect(holder.requests()).toBeGreaterThan(0);
				expect(await tcpConnects(STATS_DASHBOARD_HOSTNAME, holder.port)).toBe(true);
			} finally {
				server.stop();
			}
		}, 10_000);
	}

	it("serves on a free port when a non-HTTP program holds the requested one", async () => {
		const raw = net.createServer(socket => socket.destroy());
		const { promise, resolve } = Promise.withResolvers<void>();
		raw.listen(0, STATS_DASHBOARD_HOSTNAME, resolve);
		await promise;
		const address = raw.address();
		if (!address || typeof address !== "object") throw new Error("raw holder did not bind");

		const server = await startServer(address.port);
		try {
			expect(server.port).not.toBe(address.port);
			await expectCurrentDashboard(server.port);
		} finally {
			server.stop();
			raw.close();
		}
	});
});
