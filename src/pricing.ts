/**
 * The rate card behind every API-equivalent cost estimate.
 *
 * omp prices usage from its bundled model catalog; pi-stats has no catalog of
 * its own. The extension hands over pi's model registry through
 * {@link setModelPrices} and it is persisted in `model_prices`, so every
 * process sharing the database prices identically. The bin seeds pi-ai's
 * built-in catalog only into an empty table: it lacks `models.json` and
 * extension providers, and must not overwrite the extension's fuller card.
 * That table is the only rate card.
 *
 * Costs follow pi-ai's `calculateCost`: context tiers are selected by the
 * prompt size (`input + cacheRead + cacheWrite`) and 1-hour cache writes cost
 * twice the input rate.
 */
import { currentDb } from "./db";
import type { Database } from "./sqlite";

/** One model's price in USD per 1M tokens (pi-ai's `ModelCost`). */
export interface ModelPrice {
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
}

type PriceTier = NonNullable<ModelPrice["tiers"]>[number];

interface TokenRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/** The rates that price one model's usage: its own card, or its pricing peer's. */
export interface ModelRates extends TokenRates {
	tiers: readonly PriceTier[];
}

/** Token counters a cost is derived from; `cacheWrite1h` is the 1-hour subset of `cacheWrite`. */
export interface PricedTokens {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
}

export interface UsageCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/** Cost of usage whose transcript recorded no price. */
export interface EstimatedCost {
	cost: UsageCost;
	/**
	 * No provider has a public price for the model, so the zero is unknown
	 * spend rather than a price. Persisted as `cost_unpriced` so the aggregates
	 * do not have to infer it.
	 */
	unpriced: boolean;
	/** The cost comes from the rate card, so a later rate card may replace it. */
	estimated: boolean;
}

const ZERO_USAGE_COST: UsageCost = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	total: 0,
};

interface PriceRow {
	provider: string;
	model: string;
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	/** JSON `PriceTier[]`, NULL for a flat card. */
	tiers: string | null;
}

const PRICE_COLUMNS = "provider, model, input, output, cache_read, cache_write, tiers";

/**
 * The card that prices `provider/model`: its own when it charges anything,
 * else the same model id under another provider that does. A subscription or
 * OAuth provider lists its models at zero; that peer is the public API price
 * of the same model. Peers are tried in provider order so the choice is stable.
 * ponytail: when two providers list the same id at different prices (a reseller
 * markup), the alphabetically first wins; omp uses an explicit peer table.
 */
const FIND_PRICE_SQL = `
	SELECT ${PRICE_COLUMNS} FROM model_prices
	WHERE model = $model AND (input <> 0 OR output <> 0 OR cache_read <> 0 OR cache_write <> 0)
	ORDER BY provider = $provider DESC, provider
	LIMIT 1`;

function findPriceRow(database: Database, provider: string, model: string): PriceRow | null {
	return database.query<PriceRow>(FIND_PRICE_SQL).get({ $model: model, $provider: provider });
}

function toRates(row: PriceRow): ModelRates {
	const tiers: PriceTier[] = row.tiers ? JSON.parse(row.tiers) : [];
	return { input: row.input, output: row.output, cacheRead: row.cache_read, cacheWrite: row.cache_write, tiers };
}

function samePrice(a: PriceRow | null, b: PriceRow | null): boolean {
	if (!a || !b) return a === b;
	return (
		a.input === b.input &&
		a.output === b.output &&
		a.cache_read === b.cache_read &&
		a.cache_write === b.cache_write &&
		a.tiers === b.tiers
	);
}

/** Whether `provider/model` can be priced: it, or a pricing peer, has a non-zero price. False before `initDb`. */
export function hasModelPrice(provider: string, model: string): boolean {
	const database = currentDb();
	return database !== null && findPriceRow(database, provider, model) !== null;
}

/** Whether any rate card is stored. False before `initDb`. */
export function hasStoredPrices(): boolean {
	return Boolean(currentDb()?.query("SELECT 1 FROM model_prices LIMIT 1").get());
}

