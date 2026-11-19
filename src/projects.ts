/**
 * Project-folder normalization: worktree sub-paths collapse to their project
 * root and temp locations are recognized.
 * Paths are compared and stored with forward slashes, so `C:\Users\me\app`
 * and `C:/Users/me/app` are one project.
 */

// Paths that carry no dashboard signal — temp/internal locations.
const TEMP_PATH_RE =
	/(?:^|\/)(?:T|tmp|temp|pi-bash-exec|pi-bash-detach)(?:\/|$)|^\/var\/folders(?:\/|$)|\/AppData\/Local\/Temp(?:\/|$)/i;

const WORKTREE_PATTERNS = [
	/^(.+)\/\.wt\/[^/]+(?:\/.*)?$/u,
	/^(.+)\/\.worktrees\/[^/]+(?:\/.*)?$/u,
	/^(.+)-wt\/[^/]+(?:\/.*)?$/u,
	/^(.+)-worktrees\/[^/]+(?:\/.*)?$/u,
	/^(.+)\.wt\/[^/]+(?:\/.*)?$/u,
];

function canonicalProjectPath(p: string): string {
	const normalized = p.replaceAll("\\", "/").replace(/\/+$/u, "");
	return normalized || "/";
}

/** True when `candidate` exactly equals `parent` or is a separator-bounded sub-path. */
function isSameOrSubPath(candidate: string, parent: string): boolean {
	return candidate === parent || candidate.startsWith(`${parent}/`);
}

/** Strip a conventional worktree suffix (`.wt/`, `-wt/`, `.worktrees/`, `-worktrees/`) from a canonical path. */
function collapseWorktree(clean: string): string {
	for (const pattern of WORKTREE_PATTERNS) {
		const match = clean.match(pattern);
		if (match?.[1]) return canonicalProjectPath(match[1]);
	}
	return clean;
}

/** Whether a path lies in a temp location (`/tmp`, `/var/folders`, `%LOCALAPPDATA%\Temp`, …). */
export function isTemporaryProjectPath(p: string): boolean {
	return TEMP_PATH_RE.test(canonicalProjectPath(p));
}

/**
 * Collapse conventional worktree sub-paths to their logical project root.
 * No author-specific IDE or tool paths are baked in.
 *
 * Returns null to drop temp/internal paths entirely.
 */
export function normalizeProjectPath(p: string): string | null {
	const clean = canonicalProjectPath(p);
	return TEMP_PATH_RE.test(clean) ? null : collapseWorktree(clean);
}

/**
 * The folder a session's requests are stored under: its `cwd` with worktree
 * paths collapsed to the project root. Temp paths are kept (their usage still
 * counts toward totals); the Projects page hides them by default.
 */
export function projectFolder(cwd: string): string {
	return collapseWorktree(canonicalProjectPath(cwd));
}

/**
 * Given a raw set of paths, normalize worktree paths and remove sub-paths
 * that are already covered by a shorter parent at depth ≥ 4.
 * Returns a sorted, deduped list of meaningful project roots.
 */
export function dedupeProjects(rawPaths: Set<string>): string[] {
	const normalized = new Set<string>();
	for (const p of rawPaths) {
		const n = normalizeProjectPath(p);
		if (n) normalized.add(n);
	}
	const sorted = Array.from(normalized).sort();
	return sorted.filter(p => {
		return !sorted.some(
			other =>
				other !== p &&
				other.length < p.length &&
				isSameOrSubPath(p, other) &&
				other.split("/").filter(Boolean).length >= 4,
		);
	});
}
