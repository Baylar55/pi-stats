/**
 * The one place that knows which SQLite the process has. The stats code is
 * written against `bun:sqlite`'s `Database` surface (as in omp); under Bun the
 * real class is used, under Node this adapter provides the same surface over
 * `node:sqlite`'s `DatabaseSync` (Node >= 22.13).
 */
import { createRequire } from "node:module";
import type * as NodeSqlite from "node:sqlite";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

export interface RunResult {
	changes: number;
	lastInsertRowid: number;
}

export interface Statement<Row = unknown> {
	/** First row, or `null` when the query yields none. */
	get(...params: unknown[]): Row | null;
	all(...params: unknown[]): Row[];
	/** Rows as value arrays in column order. */
	values(...params: unknown[]): unknown[][];
	run(...params: unknown[]): RunResult;
}

/** A function wrapped by {@link Database.transaction}; nested calls become savepoints. */
export interface Transaction<A extends unknown[], R> {
	(...args: A): R;
	deferred(...args: A): R;
	immediate(...args: A): R;
	exclusive(...args: A): R;
}

export interface Database {
	/** Prepared statement cached by SQL text. */
	query<Row = unknown, _Params = unknown>(sql: string): Statement<Row>;
	/** Prepared statement, not cached. */
	prepare<Row = unknown, _Params = unknown>(sql: string): Statement<Row>;
	/** Execute SQL; with no parameters it may hold several statements. */
	run(sql: string, ...params: unknown[]): RunResult;
	exec(sql: string): void;
	transaction<A extends unknown[], R>(fn: (...args: A) => R): Transaction<A, R>;
	readonly inTransaction: boolean;
	close(): void;
}

export interface DatabaseOptions {
	readonly?: boolean;
}

/**
 * `node:sqlite` binds neither `undefined` nor booleans, and takes positional
 * parameters spread; `bun:sqlite` accepts all of those plus a single array.
 */
function bindings(params: unknown[]): SQLInputValue[] | [Record<string, SQLInputValue>] {
	const list = params.length === 1 && Array.isArray(params[0]) ? (params[0] as unknown[]) : params;
	if (list.length === 1) {
		const only = list[0];
		if (only !== null && typeof only === "object" && !ArrayBuffer.isView(only)) {
			const named: Record<string, SQLInputValue> = {};
			for (const [key, value] of Object.entries(only)) named[key] = bindValue(value);
			return [named];
		}
	}
	return list.map(bindValue);
}

function bindValue(value: unknown): SQLInputValue {
	if (value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	return value as SQLInputValue;
}

class NodeStatement<Row> implements Statement<Row> {
	readonly #stmt: StatementSync;

	constructor(stmt: StatementSync) {
		this.#stmt = stmt;
		// bun:sqlite ignores named parameters a statement does not use.
		stmt.setAllowUnknownNamedParameters?.(true);
	}

	get(...params: unknown[]): Row | null {
		return (this.#stmt.get(...(bindings(params) as SQLInputValue[])) as Row | undefined) ?? null;
	}

	all(...params: unknown[]): Row[] {
		return this.#stmt.all(...(bindings(params) as SQLInputValue[])) as Row[];
	}

	values(...params: unknown[]): unknown[][] {
		this.#stmt.setReturnArrays(true);
		try {
			return this.#stmt.all(...(bindings(params) as SQLInputValue[])) as unknown as unknown[][];
		} finally {
			this.#stmt.setReturnArrays(false);
		}
	}

	run(...params: unknown[]): RunResult {
		const result = this.#stmt.run(...(bindings(params) as SQLInputValue[]));
		return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
	}
}

class NodeDatabase implements Database {
	readonly #db: DatabaseSync;
	readonly #cache = new Map<string, NodeStatement<unknown>>();
	#savepoint = 0;

	constructor(filename: string, options: DatabaseOptions = {}) {
		// `require` is untyped; the annotation names the module it loads.
		const sqlite: typeof NodeSqlite = createRequire(import.meta.url)("node:sqlite");
		this.#db = new sqlite.DatabaseSync(filename, { readOnly: options.readonly === true });
	}

	query<Row = unknown>(sql: string): Statement<Row> {
		let stmt = this.#cache.get(sql);
		if (!stmt) {
			stmt = new NodeStatement(this.#db.prepare(sql));
			this.#cache.set(sql, stmt);
		}
		return stmt as NodeStatement<Row>;
	}

	prepare<Row = unknown>(sql: string): Statement<Row> {
		return new NodeStatement<Row>(this.#db.prepare(sql));
	}

	run(sql: string, ...params: unknown[]): RunResult {
		if (params.length === 0) {
			this.#db.exec(sql);
			return { changes: 0, lastInsertRowid: 0 };
		}
		return this.prepare(sql).run(...params);
	}

	exec(sql: string): void {
		this.#db.exec(sql);
	}

	get inTransaction(): boolean {
		return this.#db.isTransaction;
	}

	transaction<A extends unknown[], R>(fn: (...args: A) => R): Transaction<A, R> {
		const wrap =
			(begin: string) =>
			(...args: A): R => {
				const nested = this.#db.isTransaction;
				const savepoint = nested ? `sp_${++this.#savepoint}` : "";
				this.#db.exec(nested ? `SAVEPOINT ${savepoint}` : begin);
				try {
					const result = fn(...args);
					this.#db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
					return result;
				} catch (err) {
					// A failed COMMIT may already have ended the transaction.
					if (this.#db.isTransaction) {
						this.#db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
					}
					throw err;
				}
			};
		return Object.assign(wrap("BEGIN"), {
			deferred: wrap("BEGIN DEFERRED"),
			immediate: wrap("BEGIN IMMEDIATE"),
			exclusive: wrap("BEGIN EXCLUSIVE"),
		});
	}

	close(): void {
		this.#cache.clear();
		if (this.#db.isOpen) this.#db.close();
	}
}

type DatabaseConstructor = new (filename: string, options?: DatabaseOptions) => Database;

function resolveDatabase(): DatabaseConstructor {
	if (process.versions.bun) {
		const bun: { Database: DatabaseConstructor } = createRequire(import.meta.url)("bun:sqlite");
		return bun.Database;
	}
	return NodeDatabase;
}

// Value and type share the name, as with `import { Database } from "bun:sqlite"`.
export const Database: DatabaseConstructor = resolveDatabase();
