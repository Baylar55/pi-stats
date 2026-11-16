import { afterEach, describe, expect, it } from "vitest";
import { initDb, insertUserMessageStats, upsertFrustrationVerdicts } from "../src/db";
import {
	cancelFrustrationRun,
	estimateFrustrationRun,
	getFrustrationDashboardStats,
	getFrustrationJobStatus,
	type StatsJudge,
	type StatsJudgeModel,
	setStatsJudgeProvider,
	startFrustrationRun,
} from "../src/frustration";
import { type JudgeCompletion, type JudgePrompt, parseFrustrationReply, renderFrustrationPrompt } from "../src/judge";
import type { UserMessageStats } from "../src/types";
import { hashHex, sleep } from "../src/util";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-frustration-");

afterEach(() => {
	setStatsJudgeProvider(undefined);
});

type Signals = Partial<
	Pick<UserMessageStats, "yelling" | "profanity" | "anguish" | "negation" | "repetition" | "blame">
>;

let entrySeq = 0;

function hashOf(prose: string): string {
	return prose ? hashHex(prose) : "";
}

function userMessage(
	prose: string,
	model: string | null,
	provider: string | null,
	signals: Signals = {},
	timestamp = Date.now(),
): UserMessageStats {
	return {
		sessionFile: "/tmp/frustration.jsonl",
		entryId: `user-${++entrySeq}`,
		folder: "/tmp/project",
		timestamp,
		model,
		provider,
		chars: prose.length,
		words: prose.split(/\s+/).length,
		yelling: 0,
		profanity: 0,
		anguish: 0,
		negation: 0,
		repetition: 0,
		blame: 0,
		...signals,
		prose,
		proseHash: hashOf(prose),
	};
}

function verdict(prose: string, pAnnoyed: number, pAngry: number, target: string): void {
	upsertFrustrationVerdicts([
		{ proseHash: hashOf(prose), pAnnoyed, pAngry, target, judge: "test/judge", judgedAt: Date.now() },
	]);
}

/** Judge answering every text "angry at the assistant"; `gate` holds requests until released or aborted. */
class FakeJudge implements StatsJudge {
	readonly states: string[] = [];
	readonly modelsUsed = new Set<string>();
	readonly #entered = Promise.withResolvers<void>();
	/** Resolves when the first judgment starts. */
	readonly entered = this.#entered.promise;
	gate: Promise<void> | undefined;
	/** Reject calls beyond this many concurrent ones, as a rate-limited judge would. */
	capacity = Number.POSITIVE_INFINITY;
	delayMs = 0;
	inFlight = 0;
	maxInFlight = 0;
	/** Replies handed out before the well-formed one. */
	garbage: string[] = [];

	models(): StatsJudgeModel[] {
		return [{ id: "openai/gpt-x", inputPrice: 1, outputPrice: 2 }, { id: "sub/free-model" }];
	}

	async complete(model: string, prompt: JudgePrompt, signal: AbortSignal): Promise<JudgeCompletion> {
		this.modelsUsed.add(model);
		const state = /<state>\n([\s\S]*)\n<\/state>/.exec(prompt.user)?.[1];
		if (state !== undefined) this.states.push(state);
		this.#entered.resolve();
		this.inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		try {
			if (this.inFlight > this.capacity) throw new Error("429 rate limited");
			if (this.delayMs) await sleep(this.delayMs);
		} finally {
			this.inFlight--;
		}
		if (this.gate) {
			await Promise.race([
				this.gate,
				new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
			]);
		}
		const garbage = this.garbage.shift();
		return { text: garbage ?? "annoyed: 3\ntarget: assistant", cost: 0.001 };
	}
}

