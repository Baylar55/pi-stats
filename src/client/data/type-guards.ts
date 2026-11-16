/**
 * Client-local guards. The server's `src/util.ts` pulls Node built-ins, so the
 * browser bundle keeps its own copy of the one guard it needs.
 */
export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
