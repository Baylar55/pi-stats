/**
 * Open the dashboard in the system browser. Over SSH or on a headless machine
 * nothing is opened and the caller prints the URL.
 */
import { spawn } from "node:child_process";

/** A plain `http://host:port` origin: nothing a shell could read as syntax (`start` goes through `cmd`). */
const SAFE_ORIGIN = /^http:\/\/[A-Za-z0-9.\-:[\]]+$/;

/** Whether a browser opened here would be visible to the user. */
export function canOpenBrowser(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
	if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
	if (platform === "win32" || platform === "darwin") return true;
	return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** Open `url` in the default browser; false when there is no display or the URL is not a plain origin. */
export function openBrowser(url: string): boolean {
	if (!canOpenBrowser() || !SAFE_ORIGIN.test(url)) return false;
	const [command, args]: [string, string[]] =
		process.platform === "win32"
			? ["cmd", ["/c", "start", '""', url]]
			: process.platform === "darwin"
				? ["open", [url]]
				: ["xdg-open", [url]];
	try {
		const child = spawn(command, args, {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
			// `start` takes its (empty) window title quoted; Node must not re-quote it.
			windowsVerbatimArguments: process.platform === "win32",
		});
		// A missing opener (no xdg-open) surfaces as an async error; the URL was printed anyway.
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
