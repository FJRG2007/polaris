/**
 * Lightweight, dependency-free chart primitives drawn with plain SVG - no
 * charting library, in keeping with a minimal bundle. RadialGauge shows a single
 * 0..1 ratio (storage used, CPU load, a temperature against a ceiling); it reads
 * the design tokens so it themes automatically. More primitives (sparklines for
 * access/throughput history) can join here as those data sources land.
 */

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
