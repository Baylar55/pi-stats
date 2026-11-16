/**
 * pi extension entry: registers `/stats` and captures request timing.
 *
 * pi re-evaluates this module on every `/new`, `/resume`, `/fork` and
 * `/reload` (extensions load with the module cache off), so nothing here may
 * hold the dashboard. The process-wide state lives on `globalThis`, and the
 * runtime (`dist/index.js`: server, database, ingest) is a separate, host-free
 * module loaded lazily, once per process. The factory itself starts nothing.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	completeStatsDashboardArgs,
	isLoopbackHost,
	nonLoopbackWarning,
	parseStatsDashboardArgs,
	type StatsDashboardArgs,
} from "./command";
import type * as Runtime from "./index";

interface ProcessState {
	/** The runtime module; shared by every instance of this entry in the process. */
	runtime?: Promise<typeof Runtime>;
	/** The dashboard this process started or found. Survives session switches. */
	server?: Runtime.StatsServerHandle;
	/** Timing rows still being written; awaited before the database closes. */
	writes?: Promise<void>;
}

declare global {
	var __piStats: ProcessState | undefined;
}

const state: ProcessState = (globalThis.__piStats ??= {});

/** Output budget of one judge reply: room for a thinking preamble before the label (omp's `JUDGMENT_CHAT_MAX_TOKENS`). */
const JUDGE_MAX_TOKENS = 4096;

/** Stream events that carry model output; the first one marks the first token. */
const CONTENT_EVENTS: Record<string, true> = {
	text_start: true,
	text_delta: true,
	thinking_start: true,
	thinking_delta: true,
	toolcall_start: true,
	toolcall_delta: true,
};

function loadRuntime(): Promise<typeof Runtime> {
	// Dynamic on purpose: the runtime must load once per process, outside this entry's
	// per-session re-evaluation, and it is a build output beside this file, not a source module.
	state.runtime ??= import(new URL("./index.js", import.meta.url).href).then((runtime: typeof Runtime) => {
		runtime.setAgentDir(getAgentDir());
		return runtime;
	});
	return state.runtime;
}

/** `judgeModel` (`provider/model`) from `<agentDir>/pi-stats.json`, when the user set one. */
function configuredJudgeModel(): string | undefined {
	try {
		const config: unknown = JSON.parse(readFileSync(path.join(getAgentDir(), "pi-stats.json"), "utf8"));
		if (!config || typeof config !== "object" || !("judgeModel" in config)) return undefined;
		return typeof config.judgeModel === "string" && config.judgeModel ? config.judgeModel : undefined;
	} catch {
		return undefined;
	}
}

function splitModelId(id: string): [provider: string, model: string] {
	// Model ids may contain slashes (`nvidia/z-ai/glm-5.2`): the provider ends at the first one.
	const slash = id.indexOf("/");
	return slash < 0 ? ["", id] : [id.slice(0, slash), id.slice(slash + 1)];
}

/** The Frustration judge: chat completions through pi's model registry, with the session's own auth. */
function createJudge(ctx: ExtensionContext): Runtime.StatsJudge {
	const registry = ctx.modelRegistry;
	const sessionModel = ctx.model;
	return {
		models() {
			const models: Runtime.StatsJudgeModel[] = [];
			const seen = new Set<string>();
			const add = (model: Model<Api> | undefined): void => {
				if (!model) return;
				const id = `${model.provider}/${model.id}`;
				if (seen.has(id)) return;
				seen.add(id);
				// Subscription and OAuth models carry a zero rate card: no price, not a free judge.
				const priced = model.cost.input > 0 || model.cost.output > 0;
				models.push(priced ? { id, inputPrice: model.cost.input, outputPrice: model.cost.output } : { id });
			};
			// Default first: the configured judge, else the session's current model.
			const configured = configuredJudgeModel();
			if (configured) add(registry.find(...splitModelId(configured)));
			add(sessionModel);
			for (const model of registry.getAvailable()) add(model);
			return models;
		},
		async complete(modelId, prompt, signal) {
			const model = registry.find(...splitModelId(modelId));
			if (!model) throw new Error(`Unknown judge model: ${modelId}`);
			// No `temperature`: pi forwards it verbatim and reasoning models reject the parameter.
			const response = await registry.complete(
				model,
				{ systemPrompt: prompt.system, messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }] },
				{ signal, maxTokens: JUDGE_MAX_TOKENS },
			);
			if (response.stopReason === "aborted" || signal.aborted) {
				throw signal.reason instanceof Error ? signal.reason : new Error("Judge request aborted");
			}
			if (response.stopReason === "error") throw new Error(response.errorMessage ?? "Judge request failed");
			let text = "";
			for (const block of response.content) {
				if (block.type === "text") text += (text ? " " : "") + block.text;
			}
			// Subscription and OAuth providers record zero: no known cost, not a free judgment.
			const cost = response.usage.cost.total;
			return cost > 0 ? { text: text.trim(), cost } : { text: text.trim() };
		},
	};
}

/** Hand the runtime what only the live session knows: its session dir, the rate card and the judge. */
function bindHost(runtime: typeof Runtime, ctx: ExtensionContext): void {
	// Covers `--session-dir` and project settings, which the runtime cannot see on its own.
	runtime.addSessionRoot(ctx.sessionManager.getSessionDir());
	runtime.setStatsJudgeProvider(async () => createJudge(ctx));
}

