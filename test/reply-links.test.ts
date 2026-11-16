import * as fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { syncAllSessions } from "../src/aggregator";
import { getFileOffset, initDb } from "../src/db";
import { assistant, lines, sessionPath, T0, user, writeSession } from "./helpers/session";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-reply-links-");

const ISO = new Date(T0).toISOString();
const ask = (id: string, parentId: string | null) => user(id, "why is this still broken", { parentId });
const reply = (id: string, parentId: string) => assistant(id, { parentId });

/** Entries pi writes between a user message and its reply. */
function systemPrompt(id: string, parentId: string): object {
	return { type: "message", id, parentId, timestamp: ISO, message: { role: "system", content: "", sections: {}, timestamp: T0 } };
}
function thinking(id: string, parentId: string): object {
	return { type: "thinking_level_change", id, parentId, timestamp: ISO, thinkingLevel: "high" };
}
function custom(id: string, parentId: string): object {
	return { type: "custom", id, parentId, timestamp: ISO, customType: "my-extension", data: {} };
}
function bash(id: string, parentId: string): object {
	return { type: "message", id, parentId, timestamp: ISO, message: { role: "bashExecution", command: "ls", output: "", timestamp: T0 } };
}

async function models(): Promise<Record<string, string | null>> {
	const rows = (await initDb())
		.prepare<{ entry_id: string; model: string | null }>("SELECT entry_id, model FROM user_messages ORDER BY entry_id")
		.all();
	return Object.fromEntries(rows.map(row => [row.entry_id, row.model]));
}

describe("user message reply links", () => {
	it("links a reply written behind non-conversation entries, but not past another branch or message", async () => {
		await writeSession(sessionPath(), [
			ask("u1", null),
			systemPrompt("s1", "u1"),
			thinking("t1", "s1"),
			custom("c1", "t1"),
			reply("a1", "c1"),
			// u2 is abandoned: the next reply continues the branch at a1.
			ask("u2", "a1"),
			custom("c2", "u2"),
			reply("a2", "a1"),
			// A message on a sibling branch leaves u3's reply to link.
			ask("u3", "a2"),
			bash("b3", "u3"),
			reply("a3", "u3"),
			// A shell command the user ran in between ends the chain: its reply answers that, not u4.
			ask("u4", "a3"),
			bash("b4", "u4"),
			reply("a4", "b4"),
		]);

		await syncAllSessions({ workers: 1 });

		expect(await models()).toEqual({ u1: "gpt-x", u2: null, u3: "gpt-x", u4: null });
	});

	it("links a reply that a later sync pass reads", async () => {
		const file = await writeSession(sessionPath(), [ask("u1", null), thinking("t1", "u1")]);
		await syncAllSessions({ workers: 1 });
		expect(await models()).toEqual({ u1: null });
		expect(getFileOffset(file)?.parserState?.pendingReplies).toEqual({ u1: "u1", t1: "u1" });

		await fs.appendFile(file, lines([reply("a1", "t1")]));
		await syncAllSessions({ workers: 1 });

		expect(await models()).toEqual({ u1: "gpt-x" });
		expect(getFileOffset(file)?.parserState?.pendingReplies).toEqual({});
	});
});
