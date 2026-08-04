"use client";

/**
 * What a rule matches over the last day, as a line small enough to sit in a table row.
 *
 * Inline SVG rather than a chart library: this is a polyline over two dozen numbers
 * with no axes, no legend and no interaction, and a charting dependency loaded on the
 * firewall screen would cost more than every rule row put together.
 *
 * The shape carries the information the number cannot - a steady trickle and a single
 * spike are the same total and are not the same event - so the count stays beside it
 * rather than being replaced by it.
 */

const WIDTH = 96;
const HEIGHT = 24;

export function Sparkline({ series, label }: { series: readonly number[]; label: string }) {
    const peak = Math.max(...series, 0);
    // A flat line at the bottom rather than a division by zero, and rather than a
    // straight line through the middle that reads as a steady stream of nothing.
    const points = series.map((value, index) => {
        const x = series.length > 1 ? (index / (series.length - 1)) * WIDTH : WIDTH / 2;
        const y = peak > 0 ? HEIGHT - (value / peak) * (HEIGHT - 2) - 1 : HEIGHT - 1;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    return (
        <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            width={WIDTH}
            height={HEIGHT}
            role="img"
            aria-label={label}
            preserveAspectRatio="none"
            className="shrink-0 overflow-visible"
        >
            {peak > 0 ? (
                <polyline
                    points={points.join(" ")}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    className="text-primary"
                />
            ) : (
                <line
                    x1={0}
                    y1={HEIGHT - 1}
                    x2={WIDTH}
                    y2={HEIGHT - 1}
                    stroke="currentColor"
                    strokeWidth={1}
                    className="text-border"
                />
            )}
        </svg>
    );
}
