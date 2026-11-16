// Builds dist/: the pi extension entry, the host-free runtime (library, bin, sync worker) and the React client.
import * as fs from "node:fs/promises";
import { build } from "esbuild";

await fs.rm("dist", { recursive: true, force: true });

const node = {
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	outdir: "dist",
	logLevel: "info",
	// Host packages resolve through pi's module mapping at load time; never bundle a second copy.
	external: ["@earendil-works/*", "typebox", "bun:sqlite"],
};

// The extension entry stays tiny: pi re-evaluates it on every session switch, and it loads the
// runtime (dist/index.js) lazily, once per process.
await build({ ...node, entryPoints: { extension: "src/extension.ts" } });

// Runtime entries share chunks so the bin, the library and the worker run one copy of each module.
await build({
	...node,
	splitting: true,
	// Chunks sit beside the entries so `new URL("./sync-worker.js", import.meta.url)` resolves from any of them.
	chunkNames: "chunk-[hash]",
	entryPoints: { index: "src/index.ts", cli: "src/cli.ts", "sync-worker": "src/sync-worker.ts" },
});

await build({
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "es2022",
	minify: true,
	jsx: "automatic",
	outdir: "dist/client",
	entryNames: "index",
	logLevel: "info",
	define: { "process.env.NODE_ENV": '"production"' },
	entryPoints: ["src/client/index.tsx"],
});

// The inline script applies the persisted theme before first paint (no flash).
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>pi stats</title>
    <script>
      (function () {
        try {
          var stored = localStorage.getItem("pi-stats-theme");
          var system = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
          var theme = stored === "light" || stored === "dark" ? stored : system;
          document.documentElement.dataset.theme = theme;
          document.documentElement.style.colorScheme = theme;
        } catch (e) {}
      })();
    </script>
    <link rel="stylesheet" href="index.css">
    <link rel="icon" type="image/x-icon" href="favicon.ico">
</head>
<body>
    <div id="root"></div>
    <script src="index.js" type="module"></script>
</body>
</html>`;

await fs.copyFile("src/client/favicon.ico", "dist/client/favicon.ico");
await fs.writeFile("dist/client/index.html", indexHtml);
