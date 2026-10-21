"use client";

/**
 * A chart Polar drew. A line over dates is the dashboard's own time chart
 * (`MultiSeriesChart`); anything over names - and any series that dips below
 * zero, which that chart does not draw - is drawn here with the same rules:
 * marks in a stretched box, every word in HTML around it so text never
 * distorts, the dashboard's series colours, and pointing at a column reading
 * out its values above the plot instead of in a floating box something could
 * clip. The values are also there as a table only a screen reader reads,
 * since a picture carries none of them to one.
 */

import { useMemo, useState } from "react";
import { visualGrid, type ChartView } from "@/lib/polar/visuals";
import { MultiSeriesChart, SERIES_COLORS, cn } from "@polaris/ui";

const DAY = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?$/;
const HEIGHT = 168;

function format(value: number | null, unit?: string): string {
    if (value === null) return "-";
    const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
    return unit ? `${number} ${unit}` : number;
}

/** The times of a line over dates, or null when it is not one the time chart draws. */
function timesOf(view: ChartView): number[] | null {
    if (view.type !== "line" || view.categories.length < 2) return null;
    if (view.series.some((line) => line.values.some((value) => value !== null && value < 0)))
        return null;
    const times = view.categories.map((category) =>
        DAY.test(category) ? Date.parse(category) : Number.NaN
    );
    if (times.some((time) => !Number.isFinite(time))) return null;
    for (let index = 1; index < times.length; index++)
        if (times[index]! <= times[index - 1]!) return null;
    return times;
}

export function VisualChart({ view, label }: { view: ChartView; label: string }) {
    return (
        <div className="min-w-0">
            <ChartPicture view={view} label={label} />
            <ChartValues view={view} label={label} />
        </div>
    );
}

