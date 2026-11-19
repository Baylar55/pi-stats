import { type ReactNode, useEffect, useRef, useState } from "react";
import { Sparkline } from "../charts/Sparkline";

export interface StatProps {
	label: ReactNode;
	value: ReactNode;
	/** Small print under the value. */
	hint?: ReactNode;
	/** Trend under the value. */
	spark?: readonly number[];
	sparkColor?: string;
	size?: "md" | "sm";
	/** Title tooltip explaining the metric. */
	title?: string;
}

/**
 * One metric tile. The value flashes briefly when it changes after mount, so
 * live updates are noticeable without being loud.
 */
export function Stat({ label, value, hint, spark, sparkColor, size = "md", title }: StatProps) {
	const flash = useChangeFlash(typeof value === "string" || typeof value === "number" ? value : null);
	return (
		<div className="stat" data-size={size} title={title}>
			<div className="stat-label">{label}</div>
			<div className="stat-value" data-flash={flash}>
				{value}
			</div>
			{hint !== undefined && (
				<div className="stat-foot">
					<span className="truncate">{hint}</span>
				</div>
			)}
			{spark && spark.length > 1 && (
				<div className="stat-spark">
					<Sparkline values={spark} color={sparkColor} />
				</div>
			)}
		</div>
	);
}

export interface StatGridProps {
	/** Minimum tile width before wrapping. Default 170px. */
	min?: number;
	children: ReactNode;
}

/** Tiles sharing one card, separated by hairlines. */
export function StatGrid({ min, children }: StatGridProps) {
	return (
		<div className="stat-grid rise" style={min !== undefined ? { "--stat-min": `${min}px` } : undefined}>
			{children}
		</div>
	);
}

function useChangeFlash(value: string | number | null): boolean {
	const previous = useRef(value);
	const [flash, setFlash] = useState(false);
	useEffect(() => {
		if (previous.current === value) return;
		const hadValue = previous.current !== null;
		previous.current = value;
		if (!hadValue) return;
		setFlash(true);
		const timer = setTimeout(() => setFlash(false), 900);
		return () => clearTimeout(timer);
	}, [value]);
	return flash;
}
