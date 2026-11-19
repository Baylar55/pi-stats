import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REMOVE_RETRIES = 40;
const REMOVE_RETRY_DELAY_MS = 50;
const RETRYABLE: Record<string, true> = { EBUSY: true, EPERM: true, ENOTEMPTY: true };

/**
 * Owned temporary directory. A
 * `"@name-"` prefix creates it under the OS temp dir.
 */
export class TempDir {
	readonly #path: string;

	private constructor(dir: string) {
		this.#path = dir;
	}

	static createSync(prefix = "@pi-temp-"): TempDir {
		const full = prefix.startsWith("@") ? path.join(os.tmpdir(), prefix.slice(1)) : prefix;
		return new TempDir(fs.mkdtempSync(full));
	}

	path(): string {
		return this.#path;
	}

	join(...parts: string[]): string {
		return path.join(this.#path, ...parts);
	}

	/** Windows keeps a closed SQLite file locked briefly: retry the transient failures. */
	removeSync(): void {
		for (let attempt = 0; ; attempt++) {
			try {
				fs.rmSync(this.#path, { recursive: true, force: true });
				return;
			} catch (err) {
				const code = err instanceof Error && "code" in err ? err.code : undefined;
				const retry =
					attempt < REMOVE_RETRIES && process.platform === "win32" && typeof code === "string" && RETRYABLE[code];
				if (!retry) throw err;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, REMOVE_RETRY_DELAY_MS);
			}
		}
	}
}
