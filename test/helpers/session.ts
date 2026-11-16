/** Builders for pi-format transcript fixtures. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getSessionsDir } from "../../src/config";

export const T0 = Date.parse("2026-09-07T12:00:00Z");

export interface UsageFixture {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export function usage(overrides: Partial<UsageFixture> = {}): UsageFixture {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		...overrides,
	};
}

export function header(cwd = "/work/project", extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "session", version: 3, id: "session-id", timestamp: new Date(T0).toISOString(), cwd, ...extra };
}

interface EntryOptions {
	parentId?: string | null;
	timestamp?: number;
	/** Extra or overriding fields of the nested message. */
	message?: Record<string, unknown>;
}

function messageEntry(id: string, options: EntryOptions, message: Record<string, unknown>): Record<string, unknown> {
	const timestamp = options.timestamp ?? T0;
	return {
		type: "message",
		id,
		parentId: options.parentId ?? null,
		timestamp: new Date(timestamp).toISOString(),
		message: { ...message, timestamp, ...options.message },
	};
}

export function assistant(id: string, options: EntryOptions = {}): Record<string, unknown> {
	return messageEntry(id, options, {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-x",
		usage: usage(),
		stopReason: "stop",
	});
}

export function user(id: string, text: string, options: EntryOptions = {}): Record<string, unknown> {
	return messageEntry(id, options, { role: "user", content: text });
}

export function toolCall(id: string, name: string, args: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "toolCall", id, name, arguments: args };
}

export function toolResult(
	id: string,
	toolCallId: string,
	text: string,
	options: EntryOptions & { isError?: boolean } = {},
): Record<string, unknown> {
	return messageEntry(id, options, {
		role: "toolResult",
		toolCallId,
		toolName: "tool",
		content: [{ type: "text", text }],
		isError: options.isError ?? false,
	});
}

export function lines(entries: readonly unknown[]): string {
	return entries.map(entry => `${JSON.stringify(entry)}\n`).join("");
}

/** Path of `<sessions>/<slug>/<name>`; the default slug is how pi encodes `/work/project`. */
export function sessionPath(name = "session.jsonl", slug = "--work-project--"): string {
	return path.join(getSessionsDir(), slug, name);
}

/** Write a transcript (entries or raw text), creating its directory. */
export async function writeSession(file: string, content: readonly unknown[] | string): Promise<string> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, typeof content === "string" ? content : lines(content));
	return file;
}

/** Replace a transcript with a new file at the same path (new inode), as an editor or a restore would. */
export async function replaceSession(file: string, content: readonly unknown[] | string): Promise<void> {
	await writeSession(`${file}.replacement`, content);
	await fs.rename(`${file}.replacement`, file);
}
