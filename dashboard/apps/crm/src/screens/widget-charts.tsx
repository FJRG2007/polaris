"use client";

/**
 * What a dashboard widget draws: one figure, bars, a line along time, or a
 * ring of shares - and, for every one of them, the same numbers as a table.
 *
 * Plain HTML and SVG on the dashboard's tokens. Bars and the ring take their
 * colours from one fixed categorical order (`--crm-series-*`, light and dark
 * each stepped for their own surface and checked for colour-blind separation);
 * a ring has at most eight slices, the eighth being everything else. Every
 * value is written beside its mark, so no figure is told by colour alone.
 */

import { useMemo, useState } from "react";
import { TimeSeriesChart, cn } from "@polaris/ui";

export interface ChartPoint {
    readonly key: string;
    readonly label: string;
    readonly value: number | null;
}

/** The categorical order, light then dark, as the stylesheet below sets it. */
const SERIES = 8;

/** Drawn once per page: the series colours for both themes. */
export function ChartColors() {
    const light = [
        "#2a78d6",
        "#eb6834",
        "#1baf7a",
        "#eda100",
        "#e87ba4",
        "#008300",
        "#6250d6",
        "#e34948"
    ];
    const dark = [
        "#3987e5",
        "#d95926",
        "#199e70",
        "#c98500",
        "#d55181",
        "#008300",
        "#9085e9",
        "#e66767"
    ];
    const vars = (hexes: string[]) =>
        hexes.map((hex, index) => `--crm-series-${index + 1}:${hex};`).join("");
    return (
        <style>{`.crm-viz{${vars(dark)}}:root.light .crm-viz{${vars(light)}}@media (prefers-color-scheme: light){:root.system .crm-viz{${vars(light)}}}`}</style>
    );
}

const series = (index: number) => `var(--crm-series-${(index % SERIES) + 1})`;

export function NumberFigure({
    value,
    format
}: {
    value: number | null;
    format: (value: number) => string;
}) {
    return (
        <p className="truncate text-[2rem] font-semibold leading-tight tracking-tight tabular-nums">
            {value === null ? "-" : format(value)}
        </p>
    );
}

/** One row per group: its name, a bar against the largest, and its figure. */
export function BarRows({
    points,
    format,
    label
}: {
    points: readonly ChartPoint[];
    format: (value: number) => string;
    label: string;
}) {
    const peak = Math.max(0, ...points.map((point) => Math.abs(point.value ?? 0)));
    return (
        <ul className="crm-viz flex flex-col gap-1.5" aria-label={label}>
            {points.map((point) => {
                const share = peak === 0 ? 0 : Math.abs(point.value ?? 0) / peak;
                const text = point.value === null ? "-" : format(point.value);
                return (
                    <li
                        key={point.key}
                        className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-2 text-[0.8125rem]"
                        title={`${point.label}: ${text}`}
                    >
                        <span className="truncate text-muted-foreground">{point.label}</span>
                        <span className="h-3 min-w-0 rounded-r-[4px] bg-transparent">
                            <span
                                className="block h-full rounded-r-[4px]"
                                style={{
                                    width: `${Math.max(share * 100, point.value ? 1 : 0)}%`,
                                    background: series(0)
                                }}
                            />
                        </span>
                        <span className="tabular-nums">{text}</span>
                    </li>
                );
            })}
        </ul>
    );
}

/** A line along the periods, with the dashboard's crosshair readout. */
export function PeriodLine({
    points,
    format,
    formatPeriod,
    label
}: {
    points: readonly ChartPoint[];
    format: (value: number) => string;
    formatPeriod: (at: number) => string;
    label: string;
}) {
    const timed = useMemo(
        () => points.map((point) => ({ t: Date.parse(`${point.key}T00:00:00Z`), v: point.value })),
        [points]
    );
    if (timed.length === 0) return null;
    return (
        <TimeSeriesChart
            points={timed}
            from={timed[0]!.t}
            to={timed[timed.length - 1]!.t}
            format={format}
            formatTime={formatPeriod}
            summary="sum"
            label={label}
            height={150}
        />
    );
}