/** The chart's values as a table, for a screen reader only. */
function ChartValues({ view, label }: { view: ChartView; label: string }) {
    const grid = useMemo(() => visualGrid(view), [view]);
    if (!grid) return null;
    return (
        <table className="sr-only" aria-label={label}>
            <thead>
                <tr>
                    {grid.header.map((cell, index) => (
                        <th key={index} scope="col">
                            {cell}
                        </th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {grid.rows.map((row, at) => (
                    <tr key={at}>
                        {row.map((cell, index) =>
                            index === 0 ? (
                                <th key={index} scope="row">
                                    {cell}
                                </th>
                            ) : (
                                <td key={index}>
                                    {format(typeof cell === "number" ? cell : null)}
                                </td>
                            )
                        )}
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function ChartPicture({ view, label }: { view: ChartView; label: string }) {
    const times = useMemo(() => timesOf(view), [view]);
    if (times) {
        return (
            <MultiSeriesChart
                label={label}
                from={times[0]!}
                to={times.at(-1)!}
                format={(value) => format(value, view.unit)}
                formatTime={(at) =>
                    new Intl.DateTimeFormat(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "2-digit"
                    }).format(at)
                }
                series={view.series.map((line, index) => ({
                    key: String(index),
                    label: line.label,
                    points: line.values.map((value, at) => ({ t: times[at]!, v: value }))
                }))}
            />
        );
    }
    return <CategoryChart view={view} label={label} />;
}

function CategoryChart({ view, label }: { view: ChartView; label: string }) {
    const [hover, setHover] = useState<number | null>(null);
    const values = view.series.flatMap((line) =>
        line.values.filter((value): value is number => value !== null)
    );
    const top = Math.max(0, ...values);
    const bottom = Math.min(0, ...values);
    const span = top - bottom || 1;
    // Where a value sits, as a share of the plot's height from the top.
    const at = (value: number) => (top - value) / span;
    const zero = at(0);
    const count = view.categories.length;
    // At most about a dozen names under the axis; the rest are read on hover.
    const every = Math.max(1, Math.ceil(count / 12));
    const shown = hover ?? null;
    return (
        <div className="flex min-w-0 flex-col gap-2" role="img" aria-label={label}>
            {view.series.length > 1 ? (
                <ul className="flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {view.series.map((line, index) => (
                        <li key={index} className="flex min-w-0 items-center gap-1.5">
                            <span
                                className="size-2 shrink-0 rounded-full"
                                style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }}
                            />
                            <span className="min-w-0 truncate" title={line.label}>
                                {line.label}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : null}
            <p
                className="min-h-4 min-w-0 truncate text-xs tabular-nums text-muted-foreground"
                aria-live="polite"
            >
                {shown === null
                    ? ""
                    : `${view.categories[shown]}: ${view.series
                          .map(
                              (line) =>
                                  `${view.series.length > 1 ? `${line.label} ` : ""}${format(line.values[shown] ?? null, view.unit)}`
                          )
                          .join(", ")}`}
            </p>
            <div className="flex min-w-0 gap-2">
                <div
                    className="flex shrink-0 flex-col justify-between text-right text-[11px] tabular-nums text-foreground-subtle"
                    style={{ height: HEIGHT }}
                    aria-hidden
                >
                    <span>{format(top, undefined)}</span>
                    {bottom < 0 ? <span>{format(bottom, undefined)}</span> : <span>0</span>}
                </div>
                <div className="relative min-w-0 flex-1" style={{ height: HEIGHT }}>
                    <div
                        className="absolute inset-x-0 border-t border-border"
                        style={{ top: `${zero * 100}%` }}
                        aria-hidden
                    />
                    {view.type === "line" ? (
                        <svg
                            className="absolute inset-0 size-full overflow-visible"
                            viewBox={`0 0 ${count} 100`}
                            preserveAspectRatio="none"
                            aria-hidden
                        >
                            {view.series.map((line, index) => (
                                <path
                                    key={index}
                                    d={linePath(line.values, at)}
                                    fill="none"
                                    stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                                    strokeWidth={2}
                                    vectorEffect="non-scaling-stroke"
                                    strokeLinejoin="round"
                                />
                            ))}
                        </svg>
                    ) : null}
                    <div className="absolute inset-0 flex">
                        {view.categories.map((category, index) => (
                            <div
                                key={index}
                                className={cn(
                                    "relative flex h-full min-w-0 flex-1 justify-center gap-px px-[8%]",
                                    hover === index && "bg-muted/60"
                                )}
                                onPointerEnter={() => setHover(index)}
                                onPointerLeave={() =>
                                    setHover((current) => (current === index ? null : current))
                                }
                                title={category}
                            >
                                {view.type === "bar"
                                    ? view.series.map((line, series) => {
                                          const value = line.values[index];
                                          if (value === null || value === undefined) {
                                              return (
                                                  <span key={series} className="min-w-0 flex-1" />
                                              );
                                          }
                                          const from = Math.min(at(value), zero);
                                          const to = Math.max(at(value), zero);
                                          return (
                                              <span
                                                  key={series}
                                                  className="relative min-w-0 flex-1"
                                              >
                                                  <span
                                                      className="absolute inset-x-0 rounded-sm"
                                                      style={{
                                                          top: `${from * 100}%`,
                                                          height: `max(1px, ${(to - from) * 100}%)`,
                                                          background:
                                                              SERIES_COLORS[
                                                                  series % SERIES_COLORS.length
                                                              ]
                                                      }}
                                                  />
                                              </span>
                                          );
                                      })
                                    : null}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
            <div className="flex min-w-0 gap-2" aria-hidden>
                <span className="invisible shrink-0 text-[11px] tabular-nums">
                    {format(top, undefined)}
                </span>
                <div className="flex min-w-0 flex-1">
                    {view.categories.map((category, index) => (
                        <span
                            key={index}
                            className="min-w-0 flex-1 truncate text-center text-[11px] text-foreground-subtle"
                        >
                            {index % every === 0 ? category : ""}
                        </span>
                    ))}
                </div>
            </div>
        </div>
    );
}

/** One series as a path through the middle of each column; a missing value breaks it. */
function linePath(values: readonly (number | null)[], at: (value: number) => number): string {
    let d = "";
    let open = false;
    values.forEach((value, index) => {
        if (value === null) {
            open = false;
            return;
        }
        d += `${open ? "L" : "M"}${(index + 0.5).toFixed(2)} ${(at(value) * 100).toFixed(2)} `;
        open = true;
    });
    return d.trim();
}
