/**
 * Where pi keeps its data. Host-free on purpose: the stats runtime is also
 * loaded outside pi's extension module mapping (standalone bin, worker
 * threads), where `@earendil-works/pi-coding-agent` cannot be imported. The
 * extension passes pi's own `getAgentDir()` in through {@link setAgentDir}.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let agentDirOverride: string | undefined;
const extraSessionRoots = new Set<string>();

function expandTilde(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** pi's agent directory: the override, else `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
export function getAgentDir(): string {
	if (agentDirOverride) return agentDirOverride;
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return path.resolve(expandTilde(envDir));
	return path.join(os.homedir(), ".pi", "agent");
}

/** Pin the agent directory (the extension passes pi's own); `undefined` returns to the environment default. */
export function setAgentDir(dir: string | undefined): void {
	agentDirOverride = dir ? path.resolve(dir) : undefined;
}

/** Default session root: `<agentDir>/sessions`, one `--<cwd>--` folder per project. */
export function getSessionsDir(): string {
	return path.join(getAgentDir(), "sessions");
}

export function getStatsDbPath(): string {
	return path.join(getAgentDir(), "stats.db");
}

function settingsSessionDir(): string | undefined {
	try {
		const settings: unknown = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf8"));
		if (!settings || typeof settings !== "object" || !("sessionDir" in settings)) return undefined;
		return typeof settings.sessionDir === "string" && settings.sessionDir ? settings.sessionDir : undefined;
	} catch {
		return undefined;
	}
}

/** Add a directory pi writes sessions to (the live session's dir covers `--session-dir` and project settings). */
export function addSessionRoot(dir: string): void {
	extraSessionRoots.add(path.resolve(expandTilde(dir)));
}

/**
 * Every directory transcripts may live in, resolved the way pi does it: the
 * default sessions dir, `PI_CODING_AGENT_SESSION_DIR`, the `sessionDir`
 * setting, and roots added at runtime. Roots nested inside another root are
 * dropped, since scans are recursive.
 */
export function getSessionRoots(): string[] {
	const roots = new Set<string>([getSessionsDir(), ...extraSessionRoots]);
	const envDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	if (envDir) roots.add(path.resolve(expandTilde(envDir)));
	const settingsDir = settingsSessionDir();
	if (settingsDir) roots.add(path.resolve(expandTilde(settingsDir)));
	const all = [...roots];
	return all.filter(root => !all.some(other => other !== root && isInside(root, other)));
}

function isInside(child: string, parent: string): boolean {
	const rel = path.relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The session root containing `file`, or the default sessions dir when none does. */
export function findSessionRoot(file: string): string {
	const resolved = path.resolve(file);
	for (const root of getSessionRoots()) {
		if (isInside(resolved, root)) return root;
	}
	return getSessionsDir();
}
