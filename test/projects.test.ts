import { describe, expect, it } from "vitest";
import { dedupeProjects, isTemporaryProjectPath, normalizeProjectPath, projectFolder } from "../src/projects";

describe("project normalization", () => {
	it("normalizes conventional worktree paths without author-specific path rules", () => {
		expect(normalizeProjectPath("/Users/me/Code/app/.worktrees/lane/packages/stats")).toBe("/Users/me/Code/app");
		expect(normalizeProjectPath("/Users/me/Code/app-wt/lane/packages/stats")).toBe("/Users/me/Code/app");
		expect(normalizeProjectPath("/Users/me/IDEProjects/app")).toBe("/Users/me/IDEProjects/app");
		expect(normalizeProjectPath("/Users/me/tool/worktrees/app/packages/stats")).toBe(
			"/Users/me/tool/worktrees/app/packages/stats",
		);
		expect(normalizeProjectPath("/tmp/pi-bash-exec/session")).toBeNull();
	});

	it("handles Windows drive letters and backslashes", () => {
		expect(normalizeProjectPath("C:\\Users\\me\\Code\\app\\.worktrees\\lane\\src")).toBe("C:/Users/me/Code/app");
		expect(normalizeProjectPath("C:\\Users\\me\\Code\\app\\")).toBe("C:/Users/me/Code/app");
		expect(normalizeProjectPath("C:\\Users\\me\\AppData\\Local\\Temp\\scratch")).toBeNull();
		expect(isTemporaryProjectPath("C:\\Users\\me\\Templates\\app")).toBe(false);
	});

	it("keeps temp paths as a folder so their usage still counts", () => {
		expect(projectFolder("/tmp/scratch/.worktrees/a/b")).toBe("/tmp/scratch");
		expect(isTemporaryProjectPath("/tmp/scratch")).toBe(true);
		expect(isTemporaryProjectPath("/var/folders/ab/cd")).toBe(true);
	});

	it("dedupes normalized project roots with separator-aware parent matching", () => {
		expect(
			dedupeProjects(
				new Set([
					"/Users/me/Code/foo",
					"/Users/me/Code/foo/packages/stats",
					"/Users/me/Code/foobar",
					"/Users/me/Code/foo/.worktrees/lane/src",
				]),
			),
		).toEqual(["/Users/me/Code/foo", "/Users/me/Code/foobar"]);
	});
});
