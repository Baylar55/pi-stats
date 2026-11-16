/**
 * Frustration dashboard: per-model share of user messages that sound annoyed,
 * annoyed at the assistant, and angry at the assistant.
 *
 * Each message is classified by its cached judge verdict when one exists:
 *   annoyed     = P(level 2) + P(level 3) ≥ 0.5 on the rubric's `annoyed` question
 *   atAssistant = annoyed && target = `assistant`
 *   angry       = atAssistant && P(level 3) ≥ 0.5
 * and otherwise by the regex signals stored at ingest (`user-metrics.ts`):
 *   annoyed     = yelling + profanity + anguish + negation + repetition + blame > 0
 *   atAssistant = negation + repetition + blame > 0
 *   angry       = atAssistant && (profanity > 0 || yelling > 0)
 * The SQL implementing both lives in `db.ts` (`FRUSTRATION_COUNTS_SQL`).
 *
 * Verdicts come from a single process-wide judge run over the unjudged prose,
 * using the judge the pi extension registered. The standalone `pi-stats` bin
 * has none and only shows the regex fallback.
 */
import { getTimeRangeConfig } from "./aggregator";
import {
	type FrustrationModelRow,
	type FrustrationVerdict,
	getFrustrationByModel,
	getFrustrationOverall,
	getPendingFrustrationProse,
	getPendingFrustrationTotals,
	initDb,
	type PendingProse,
	upsertFrustrationVerdicts,
} from "./db";
import { type JudgeCompletion, type JudgePrompt, judgeFrustration } from "./judge";
import type {
	FrustrationDashboardStats,
	FrustrationEstimate,
	FrustrationJobStatus,
	FrustrationModelStats,
} from "./shared-types";
import { logger, sleep } from "./util";

/** A model the host can judge with. Prices are USD per 1M tokens; absent when the model has no public price. */
export interface StatsJudgeModel {
	/** `provider/model`. */
	id: string;
	inputPrice?: number;
	outputPrice?: number;
}

/** Judge supplied by the pi host process: chat completions through its model registry. */
export interface StatsJudge {
	/** Models the host can judge with; the first is the default. */
	models(): StatsJudgeModel[];
	/** One chat completion. Rejects on provider error or abort. */
	complete(model: string, prompt: JudgePrompt, signal: AbortSignal): Promise<JudgeCompletion>;
}

/** Lazily resolves the host judge on first estimate/run so starting the dashboard stays fast. */
export type StatsJudgeProvider = () => Promise<StatsJudge>;

/** Per-request input-token overhead of the rubric prompt, measured by omp on jev-1.13. */
const REQUEST_OVERHEAD_TOKENS = 561;
/** Prose characters per input token, measured by omp on jev-1.13. */
const CHARS_PER_TOKEN = 5.9;
/** Output tokens a prompted chat judge bills per request. */
const OUTPUT_TOKENS_PER_REQUEST = 8;
/** Judge requests in flight at the start of a run; {@link AdaptiveLimit} tunes it from there. */
const INITIAL_CONCURRENCY = 32;
const MIN_CONCURRENCY = 4;
const MAX_CONCURRENCY = 256;
/** Wait before the second attempt at a text; doubles for the third. */
const RETRY_DELAY_MS = 250;
/** Failures within this window after a backoff don't halve the limit again. */
const BACKOFF_COOLDOWN_MS = 2_000;
/** Verdicts buffered before a write; a partial batch is written after {@link VERDICT_FLUSH_MS}. */
const VERDICT_BATCH = 64;
const VERDICT_FLUSH_MS = 500;
const ATTEMPTS_PER_TEXT = 3;
/** Stop the run when this many texts failed before any succeeded: the judge is not working. */
const CIRCUIT_BREAKER_FAILURES = 25;

const NO_PROVIDER_REASON =
	"This dashboard was started without a judge (standalone pi-stats). Run /stats inside pi to classify.";
const NO_MODEL_REASON = "No judge model is available. Select a model in pi first.";

let judgeProvider: StatsJudgeProvider | undefined;
let judgePromise: Promise<StatsJudge> | undefined;