/**
 * Rate lookup for one ingest batch. A batch repeats a handful of models, so
 * each is resolved once; nothing outlives the batch, so a rate card another
 * process stored is picked up by the next one.
 */
export function createRateLookup(database: Database): (provider: string, model: string) => ModelRates | null {
	const byProvider = new Map<string, Map<string, ModelRates | null>>();
	return (provider, model) => {
		let byModel = byProvider.get(provider);
		if (!byModel) {
			byModel = new Map();
			byProvider.set(provider, byModel);
		}
		let rates = byModel.get(model);
		if (rates === undefined) {
			const row = findPriceRow(database, provider, model);
			rates = row ? toRates(row) : null;
			byModel.set(model, rates);
		}
		return rates;
	};
}

/** The rates in force for a prompt of `promptTokens`: the highest tier it exceeds, else the base card. */
function ratesFor(rates: ModelRates, promptTokens: number): TokenRates {
	let selected: TokenRates = rates;
	let matchedThreshold = -1;
	for (const tier of rates.tiers) {
		if (promptTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			selected = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}
	return selected;
}

/**
 * Price usage that recorded no cost. Without rates the usage is unpriced,
 * unless it used no tokens at all: that request is free.
 */
export function estimateCost(rates: ModelRates | null, tokens: PricedTokens, totalTokens: number): EstimatedCost {
	if (!rates) return { cost: ZERO_USAGE_COST, unpriced: totalTokens > 0, estimated: false };
	const tier = ratesFor(rates, tokens.input + tokens.cacheRead + tokens.cacheWrite);
	// Anthropic charges 2x base input for 1h cache writes.
	const longWrite = tokens.cacheWrite1h ?? 0;
	const shortWrite = tokens.cacheWrite - longWrite;
	const input = (tier.input / 1_000_000) * tokens.input;
	const output = (tier.output / 1_000_000) * tokens.output;
	const cacheRead = (tier.cacheRead / 1_000_000) * tokens.cacheRead;
	const cacheWrite = (tier.cacheWrite * shortWrite + tier.input * 2 * longWrite) / 1_000_000;
	return {
		cost: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
		unpriced: false,
		estimated: true,
	};
}

/** What the whole prompt would cost with no cache at all; 0 when the model has no price. */
export function uncachedInputCost(rates: ModelRates | null, tokens: PricedTokens): number {
	if (!rates) return 0;
	const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	return (ratesFor(rates, prompt).input / 1_000_000) * prompt;
}

/** `node:sqlite` binds NaN as NULL, which the NOT NULL price columns reject. */
function finiteRate(value: number): number {
	return Number.isFinite(value) ? value : 0;
}

function toPriceRow(price: ModelPrice): PriceRow {
	return {
		provider: price.provider,
		model: price.model,
		input: finiteRate(price.input),
		output: finiteRate(price.output),
		cache_read: finiteRate(price.cacheRead),
		cache_write: finiteRate(price.cacheWrite),
		tiers:
			price.tiers && price.tiers.length > 0
				? JSON.stringify(
						price.tiers.map(
							(tier): PriceTier => ({
								inputTokensAbove: finiteRate(tier.inputTokensAbove),
								input: finiteRate(tier.input),
								output: finiteRate(tier.output),
								cacheRead: finiteRate(tier.cacheRead),
								cacheWrite: finiteRate(tier.cacheWrite),
							}),
						),
					)
				: null,
	};
}

function priceKey(provider: string, model: string): string {
	return `${model}\0${provider}`;
}

/** Model ids whose stored cards differ from `next` (added, removed or changed under any provider). */
function changedModels(database: Database, next: ReadonlyMap<string, PriceRow>): Set<string> {
	const changed = new Set<string>();
	const stored = new Set<string>();
	for (const row of database.query<PriceRow>(`SELECT ${PRICE_COLUMNS} FROM model_prices`).all()) {
		const key = priceKey(row.provider, row.model);
		stored.add(key);
		const replacement = next.get(key);
		if (!replacement || !samePrice(row, replacement)) changed.add(row.model);
	}
	for (const [key, row] of next) {
		if (!stored.has(key)) changed.add(row.model);
	}
	return changed;
}

/** Stored rows re-priced per statement, so a busy model never loads its whole history at once. */
const REPRICE_PAGE = 4096;

interface RepriceRow extends Required<PricedTokens> {
	id: number;
	totalTokens: number;
	costTotal: number;
	estimated: number;
}

/**
 * Bring one model's stored rows to what ingest would store under `rates`. A
 * recorded cost is what the request was billed and never changes; only its
 * uncached-prompt reference, always an estimate, follows the card.
 */
function repriceMessages(database: Database, provider: string, model: string, rates: ModelRates | null): void {
	const page = database.query<RepriceRow>(`
		SELECT id, input_tokens AS input, output_tokens AS output, cache_read_tokens AS cacheRead,
			cache_write_tokens AS cacheWrite, cache_write_1h_tokens AS cacheWrite1h, total_tokens AS totalTokens,
			cost_total AS costTotal, cost_estimated AS estimated
		FROM messages WHERE model = ? AND provider = ? AND id > ? ORDER BY id LIMIT ${REPRICE_PAGE}
	`);
	const setEstimate = database.query(`
		UPDATE messages
		SET cost_input = ?, cost_output = ?, cost_cache_read = ?, cost_cache_write = ?, cost_total = ?,
			cost_no_cache_input = ?, cost_unpriced = ?, cost_estimated = ?
		WHERE id = ?
	`);
	const setNoCacheInput = database.query("UPDATE messages SET cost_no_cache_input = ? WHERE id = ?");
	let after = 0;
	for (;;) {
		const rows = page.all(model, provider, after);
		for (const row of rows) {
			const noCacheInput = uncachedInputCost(rates, row);
			if (row.costTotal > 0 && row.estimated === 0) {
				setNoCacheInput.run(noCacheInput, row.id);
				continue;
			}
			const { cost, unpriced, estimated } = estimateCost(rates, row, row.totalTokens);
			setEstimate.run(
				cost.input,
				cost.output,
				cost.cacheRead,
				cost.cacheWrite,
				cost.total,
				noCacheInput,
				unpriced ? 1 : 0,
				estimated ? 1 : 0,
				row.id,
			);
		}
		if (rows.length < REPRICE_PAGE) return;
		after = rows[rows.length - 1].id;
	}
}

/**
 * Replace the persisted rate card with `prices` and re-price the stored rows
 * it changes: requests that were unpriced or estimated under the old card end
 * up exactly as a fresh ingest would store them. An unchanged card writes
 * nothing, so calling this on every start is free. No-op before `initDb`.
 */
export function setModelPrices(prices: readonly ModelPrice[]): void {
	const database = currentDb();
	if (!database) return;
	const next = new Map<string, PriceRow>();
	for (const price of prices) next.set(priceKey(price.provider, price.model), toPriceRow(price));
	// Steady state stays read-only; the transaction below decides again under the write lock.
	if (changedModels(database, next).size === 0) return;

	database
		.transaction(() => {
			const changed = changedModels(database, next);
			if (changed.size === 0) return;
			// A changed card can move the price of every provider serving that model id (it may be
			// their pricing peer), so compare what each stored (provider, model) resolves to.
			const providersOf = database.query<{ provider: string }>(
				"SELECT DISTINCT provider FROM messages WHERE model = ?",
			);
			const stale: { provider: string; model: string; before: PriceRow | null }[] = [];
			for (const model of changed) {
				for (const { provider } of providersOf.all(model)) {
					stale.push({ provider, model, before: findPriceRow(database, provider, model) });
				}
			}

			database.run("DELETE FROM model_prices");
			const insert = database.query(`INSERT INTO model_prices (${PRICE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`);
			for (const row of next.values()) {
				insert.run(row.provider, row.model, row.input, row.output, row.cache_read, row.cache_write, row.tiers);
			}

			for (const { provider, model, before } of stale) {
				const after = findPriceRow(database, provider, model);
				if (samePrice(before, after)) continue;
				repriceMessages(database, provider, model, after ? toRates(after) : null);
			}
		})
		.immediate();
}
