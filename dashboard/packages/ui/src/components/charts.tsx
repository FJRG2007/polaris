/**
 * Lightweight, dependency-free chart primitives drawn with plain SVG - no
 * charting library, in keeping with a minimal bundle. RadialGauge shows a single
 * 0..1 ratio (storage used, CPU load, a temperature against a ceiling);
 * TimeSeriesChart plots a metric's history over a window. Both read the design
 * tokens so they theme automatically.
 */

import { useId } from "react";
import { cn } from "../lib/cn.js";

export type GaugeTone = "primary" | "success" | "warning" | "danger";

const TONE_VAR: Record<GaugeTone, string> = {
    primary: "hsl(var(--primary))",
    success: "hsl(var(--success))",
    warning: "hsl(var(--warning))",
    danger: "hsl(var(--danger))"
};

export function RadialGauge({
    value,
    label,
    sublabel,
    tone = "primary",
    size = 104,
    className
}: {
    /** Fraction filled, 0..1 (clamped). */
    value: number;
    /** Big text in the center (e.g. "72%"). */
    label: string;
    /** Small caption under the ring. */
    sublabel?: string;
    tone?: GaugeTone;
    size?: number;
    className?: string;
}) {
    const pct = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    const stroke = Math.round(size * 0.09);
    const radius = (size - stroke) / 2;
    const circ = 2 * Math.PI * radius;
    const center = size / 2;

    return (
        <div className={cn("flex flex-col items-center gap-1", className)}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
                <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke="hsl(var(--muted))"
                    strokeWidth={stroke}
                />
                <circle
                    cx={center}
                    cy={center}
                    r={radius}
                    fill="none"
                    stroke={TONE_VAR[tone]}
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    strokeDasharray={`${circ * pct} ${circ}`}
                    transform={`rotate(-90 ${center} ${center})`}
                />
                <text
                    x={center}
                    y={center}
                    textAnchor="middle"
                    dominantBaseline="central"
                    className="fill-foreground font-semibold"
                    style={{ fontSize: size * 0.22 }}
                >
                    {label}
                </text>
            </svg>
            {sublabel ? <span className="text-xs text-muted-foreground">{sublabel}</span> : null}
        </div>
    );
}

/** One point of a time series: a value (or null for a gap) at an epoch-ms time. */
export interface TimePoint {
    t: number;
    v: number | null;
}

/**
 * A compact area-line chart of one metric over a time window. The plot is a
 * stretched SVG (viewBox scaled to fill its box, strokes kept crisp with
 * non-scaling-stroke), while every label is HTML around it so text never
 * distorts. Nulls break the line into gaps rather than drawing through them.
 */
export function TimeSeriesChart({
    points,
    from,
    to,
    max,
    tone = "primary",
    format = (value) => String(Math.round(value)),
    label,
    height = 132,
    className
}: {
    points: TimePoint[];
    /** X domain start/end (epoch ms). */
    from: number;
    to: number;
    /** Fixed Y max (e.g. 100 for a percentage); derived from the data otherwise. */
    max?: number;
    tone?: GaugeTone;
    /** Formats the header value and the axis ceiling. */
    format?: (value: number) => string;
    label?: string;
    height?: number;
    className?: string;
}) {
    const color = TONE_VAR[tone];
    const gradientId = useId();
    const width = 600;
    const span = Math.max(1, to - from);
    const present = points.filter((point): point is { t: number; v: number } => point.v != null);
    const dataMax = present.reduce((peak, point) => Math.max(peak, point.v), 0);
    const yMax = max ?? Math.max(1, dataMax * 1.15);
    const last = present.length > 0 ? present[present.length - 1]!.v : null;

    const x = (t: number): number => ((t - from) / span) * width;
    const y = (v: number): number => height - Math.max(0, Math.min(1, v / yMax)) * height;

    // Split into contiguous non-null runs so gaps are not drawn through.
    const runs: { t: number; v: number }[][] = [];
    let run: { t: number; v: number }[] = [];
    for (const point of points) {
        if (point.v == null) {
            if (run.length > 0) runs.push(run);
            run = [];
        } else {
            run.push({ t: point.t, v: point.v });
        }
    }
    if (run.length > 0) runs.push(run);

    const linePath = (segment: { t: number; v: number }[]): string =>
        segment.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.t).toFixed(1)} ${y(point.v).toFixed(1)}`).join(" ");
    const areaPath = (segment: { t: number; v: number }[]): string => {
        if (segment.length === 0) return "";
        const start = x(segment[0]!.t).toFixed(1);
        const end = x(segment[segment.length - 1]!.t).toFixed(1);
        return `M${start} ${height} ${segment.map((point) => `L${x(point.t).toFixed(1)} ${y(point.v).toFixed(1)}`).join(" ")} L${end} ${height} Z`;
    };

    return (
        <div className={cn("rounded-lg border border-border/60 p-3", className)}>
            <div className="flex items-baseline justify-between">
                {label ? <span className="text-sm font-medium">{label}</span> : <span />}
                <span className="text-sm text-muted-foreground">{last != null ? format(last) : "-"}</span>
            </div>
            {present.length === 0 ? (
                <div
                    className="mt-2 flex items-center justify-center rounded-md text-xs text-muted-foreground"
                    style={{ height }}
                >
                    No data in this range
                </div>
            ) : (
                <svg
                    className="mt-2 w-full"
                    width="100%"
                    height={height}
                    viewBox={`0 0 ${width} ${height}`}
                    preserveAspectRatio="none"
                    role="img"
                    aria-label={label ?? "History"}
                >
                    <defs>
                        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                            <stop offset="100%" stopColor={color} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    {[0.25, 0.5, 0.75].map((fraction) => (
                        <line
                            key={fraction}
                            x1={0}
                            x2={width}
                            y1={height * fraction}
                            y2={height * fraction}
                            stroke="hsl(var(--border))"
                            strokeWidth={1}
                            strokeDasharray="3 4"
                            vectorEffect="non-scaling-stroke"
                            opacity={0.5}
                        />
                    ))}
                    {runs.map((segment, index) => (
                        <path key={`a${index}`} d={areaPath(segment)} fill={`url(#${gradientId})`} />
                    ))}
                    {runs.map((segment, index) => (
                        <path
                            key={`l${index}`}
                            d={linePath(segment)}
                            fill="none"
                            stroke={color}
                            strokeWidth={1.75}
                            strokeLinejoin="round"
                            strokeLinecap="round"
                            vectorEffect="non-scaling-stroke"
                        />
                    ))}
                </svg>
            )}
        </div>
    );
}
