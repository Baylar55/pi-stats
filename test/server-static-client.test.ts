/**
 * The HTTP surface of a real dashboard server: the static client allow-list,
 * the same-origin rules, and the live event stream. Needs the built client
 * (`npm test` builds it first).
 */
import * as fs from "node:fs";
import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type StatsServerHandle, setStatsCloseHandler, startServer } from "../src/server";
import { assistant, header, sessionPath, writeSession } from "./helpers/session";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-server-");

let server: StatsServerHandle;
let origin: string;

beforeEach(async () => {
	server = await startServer(0);
	origin = `http://127.0.0.1:${server.port}`;
});

afterEach(() => {
	setStatsCloseHandler(undefined);
	server.stop();
});

interface RawResponse {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}

/** A request with full control of the request line and headers (`fetch` normalizes paths and forbids `Host`). */
function raw(path: string, options: { method?: string; headers?: Record<string, string> } = {}): Promise<RawResponse> {
	const { promise, resolve, reject } = Promise.withResolvers<RawResponse>();
	const request = http.request(
		{ host: "127.0.0.1", port: server.port, path, method: options.method ?? "GET", headers: options.headers },
		response => {
			const chunks: Buffer[] = [];
			response.on("data", chunk => chunks.push(chunk));
			response.on("end", () =>
				resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }),
			);
		},
	);
	request.on("error", reject);
	request.end();
	return promise;
}

const ACTION = { "X-Pi-Stats-Action": "1" };

describe("static client", () => {
	it("serves the built client with content types and no caching", async () => {
		expect(fs.existsSync("dist/client/index.html"), "run `npm run build` first").toBe(true);

		const index = await raw("/");
		expect(index.status).toBe(200);
		expect(index.headers["content-type"]).toBe("text/html; charset=utf-8");
		expect(index.headers["cache-control"]).toBe("no-cache");
		expect(index.body).toContain('<div id="root">');

		expect((await raw("/index.js")).headers["content-type"]).toBe("text/javascript; charset=utf-8");
		expect((await raw("/index.css")).headers["content-type"]).toBe("text/css; charset=utf-8");
		expect((await raw("/favicon.ico")).headers["content-type"]).toBe("image/x-icon");
	});

	it("answers every other path with the app shell, never with a file from disk", async () => {
		const shell = (await raw("/")).body;
		for (const path of [
			"/models",
			"/package.json",
			"/../package.json",
			"/..%2f..%2fpackage.json",
			"/%2e%2e/%2e%2e/package.json",
			"/..\\..\\package.json",
			"/client/../../package.json",
			"/index.html/../../package.json",
			"//etc/passwd",
			"/C:/Windows/win.ini",
		]) {
			const response = await raw(path);
			expect(response.status, path).toBe(200);
			expect(response.body, path).toBe(shell);
		}
	});
});

describe("same-origin enforcement", () => {
	it("stamps the identity headers and never a CORS header", async () => {
		for (const response of [await raw("/"), await raw("/api/status"), await raw("/api/nope"), await raw("/api/status", { method: "OPTIONS" })]) {
			expect(response.headers["x-pi-stats-dashboard"]).toBe("1");
			expect(response.headers["x-pi-stats-hostname"]).toBe("127.0.0.1");
			expect(response.headers["access-control-allow-origin"]).toBeUndefined();
			expect(response.headers["access-control-allow-headers"]).toBeUndefined();
		}
		expect((await raw("/api/status", { method: "OPTIONS" })).status).toBe(204);
	});

	it("refuses a Host header that does not name this dashboard (DNS rebinding)", async () => {
		for (const host of ["evil.example", `evil.example:${server.port}`, "127.0.0.1:1", `127.0.0.1.evil.example:${server.port}`]) {
			const response = await raw("/api/stats", { headers: { Host: host } });
			expect(response.status, host).toBe(403);
			expect(response.body, host).not.toContain("overall");
		}
		expect((await raw("/", { headers: { Host: "evil.example" } })).status).toBe(403);
		for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`, `LOCALHOST:${server.port}`]) {
			expect((await raw("/api/status", { headers: { Host: host } })).status, host).toBe(200);
		}
	});

	it("requires the action header and a same-origin Origin on every POST", async () => {
		for (const path of ["/api/sync", "/api/frustration/judge", "/api/frustration/cancel", "/api/close"]) {
			expect((await raw(path, { method: "POST" })).status, path).toBe(403);
			const crossOrigin = await raw(path, { method: "POST", headers: { ...ACTION, Origin: "http://evil.example" } });
			expect(crossOrigin.status, path).toBe(403);
		}
		// A page served from another port of this machine is another origin too.
		expect((await raw("/api/sync", { method: "POST", headers: { ...ACTION, Origin: "http://127.0.0.1:1" } })).status).toBe(403);

		expect((await raw("/api/sync", { method: "POST", headers: { ...ACTION, Origin: origin } })).status).toBe(202);
		// Not a browser (no Origin): the custom header alone is the proof it is not a form post.
		expect((await raw("/api/frustration/cancel", { method: "POST", headers: ACTION })).status).toBe(200);
	});

	it("only accepts a positive integer request id", async () => {
		for (const id of ["0", "-1", "1e3", "1.5", "abc", "1/2", "%31", ""]) {
			expect((await raw(`/api/request/${id}`)).status, id).toBe(400);
		}
		expect((await raw("/api/request/999999")).status).toBe(404);
	});

	it("refuses to read a transcript outside the session roots", async () => {
		for (const file of ["/etc/passwd", "C:\\Windows\\win.ini", "../../stats.db", "..\\..\\auth.json"]) {
			const trace = await raw(`/api/session/trace?file=${encodeURIComponent(file)}`);
			expect(trace.status, file).toBe(400);
			const entry = await raw(`/api/session/entry?file=${encodeURIComponent(file)}&id=x`);
			expect(entry.status, file).toBe(400);
		}
	});
});

describe("close button", () => {
	it("is offered only while a launcher registered a way to close the page", async () => {
		expect(JSON.parse((await raw("/api/close")).body)).toEqual({ closable: false });
		expect((await raw("/api/close", { method: "POST", headers: ACTION })).status).toBe(404);

		let closed = 0;
		setStatsCloseHandler(() => closed++);
		expect(JSON.parse((await raw("/api/close")).body)).toEqual({ closable: true });
		expect((await raw("/api/close", { method: "POST", headers: ACTION })).status).toBe(202);
		expect(closed).toBe(1);
	});
});

describe("live events", () => {
	it("starts ingest when a page connects and streams status until the data lands", async () => {
		await writeSession(sessionPath(), [header(), assistant("a1", { timestamp: Date.now() })]);
		// Nothing is ingested before a page listens.
		expect(JSON.parse((await raw("/api/stats/overview?range=all")).body).overall.totalRequests).toBe(0);

		const response = await fetch(`${origin}/api/events`);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		const reader = response.body?.getReader();
		if (!reader) throw new Error("no event stream");
		const decoder = new TextDecoder();
		let text = "";
		let synced = false;
		while (!synced) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
			for (const frame of text.split("\n\n")) {
				if (!frame.startsWith("data: ")) continue;
				const status = JSON.parse(frame.slice("data: ".length));
				if (status.sync.lastSyncedAt !== null && status.sync.phase === "idle") synced = true;
			}
		}
		await reader.cancel();

		expect(synced).toBe(true);
		expect(JSON.parse((await raw("/api/stats/overview?range=all")).body).overall.totalRequests).toBe(1);
	});
});
