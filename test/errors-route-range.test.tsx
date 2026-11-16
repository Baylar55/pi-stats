// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorsRoute } from "../src/client/routes/ErrorsRoute";

type FetchInput = string | URL | Request;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(async () => {
	const activeRoot = root;
	if (activeRoot) {
		await act(async () => {
			activeRoot.unmount();
		});
		root = null;
	}
	container?.remove();
	container = null;
	vi.unstubAllGlobals();
});

describe("ErrorsRoute range", () => {
	it("requests the selected range again when the range changes", async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		const requestedUrls: string[] = [];
		vi.stubGlobal("fetch", async (input: FetchInput) => {
			requestedUrls.push(input instanceof Request ? input.url : input.toString());
			return Response.json([]);
		});

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(<ErrorsRoute active range="24h" onRequestClick={() => {}} />);
		});
		expect(requestedUrls).toEqual(["/api/stats/errors?range=24h&limit=50"]);

		await act(async () => {
			root?.render(<ErrorsRoute active range="7d" onRequestClick={() => {}} />);
		});
		expect(requestedUrls).toEqual(["/api/stats/errors?range=24h&limit=50", "/api/stats/errors?range=7d&limit=50"]);
	});
});