describe("frustration dashboard", () => {
	it("classifies by cached verdict first and by regex signals otherwise", async () => {
		await initDb();
		insertUserMessageStats([
			// Regex says at-assistant, the verdict says neutral: the verdict wins.
			userMessage("no, stop doing that", "gpt-x", "openai", { negation: 1 }),
			// Regex: yelling + blame → annoyed, at assistant, angry.
			userMessage("WHY DID YOU DELETE IT", "gpt-x", "openai", { yelling: 1, blame: 1 }),
			// Regex: anguish alone → annoyed, not at the assistant.
			userMessage("ugh this build tool", "gpt-x", "openai", { anguish: 1 }),
			// Regex: profanity without negation/repetition/blame is not aimed at the assistant.
			userMessage("damn flaky ci", "gpt-x", "openai", { profanity: 1 }),
			// Verdict: annoyed at something else, even though it sounds hostile.
			userMessage("the library is broken", "gpt-x", "openai"),
			// Verdict: annoyed at the assistant but not angry.
			userMessage("you missed the file again", "gpt-x", "openai"),
			// No prose (markup only): excluded everywhere.
			userMessage("", "gpt-x", "openai", { yelling: 1 }),
			// Never answered: overall only.
			userMessage("HELLO??? ANYONE", null, null, { yelling: 1 }),
		]);
		verdict("no, stop doing that", 0.1, 0, "none");
		verdict("the library is broken", 0.9, 0.6, "other");
		verdict("you missed the file again", 0.7, 0.2, "assistant");

		const stats = await getFrustrationDashboardStats("all");

		expect(stats.overall).toEqual({ messages: 7, judged: 3, annoyed: 6, atAssistant: 2, angry: 1 });
		expect(stats.byModel).toHaveLength(1);
		expect(stats.byModel[0]).toMatchObject({
			label: "gpt-x",
			messages: 6,
			judged: 3,
			annoyed: 5,
			atAssistant: 2,
			angry: 1,
		});
		expect(stats.judgeAvailable).toBe(false);
	});

	it("keeps one row per provider and model, ordered by first use", async () => {
		await initDb();
		const t = Date.now() - 60_000;
		insertUserMessageStats([
			userMessage("a", "weird-model", "custom", {}, t),
			userMessage("b", "gpt-x", "openai", {}, t + 1),
			userMessage("c", "gpt-x", "openai-codex", {}, t + 2),
		]);

		const { byModel } = await getFrustrationDashboardStats("all");

		expect(byModel.map(row => [row.key, row.messages, row.firstSeen])).toEqual([
			["custom/weird-model", 1, t],
			["openai/gpt-x", 1, t + 1],
			["openai-codex/gpt-x", 1, t + 2],
		]);
		expect(byModel[1]).toMatchObject({ label: "gpt-x", modelClass: "openai", family: "gpt-x", revision: null });
	});

	it("quotes and runs the judge once per unique unjudged prose, streaming verdicts into the dashboard", async () => {
		await initDb();
		const repeated = "why did you do that again";
		const single = "please rename it";
		const judged = "already judged text";
		insertUserMessageStats([
			userMessage(repeated, "gpt-x", "openai"),
			userMessage(repeated, "gpt-x", "openai"),
			userMessage(single, "gpt-x", "openai"),
			userMessage(judged, "gpt-x", "openai"),
		]);
		verdict(judged, 0, 0, "none");
		const judge = new FakeJudge();
		setStatsJudgeProvider(async () => judge);

		const estimate = await estimateFrustrationRun("all");
		const chars = repeated.length + single.length;
		const inputTokens = 2 * 561 + Math.ceil(chars / 5.9);
		expect(estimate).toEqual({
			available: true,
			messages: 2,
			chars,
			inputTokens,
			cost: (inputTokens * 1) / 1e6 + (2 * 8 * 2) / 1e6,
			judge: "openai/gpt-x",
			models: ["openai/gpt-x", "sub/free-model"],
		});
		// Asking for a quote never calls the model.
		expect(judge.states).toEqual([]);

		const started = await startFrustrationRun("all");
		if (!started.started) throw new Error(started.error);
		await started.finished;

		expect(judge.states.toSorted()).toEqual([single, repeated].toSorted());
		expect(getFrustrationJobStatus()).toMatchObject({
			state: "done",
			total: 2,
			done: 2,
			failed: 0,
			cost: 0.002,
			judge: "openai/gpt-x",
		});
		const stats = await getFrustrationDashboardStats("all");
		expect(stats.overall).toEqual({ messages: 4, judged: 4, annoyed: 3, atAssistant: 3, angry: 3 });
		expect(stats.judgeAvailable).toBe(true);
		expect(await estimateFrustrationRun("all")).toMatchObject({ available: true, messages: 0 });
	});

	it("judges with the model picked in the dashboard and quotes no price for an unpriced one", async () => {
		await initDb();
		insertUserMessageStats([userMessage("stop it", "gpt-x", "openai")]);
		const judge = new FakeJudge();
		setStatsJudgeProvider(async () => judge);

		expect(await estimateFrustrationRun("all", "sub/free-model")).toMatchObject({ judge: "sub/free-model", cost: null });
		// An id the host does not offer falls back to its default.
		expect(await estimateFrustrationRun("all", "nope/nope")).toMatchObject({ judge: "openai/gpt-x" });

		const started = await startFrustrationRun("all", "sub/free-model");
		if (!started.started) throw new Error(started.error);
		await started.finished;

		expect([...judge.modelsUsed]).toEqual(["sub/free-model"]);
		expect(getFrustrationJobStatus()).toMatchObject({ state: "done", judge: "sub/free-model" });
	});

	it("re-asks when a reply does not parse", async () => {
		await initDb();
		insertUserMessageStats([userMessage("why is it broken again", "gpt-x", "openai")]);
		const judge = new FakeJudge();
		judge.garbage = ["I think the user is rather upset."];
		setStatsJudgeProvider(async () => judge);

		const started = await startFrustrationRun("all");
		if (!started.started) throw new Error(started.error);
		await started.finished;

		expect(judge.states).toHaveLength(2);
		expect(getFrustrationJobStatus()).toMatchObject({ state: "done", done: 1, failed: 0, cost: 0.002 });
	});

	it("refuses a second run while one is active and cancels in-flight judgments", async () => {
		await initDb();
		insertUserMessageStats([userMessage("stop it", "gpt-x", "openai")]);
		const judge = new FakeJudge();
		const { promise: gate } = Promise.withResolvers<void>();
		judge.gate = gate;
		setStatsJudgeProvider(async () => judge);

		const started = await startFrustrationRun("all");
		if (!started.started) throw new Error(started.error);
		expect(await startFrustrationRun("all")).toMatchObject({ started: false, status: 409 });
		await judge.entered;

		expect(cancelFrustrationRun().state).toBe("cancelled");
		await started.finished;

		expect(judge.states).toHaveLength(1);
		expect(getFrustrationJobStatus()).toMatchObject({ state: "cancelled", done: 0 });
		expect((await getFrustrationDashboardStats("all")).overall.judged).toBe(0);
	});

	it("raises concurrency past its starting point, rides out rate limits, and persists every verdict", async () => {
		await initDb();
		const texts = Array.from({ length: 400 }, (_, i) => `text number ${i}`);
		insertUserMessageStats(texts.map(text => userMessage(text, "gpt-x", "openai")));
		const judge = new FakeJudge();
		judge.delayMs = 5;
		judge.capacity = 64;
		setStatsJudgeProvider(async () => judge);

		const started = await startFrustrationRun("all");
		if (!started.started) throw new Error(started.error);
		await started.finished;

		expect(getFrustrationJobStatus()).toMatchObject({ state: "done", total: 400, done: 400, failed: 0 });
		// The run starts at 32 in flight; a latency-bound judge should be driven harder.
		expect(judge.maxInFlight).toBeGreaterThan(32);
		expect((await getFrustrationDashboardStats("all")).overall.judged).toBe(400);
	});

	it("reports why a run is unavailable without a host judge", async () => {
		const estimate = await estimateFrustrationRun("all");
		expect(estimate).toMatchObject({ available: false });
		// The standalone bin has no judge; the page shows this reason.
		expect(estimate.available ? "" : estimate.reason).toContain("standalone pi-stats");
		expect(await startFrustrationRun("all")).toMatchObject({ started: false, status: 503 });
	});
});

