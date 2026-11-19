import { describe, expect, it } from "vitest";
import {
	completeStatsDashboardArgs,
	isLoopbackHost,
	parseStatsDashboardArgs,
} from "../src/command";
import { parseStandaloneStatsArgs } from "../src/index";
import { formatStatsDashboardUrl } from "../src/server";

describe("standalone stats CLI", () => {
	it("keeps the production parser loopback-only by default", () => {
		expect(parseStandaloneStatsArgs([])).toEqual({
			port: 3847,
			host: "127.0.0.1",
			json: false,
			summary: false,
			range: "24h",
			help: false,
		});
	});

	it("takes the --summary/--json window and rejects an unknown one instead of falling back to 24h", () => {
		expect(parseStandaloneStatsArgs(["-s", "-r", "ALL"]).range).toBe("all");
		expect(parseStandaloneStatsArgs(["--json", "--range=7d"]).range).toBe("7d");
		expect(() => parseStandaloneStatsArgs(["--range", "2d"])).toThrow("Invalid range: 2d");
	});

	it("forwards explicit bind hosts and formats IPv6 dashboard URLs", () => {
		expect(parseStandaloneStatsArgs(["--host", "::", "--port", "3850"])).toMatchObject({
			port: 3850,
			host: "::",
		});
		expect(formatStatsDashboardUrl("::", 3850)).toBe("http://[::]:3850");
		expect(formatStatsDashboardUrl("2001:db8::1", 3850)).toBe("http://[2001:db8::1]:3850");
	});

	it("rejects a port that is not a port instead of binding a surprise one", () => {
		expect(() => parseStandaloneStatsArgs(["--port", "80a"])).toThrow("Invalid port: 80a");
		expect(() => parseStandaloneStatsArgs(["--port", "70000"])).toThrow("Invalid port: 70000");
	});
});

describe("/stats arguments", () => {
	it("defaults to loopback on 3847 and accepts every flag spelling", () => {
		expect(parseStatsDashboardArgs("")).toEqual({ port: 3847, host: "127.0.0.1" });
		expect(parseStatsDashboardArgs("-p 4000 --host=0.0.0.0")).toEqual({ port: 4000, host: "0.0.0.0" });
		expect(parseStatsDashboardArgs("--port=4001 --host ::1")).toEqual({ port: 4001, host: "::1" });
	});

	it("reports the exact usage and error strings", () => {
		const usage = "Usage: /stats [--port <port>] [--host <host>]";
		expect(parseStatsDashboardArgs("--port")).toEqual({ error: `Missing port. ${usage}` });
		expect(parseStatsDashboardArgs("--port=99999")).toEqual({ error: "Invalid port: 99999" });
		expect(parseStatsDashboardArgs("-p x1")).toEqual({ error: "Invalid port: x1" });
		expect(parseStatsDashboardArgs("--host")).toEqual({ error: `Missing host. ${usage}` });
		expect(parseStatsDashboardArgs("--host=")).toEqual({ error: `Missing host. ${usage}` });
		expect(parseStatsDashboardArgs("--nope")).toEqual({ error: `Unknown option: --nope. ${usage}` });
	});

	it("completes flags as whole-argument replacements and skips flags already given", () => {
		expect(completeStatsDashboardArgs("--p")?.map(item => item.value)).toEqual(["--port "]);
		expect(completeStatsDashboardArgs("")?.map(item => item.label)).toEqual(["--port", "--host"]);
		expect(completeStatsDashboardArgs("-p 4000 --")?.map(item => item.value)).toEqual(["-p 4000 --host "]);
		expect(completeStatsDashboardArgs("--port 4000 --host 0.0.0.0 --")).toBeNull();
		expect(completeStatsDashboardArgs("--host ")?.map(item => item.value)).toEqual(["--host 127.0.0.1 "]);
	});

	it("treats only loopback names and addresses as loopback", () => {
		for (const host of ["127.0.0.1", "127.8.9.10", "localhost", "::1", "[::1]"]) {
			expect(isLoopbackHost(host)).toBe(true);
		}
		for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.com", "127.0.0.1.evil.com"]) {
			expect(isLoopbackHost(host)).toBe(false);
		}
	});
});