/** Store pi's rate card (built-in, models.json and extension providers) so ingest can price usage. */
async function publishPrices(runtime: typeof Runtime, ctx: ExtensionContext): Promise<void> {
	await runtime.initDb();
	runtime.setModelPrices(
		ctx.modelRegistry.getAll().map(model => ({
			provider: model.provider,
			model: model.id,
			input: model.cost.input,
			output: model.cost.output,
			cacheRead: model.cost.cacheRead,
			cacheWrite: model.cost.cacheWrite,
			tiers: model.cost.tiers,
		})),
	);
}

/**
 * Start (or reuse) the dashboard and open it, without waiting for ingest: the
 * server syncs sessions in the background and streams progress to the page.
 * Port of omp's `launchStatsDashboard`; the messages are verbatim.
 */
async function launchStatsDashboard(args: StatsDashboardArgs, ctx: ExtensionCommandContext): Promise<void> {
	const runtime = await loadRuntime();
	bindHost(runtime, ctx);
	await publishPrices(runtime, ctx);

	let requestedAddressIgnored = false;
	if (!state.server) {
		state.server = await runtime.startServer(args.port, args.host);
	} else {
		requestedAddressIgnored = args.port !== state.server.port || args.host !== state.server.hostname;
	}

	const url = runtime.formatStatsDashboardUrl(state.server.hostname, state.server.port);
	if (!ctx.hasUI) {
		// Print and JSON modes have no notification surface: the URL goes to stdout.
		process.stdout.write(`${url}\n`);
		return;
	}
	if (!isLoopbackHost(state.server.hostname)) ctx.ui.notify(nonLoopbackWarning(state.server.hostname), "warning");
	// Over SSH or without a display nothing opens; the URL below is then all there is.
	runtime.openBrowser(url);
	const serverLine = requestedAddressIgnored
		? `Dashboard already running at: ${url} (requested ${args.host}:${args.port} ignored)`
		: `Dashboard available at: ${url}`;
	ctx.ui.notify(`${serverLine} (sessions sync in the background)`, "info");
}

export default function piStats(pi: ExtensionAPI): void {
	pi.registerCommand("stats", {
		description: "Open the AI usage statistics dashboard",
		getArgumentCompletions: completeStatsDashboardArgs,
		handler: async (args, ctx) => {
			const parsed = parseStatsDashboardArgs(args);
			if ("error" in parsed) {
				if (ctx.hasUI) ctx.ui.notify(parsed.error, "error");
				else process.stderr.write(`${parsed.error}\n`);
				return;
			}
			try {
				await launchStatsDashboard(parsed, ctx);
			} catch (error) {
				const message = `Failed to start the stats dashboard: ${error instanceof Error ? error.message : String(error)}`;
				if (ctx.hasUI) ctx.ui.notify(message, "error");
				else process.stderr.write(`${message}\n`);
			}
		},
	});

	// A running dashboard judges through the newest session: the previous context is stale after a switch.
	pi.on("session_start", async (_event, ctx) => {
		if (state.server && state.runtime) bindHost(await state.runtime, ctx);
	});

	// pi records no time-to-first-token (and no duration on older versions), so it is measured
	// here per assistant message and stored beside the stats, never in the transcript.
	let timing: { requestStart: number; firstTokenAt: number | null; endAt: number | null } | undefined;

	pi.on("message_start", event => {
		// The message timestamp is when the request started; this event fires later.
		if (event.message.role === "assistant") {
			timing = { requestStart: event.message.timestamp, firstTokenAt: null, endAt: null };
		}
	});

	pi.on("message_update", event => {
		if (timing && timing.firstTokenAt === null && CONTENT_EVENTS[event.assistantMessageEvent.type]) {
			timing.firstTokenAt = Date.now();
		}
	});

	pi.on("message_end", event => {
		if (timing && event.message.role === "assistant") timing.endAt = Date.now();
	});

	// The assistant entry gets its id when it is persisted, which has happened by `turn_end`.
	pi.on("turn_end", (event, ctx) => {
		const measured = timing;
		timing = undefined;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!measured || measured.endAt === null || !sessionFile || !event.messageEntryId) return;
		const row = {
			sessionFile: path.resolve(sessionFile),
			entryId: event.messageEntryId,
			requestStart: measured.requestStart,
			firstTokenAt: measured.firstTokenAt,
			endAt: measured.endAt,
		};
		// Never on the agent's path: a locked or unwritable stats.db must not disturb the turn.
		state.writes = (state.writes ?? Promise.resolve())
			.then(async () => {
				const runtime = await loadRuntime();
				await runtime.initDb();
				runtime.recordRequestTiming(row);
			})
			.catch(() => {});
	});

	// Only `quit` ends the process; `new`, `resume`, `fork` and `reload` replace the session and
	// re-evaluate this module, and the dashboard must stay up across them.
	pi.on("session_shutdown", async event => {
		if (event.reason !== "quit") return;
		state.server?.stop();
		state.server = undefined;
		await state.writes;
		if (state.runtime) (await state.runtime).closeDb();
	});
}