describe("judge reply parsing", () => {
	it("reads one answer line per question, tolerant of formatting noise", () => {
		expect(parseFrustrationReply("annoyed: 2\ntarget: assistant")).toEqual({ annoyed: 2, target: "assistant" });
		expect(parseFrustrationReply("Sure!\n- `annoyed` = level 1.\n* target - other (the build tool)")).toEqual({
			annoyed: 1,
			target: "other",
		});
		expect(parseFrustrationReply("annoyed: 0\ntarget: none")).toEqual({ annoyed: 0, target: "none" });
	});

	it("rejects replies missing an answer or naming no valid level", () => {
		expect(parseFrustrationReply("annoyed: 2")).toBeUndefined();
		expect(parseFrustrationReply("annoyed: 7\ntarget: assistant")).toBeUndefined();
		expect(parseFrustrationReply("annoyed: very\ntarget: assistant")).toBeUndefined();
		expect(parseFrustrationReply("annoyed: 1.5\ntarget: nobody")).toBeUndefined();
	});

	it("keeps the rubric in the system prompt and the text in the user prompt", () => {
		const prompt = renderFrustrationPrompt("why did you do that");
		expect(prompt.system).toContain("Question `annoyed`");
		expect(prompt.system).toContain("- `3`: angry, hostile, or swearing");
		expect(prompt.system).toContain("Answer with exactly one of: `assistant`, `other`, `none`.");
		expect(prompt.system).not.toContain("why did you do that");
		expect(prompt.user).toContain("<state>\nwhy did you do that\n</state>");
		expect(renderFrustrationPrompt("x", true).system).toContain("Classification retry");
	});
});
