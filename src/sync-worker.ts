/**
 * Stateless parse worker for `syncAllSessions` (`node:worker_threads`). The
 * main thread owns the SQLite handle; workers receive a session path, offset,
 * and parser state, run `parseSessionFile` (which is pure I/O + CPU, no DB),
 * and post the structured-clone-safe result back. One in-flight request per
 * worker so the main thread can fan jobs out 1:1 with the pool size.
 */
import { parentPort, workerData } from "node:worker_threads";
import { addSessionRoot, setAgentDir } from "./config";
import { type ParseSessionResult, parseSessionFile, type SessionParserState } from "./parser";

/** Directories the spawning thread resolved; a worker has its own module state. */
export interface SyncWorkerData {
	agentDir: string;
	sessionRoots: string[];
}

export interface SyncWorkerRequest {
	sessionFile: string;
	fromOffset: number;
	parserState?: SessionParserState;
	replay?: boolean;
}

export type SyncWorkerResponse = { ok: true; result: ParseSessionResult } | { ok: false; error: string };

// Importing this module for its types on the main thread must not start anything.
if (parentPort) {
	const port = parentPort;
	const data: SyncWorkerData = workerData;
	setAgentDir(data.agentDir);
	for (const root of data.sessionRoots) addSessionRoot(root);

	port.on("message", async (request: SyncWorkerRequest) => {
		let response: SyncWorkerResponse;
		try {
			const result = await parseSessionFile(
				request.sessionFile,
				request.fromOffset,
				request.parserState,
				request.replay,
			);
			response = { ok: true, result };
		} catch (err) {
			response = { ok: false, error: err instanceof Error ? (err.stack ?? err.message) : String(err) };
		}
		port.postMessage(response);
	});
}