/** Live status of the latest run; each run owns its own object so a cancelled run's stragglers can't touch a newer one. */
let currentJob: FrustrationJobStatus = {
	state: "idle",
	total: 0,
	done: 0,
	failed: 0,
	cost: 0,
	judge: null,
	error: null,
	startedAt: null,
	finishedAt: null,
	concurrency: 0,
};
let currentController: AbortController | undefined;
/** Set while a start request is resolving the judge / loading the queue, so a concurrent start gets 409. */
let starting = false;

/** Register (or replace) the host judge. */
export function setStatsJudgeProvider(provider: StatsJudgeProvider | undefined): void {
	judgeProvider = provider;
	judgePromise = undefined;
}

/** Resolve the registered judge once; a rejected resolution is forgotten so the next call retries. */
function loadJudge(provider: StatsJudgeProvider): Promise<StatsJudge> {
	if (judgePromise) return judgePromise;
	const promise = provider();
	judgePromise = promise;
	promise.catch(() => {
		if (judgePromise === promise) judgePromise = undefined;
	});
	return promise;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The requested judge model when the host offers it, else the host's default. */
function pickModel(models: readonly StatsJudgeModel[], requested?: string | null): StatsJudgeModel | undefined {
	return (requested ? models.find(model => model.id === requested) : undefined) ?? models[0];
}

/** Snapshot of the current run's progress. */
export function getFrustrationJobStatus(): FrustrationJobStatus {
	return { ...currentJob };
}

/**
 * Shape per-(model, provider) rows for the dashboard, sorted by first use.
 * omp merges provider and spelling variants by its catalog's
 * `class/family/revision` identity; pi has no such catalog, so the provider
 * is the class the page filters by and each model is its own family.
 */
export function mergeFrustrationRows(rows: readonly FrustrationModelRow[]): FrustrationModelStats[] {
	return rows
		.map(row => ({
			key: `${row.provider ?? "unknown"}/${row.model}`,
			label: row.model,
			modelClass: row.provider ?? "unknown",
			family: row.model,
			revision: null,
			models: [row.model],
			firstSeen: row.firstSeen,
			messages: row.messages,
			judged: row.judged,
			annoyed: row.annoyed,
			atAssistant: row.atAssistant,
			angry: row.angry,
		}))
		.sort((a, b) => a.firstSeen - b.firstSeen);
}

/** Payload of `GET /api/stats/frustration`. */
export async function getFrustrationDashboardStats(range?: string | null): Promise<FrustrationDashboardStats> {
	await initDb();
	const { cutoff } = getTimeRangeConfig(range);
	return {
		overall: getFrustrationOverall(cutoff),
		byModel: mergeFrustrationRows(getFrustrationByModel(cutoff)),
		judgeAvailable: judgeProvider !== undefined,
		job: getFrustrationJobStatus(),
	};
}

/** Pre-run cost quote for judging every unjudged prose text in range with `model` (default: the host's first). */
export async function estimateFrustrationRun(
	range?: string | null,
	model?: string | null,
): Promise<FrustrationEstimate> {
	if (!judgeProvider) return { available: false, reason: NO_PROVIDER_REASON };
	let judge: StatsJudge;
	try {
		judge = await loadJudge(judgeProvider);
	} catch (error) {
		return { available: false, reason: `The judge could not be loaded: ${errorMessage(error)}` };
	}
	const models = judge.models();
	const chosen = pickModel(models, model);
	if (!chosen) return { available: false, reason: NO_MODEL_REASON };
	await initDb();
	const { cutoff } = getTimeRangeConfig(range);
	const { messages, chars } = getPendingFrustrationTotals(cutoff);
	const inputTokens = messages * REQUEST_OVERHEAD_TOKENS + Math.ceil(chars / CHARS_PER_TOKEN);
	// A model without a public price (subscription, local) has no dollar estimate, not a free one.
	const cost =
		chosen.inputPrice === undefined || chosen.outputPrice === undefined
			? null
			: (inputTokens * chosen.inputPrice) / 1e6 + (messages * OUTPUT_TOKENS_PER_REQUEST * chosen.outputPrice) / 1e6;
	return {
		available: true,
		messages,
		chars,
		inputTokens,
		cost,
		judge: chosen.id,
		models: models.map(candidate => candidate.id),
	};
}

/** Outcome of {@link startFrustrationRun}: the new job, or the HTTP status and reason it was refused. */
export type StartFrustrationRunResult =
	| {
			started: true;
			job: FrustrationJobStatus;
			/** Settles once every worker has stopped (done, cancelled, or failed); never rejects. */
			finished: Promise<void>;
	  }
	| { started: false; status: 409 | 503; error: string };

/**
 * Start the process-wide judge run over the unique unjudged prose in range.
 * Returns immediately after queueing; progress is read via {@link getFrustrationJobStatus}.
 * This is the only place the judge is ever invoked.
 */
export async function startFrustrationRun(
	range?: string | null,
	model?: string | null,
): Promise<StartFrustrationRunResult> {
	if (starting || currentJob.state === "running") {
		return { started: false, status: 409, error: "A frustration judge run is already in progress." };
	}
	const provider = judgeProvider;
	if (!provider) return { started: false, status: 503, error: NO_PROVIDER_REASON };
	starting = true;
	try {
		let judge: StatsJudge;
		try {
			judge = await loadJudge(provider);
		} catch (error) {
			return { started: false, status: 503, error: `The judge could not be loaded: ${errorMessage(error)}` };
		}
		const chosen = pickModel(judge.models(), model);
		if (!chosen) return { started: false, status: 503, error: NO_MODEL_REASON };
		await initDb();
		const { cutoff } = getTimeRangeConfig(range);
		const pending = shuffle(getPendingFrustrationProse(cutoff));
		const now = Date.now();
		const job: FrustrationJobStatus = {
			state: pending.length > 0 ? "running" : "done",
			total: pending.length,
			done: 0,
			failed: 0,
			cost: 0,
			judge: chosen.id,
			error: null,
			startedAt: now,
			finishedAt: pending.length > 0 ? null : now,
			concurrency: 0,
		};
		currentJob = job;
		if (pending.length === 0) return { started: true, job: { ...job }, finished: Promise.resolve() };
		const controller = new AbortController();
		currentController = controller;
		const finished = runJob(job, judge, chosen.id, pending, controller);
		return { started: true, job: { ...job }, finished };
	} finally {
		starting = false;
	}
}

/** Abort the active run; in-flight judge requests are cancelled and no new text is taken. */
export function cancelFrustrationRun(): FrustrationJobStatus {
	if (currentJob.state === "running") {
		currentController?.abort(new Error("frustration run cancelled"));
		currentJob.state = "cancelled";
		currentJob.finishedAt = Date.now();
	}
	return getFrustrationJobStatus();
}

/** Fisher–Yates: a random order makes every model's rates converge evenly while verdicts stream in. */
function shuffle<T>(items: T[]): T[] {
	for (let i = items.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[items[i], items[j]] = [items[j], items[i]];
	}
	return items;
}

/**
 * In-flight limit for judge requests, adapted like TCP congestion control:
 * it grows by one per success until the first failure (slow start), then by
 * about four per window of successes, and halves on failure — at most once
 * per {@link BACKOFF_COOLDOWN_MS}, so one burst of rate-limit errors from the
 * same window counts once. Judges are latency-bound (a call takes ~1s whatever
 * the model speed), so throughput scales with how many calls are in flight.
 */
class AdaptiveLimit {
	#limit = INITIAL_CONCURRENCY;
	#slowStart = true;
	#lastBackoff = 0;

	get value(): number {
		return Math.floor(this.#limit);
	}

	succeeded(): void {
		this.#limit = Math.min(MAX_CONCURRENCY, this.#limit + (this.#slowStart ? 1 : 4 / this.#limit));
	}

	failed(): void {
		this.#slowStart = false;
		const now = Date.now();
		if (now - this.#lastBackoff < BACKOFF_COOLDOWN_MS) return;
		this.#lastBackoff = now;
		this.#limit = Math.max(MIN_CONCURRENCY, this.#limit / 2);
	}
}

async function runJob(
	job: FrustrationJobStatus,
	judge: StatsJudge,
	model: string,
	queue: readonly PendingProse[],
	controller: AbortController,
): Promise<void> {
	const { signal } = controller;
	const limit = new AdaptiveLimit();
	let next = 0;
	let inFlight = 0;
	let lastError: string | null = null;
	let tripped = false;

	// Verdicts are written in batches: one transaction per flush instead of one per text.
	let buffered: FrustrationVerdict[] = [];
	let flushTimer: NodeJS.Timeout | undefined;
	const flush = () => {
		clearTimeout(flushTimer);
		flushTimer = undefined;
		const batch = buffered;
		buffered = [];
		upsertFrustrationVerdicts(batch);
	};
	const crash = (error: unknown) => {
		if (tripped) return;
		// Only non-judge failures (e.g. a SQLite write) reach here.
		tripped = true;
		lastError = errorMessage(error);
		logger.error("frustration judge run crashed", { error: lastError });
		controller.abort(error);
	};
	const record = (verdict: FrustrationVerdict) => {
		buffered.push(verdict);
		if (buffered.length >= VERDICT_BATCH) {
			flush();
		} else if (!flushTimer) {
			flushTimer = setTimeout(() => {
				try {
					flush();
				} catch (error) {
					crash(error);
				}
			}, VERDICT_FLUSH_MS);
			// A pending flush must not hold the host process open.
			flushTimer.unref();
		}
	};

	const judgeText = async (item: PendingProse): Promise<void> => {
		for (let attempt = 1; attempt <= ATTEMPTS_PER_TEXT; attempt++) {
			if (signal.aborted) return;
			// Failures are mostly rate limits: give the judge a moment before retrying.
			if (attempt > 1) await sleep(RETRY_DELAY_MS * (attempt - 1));
			if (signal.aborted) return;
			try {
				const answer = await judgeFrustration(prompt => judge.complete(model, prompt, signal), item.prose);
				limit.succeeded();
				// A prompted judge answers with one level, so the probabilities are one-hot.
				const pAngry = answer.annoyed === 3 ? 1 : 0;
				record({
					proseHash: item.hash,
					pAnnoyed: answer.annoyed >= 2 ? 1 : 0,
					pAngry,
					target: answer.target,
					judge: model,
					judgedAt: Date.now(),
				});
				job.done++;
				job.cost += answer.cost;
				return;
			} catch (error) {
				if (signal.aborted) return;
				limit.failed();
				lastError = errorMessage(error);
				logger.warn("frustration judge attempt failed", { hash: item.hash, attempt, error: lastError });
			}
		}
		job.failed++;
		if (job.failed >= CIRCUIT_BREAKER_FAILURES && job.done === 0 && !tripped) {
			tripped = true;
			logger.error("frustration judge run stopped: no text succeeded", { failed: job.failed, error: lastError });
			controller.abort(new Error("frustration judge circuit breaker tripped"));
		}
	};

	// Keep `limit.value` requests in flight; every completion refills the pool.
	const { promise: drained, resolve } = Promise.withResolvers<void>();
	const pump = () => {
		while (!signal.aborted && inFlight < limit.value && next < queue.length) {
			const item = queue[next++];
			inFlight++;
			judgeText(item)
				.catch(crash)
				.finally(() => {
					inFlight--;
					pump();
				});
		}
		job.concurrency = limit.value;
		if (inFlight === 0 && (signal.aborted || next >= queue.length)) resolve();
	};
	pump();
	await drained;

	// Verdicts already paid for are kept, even when the run was cancelled.
	try {
		flush();
	} catch (error) {
		crash(error);
	}
	if (tripped) {
		job.state = "failed";
		job.error = lastError;
	} else if (job.state === "running") {
		job.state = "done";
	}
	job.finishedAt ??= Date.now();
	if (currentController === controller) currentController = undefined;
}
