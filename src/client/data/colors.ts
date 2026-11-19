/**
 * Categorical series colors. Every multi-series chart and table swatch draws
 * from {@link SERIES_COLORS}; ranking keeps the busiest series on the most
 * legible hues and the same key on the same hue across charts of one page.
 */

/** Ten mid-luminance hues that read on both the black and the white chassis; pi's logo colors lead. */
export const SERIES_COLORS = [
	"#4d9abf", // pi blue
	"#f09082", // pi coral
	"#f1be58", // pi yellow
	"#9d7bff", // violet
	"#4ade80", // green
	"#5ad8e6", // cyan
	"#e879f9", // fuchsia
	"#2dd4bf", // teal
	"#c3e94f", // lime
	"#5b8cff", // indigo
];

/** Neutral used for "Other" rollups and unknown buckets. */
export const OTHER_COLOR = "#6c6c74";

/** Stable identity of a model across providers: `model::provider`. */
export function modelKey(model: string, provider: string): string {
	return `${model}::${provider}`;
}

/**
 * Assign colors by descending weight (ties broken by key) so a model's hue is
 * determined by its rank, not by response order. Used by every per-model view.
 */
export function buildModelColorLookup(
	records: readonly { model: string; provider: string; totalRequests: number }[],
): Map<string, string> {
	return buildColorLookup(
		records.map(record => ({ key: modelKey(record.model, record.provider), weight: record.totalRequests })),
	);
}

/** Generic form of {@link buildModelColorLookup} for any keyed, weighted series. */
export function buildColorLookup(items: readonly { key: string; weight: number }[]): Map<string, string> {
	const ranked = [...items].sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
	return new Map(ranked.map((item, index) => [item.key, SERIES_COLORS[index % SERIES_COLORS.length]]));
}