/** A ring of shares, with every slice named and counted beside it. */
export function ShareRing({
    points,
    format,
    label,
    otherLabel
}: {
    points: readonly ChartPoint[];
    format: (value: number) => string;
    label: string;
    otherLabel: string;
}) {
    const [active, setActive] = useState<string | null>(null);
    // Seven named slices and the rest as one: an eighth colour is the last.
    const positive = points.filter((point) => (point.value ?? 0) > 0);
    const shown = positive.slice(0, SERIES - 1);
    const restValue = positive
        .slice(SERIES - 1)
        .reduce((sum, point) => sum + (point.value ?? 0), 0);
    const slices: ChartPoint[] =
        restValue > 0 ? [...shown, { key: "__other", label: otherLabel, value: restValue }] : shown;
    const total = slices.reduce((sum, point) => sum + (point.value ?? 0), 0);

    const radius = 52;
    const ring = 18;
    let angle = -Math.PI / 2;
    const arcs = slices.map((point, index) => {
        const sweep = total === 0 ? 0 : ((point.value ?? 0) / total) * Math.PI * 2;
        const start = angle;
        angle += sweep;
        return { point, index, start, end: angle, sweep };
    });
    const arc = (start: number, end: number) => {
        const large = end - start > Math.PI ? 1 : 0;
        const at = (theta: number) =>
            `${(60 + radius * Math.cos(theta)).toFixed(2)} ${(60 + radius * Math.sin(theta)).toFixed(2)}`;
        // A whole ring cannot be one arc: two halves.
        if (end - start >= Math.PI * 2 - 1e-6) {
            return `M${at(start)} A${radius} ${radius} 0 1 1 ${at(start + Math.PI)} A${radius} ${radius} 0 1 1 ${at(start)}`;
        }
        return `M${at(start)} A${radius} ${radius} 0 ${large} 1 ${at(end)}`;
    };

    return (
        <div className="crm-viz flex flex-wrap items-center gap-4">
            <svg viewBox="0 0 120 120" className="size-32 shrink-0" role="img" aria-label={label}>
                {arcs.map(({ point, index, start, end }) => (
                    <path
                        key={point.key}
                        d={arc(start, end)}
                        fill="none"
                        stroke={series(index)}
                        strokeWidth={active === point.key ? ring + 4 : ring}
                        onPointerEnter={() => setActive(point.key)}
                        onPointerLeave={() => setActive(null)}
                    >
                        <title>{`${point.label}: ${format(point.value ?? 0)}`}</title>
                    </path>
                ))}
                {/* The 2px gap between slices, in the card's own colour. */}
                {arcs.length > 1
                    ? arcs.map(({ point, start }) => (
                          <line
                              key={`gap:${point.key}`}
                              x1={60 + (radius - ring / 2 - 2) * Math.cos(start)}
                              y1={60 + (radius - ring / 2 - 2) * Math.sin(start)}
                              x2={60 + (radius + ring / 2 + 2) * Math.cos(start)}
                              y2={60 + (radius + ring / 2 + 2) * Math.sin(start)}
                              stroke="hsl(var(--card))"
                              strokeWidth={2}
                          />
                      ))
                    : null}
            </svg>
            <ul className="flex min-w-0 flex-1 flex-col gap-1 text-[0.8125rem]">
                {arcs.map(({ point, index }) => (
                    <li
                        key={point.key}
                        className={cn(
                            "flex min-w-0 items-center gap-2 rounded px-1",
                            active === point.key && "bg-muted"
                        )}
                        onPointerEnter={() => setActive(point.key)}
                        onPointerLeave={() => setActive(null)}
                    >
                        <span
                            aria-hidden
                            className="size-2.5 shrink-0 rounded-sm"
                            style={{ background: series(index) }}
                        />
                        <span className="min-w-0 flex-1 truncate" title={point.label}>
                            {point.label}
                        </span>
                        <span className="tabular-nums">{format(point.value ?? 0)}</span>
                        <span className="w-10 text-right tabular-nums text-muted-foreground">
                            {total === 0
                                ? ""
                                : `${Math.round(((point.value ?? 0) / total) * 100)}%`}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** The same numbers as a table: for reading exactly, and for screen readers. */
export function PointsTable({
    points,
    format,
    groupHeading,
    valueHeading
}: {
    points: readonly ChartPoint[];
    format: (value: number) => string;
    groupHeading: string;
    valueHeading: string;
}) {
    return (
        <div className="max-h-64 overflow-auto">
            <table className="w-full text-[0.8125rem]">
                <thead>
                    <tr className="text-left text-muted-foreground">
                        <th className="py-1 pr-2 font-medium">{groupHeading}</th>
                        <th className="py-1 text-right font-medium">{valueHeading}</th>
                    </tr>
                </thead>
                <tbody>
                    {points.map((point) => (
                        <tr key={point.key} className="border-t border-border">
                            <td className="max-w-0 truncate py-1 pr-2" title={point.label}>
                                {point.label}
                            </td>
                            <td className="py-1 text-right tabular-nums">
                                {point.value === null ? "-" : format(point.value)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
