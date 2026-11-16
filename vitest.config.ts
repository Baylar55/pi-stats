import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: { jsx: "automatic" },
	test: {
		include: ["test/**/*.test.{ts,tsx}"],
		// Tests redirect the process-wide agent dir and hold one SQLite handle: one process per file.
		pool: "forks",
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
