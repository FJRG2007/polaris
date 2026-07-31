"use client";

/**
 * Reusable consumption-history panel: a range selector (1h/6h/1d/7d/30d or a
 * custom window) over a grid of time-series charts. Shared by Deploy services and
 * Drive devices - both hit an endpoint that returns { points } for the chosen
 * window; this component only picks the range, fetches, and draws.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button, TimeSeriesChart, cn, type GaugeTone, type TimePoint } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { RANGE_ORDER, RANGE_PRESETS, type RangePreset } from "@/lib/metrics-shared";

/** One series returned by the history endpoint. Percentages are derived here. */
interface Point {
    t: number;
    cpuPercent: number | null;
    cpuTempC: number | null;
    memUsedBytes: number | null;
    memTotalBytes: number | null;
    diskUsedBytes: number | null;
    diskTotalBytes: number | null;
}

/** A chart to draw: how to pull a value from a point and how to label it. The
 *  point type defaults to the consumption Point but can be any `{ t }` series
 *  (e.g. the HTTP request/latency series), so one panel drives every history. */
export interface MetricSpec<T = Point> {
    key: string;
    label: string;
    value: (point: T) => number | null;
    format: (value: number) => string;
    tone?: GaugeTone;
    /** The same reading in its own units, shown beside a percentage on hover, e.g.
     *  "6.7 GB / 16 GB" - a percentage alone hides how much that actually is. */
    describe?: (point: T) => string | null;
    /** Fixed Y ceiling (e.g. 100 for a percentage). */
    max?: number;
    /** How the header number summarizes the window (default "last"): "sum" for a
     *  count like requests, "avg" for a rate, "max" for a peak. */
    summary?: "last" | "sum" | "avg" | "max";
}

type Window = { kind: "preset"; preset: RangePreset } | { kind: "custom"; from: number; to: number };

function queryFor(window: Window): string {
    if (window.kind === "preset") return `range=${window.preset}`;
    return `from=${window.from}&to=${window.to}`;
}

/** "YYYY-MM-DDTHH:mm" in local time, for a datetime-local input default. */
function toLocalInput(ms: number): string {
    const date = new Date(ms);
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function MetricsHistory<T extends { t: number } = Point>({
    endpoint,
    metrics
}: {
    endpoint: string;
    metrics: MetricSpec<T>[];
}) {
    const display = useDisplayFormat();
    const [window, setWindow] = useState<Window>({ kind: "preset", preset: "1d" });
    const [customOpen, setCustomOpen] = useState(false);
    const [customFrom, setCustomFrom] = useState(() => toLocalInput(Date.now() - 24 * 3_600_000));
    const [customTo, setCustomTo] = useState(() => toLocalInput(Date.now()));
    const [points, setPoints] = useState<T[] | null>(null);
    const [loading, setLoading] = useState(true);

    const { from, to } = useMemo(() => {
        if (window.kind === "custom") return { from: window.from, to: window.to };
        const now = Date.now();
        return { from: now - RANGE_PRESETS[window.preset], to: now };
    }, [window]);

    const load = useCallback(() => {
        setLoading(true);
        const separator = endpoint.includes("?") ? "&" : "?";
        const controller = new AbortController();
        void fetch(`${endpoint}${separator}${queryFor(window)}`, { cache: "no-store", signal: controller.signal })
            .then((res) => (res.ok ? res.json() : null))
            .then((body) => setPoints(body?.points ?? []))
            .catch(() => undefined)
            .finally(() => setLoading(false));
        return () => controller.abort();
    }, [endpoint, window]);

    useEffect(() => load(), [load]);

    function applyCustom() {
        const fromMs = new Date(customFrom).getTime();
        const toMs = new Date(customTo).getTime();
        if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) {
            setWindow({ kind: "custom", from: fromMs, to: toMs });
        }
    }

    // The hovered point's stamp: on a window longer than a day the time alone
    // would not say which day it belongs to.
    const stampOf = useCallback(
        (at: number): string =>
            to - from > 36 * 3_600_000 ? `${display.date(at)} ${display.time(at)}` : display.time(at),
        [display, from, to]
    );

    return (
        <div className="flex flex-col gap-3 py-2">
            <div className="flex flex-wrap items-center gap-1">
                {RANGE_ORDER.map((preset) => {
                    const active = window.kind === "preset" && window.preset === preset;
                    return (
                        <button
                            key={preset}
                            type="button"
                            onClick={() => {
                                setCustomOpen(false);
                                setWindow({ kind: "preset", preset });
                            }}
                            className={cn(
                                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                                active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                            )}
                        >
                            {preset}
                        </button>
                    );
                })}
                <button
                    type="button"
                    onClick={() => setCustomOpen((value) => !value)}
                    className={cn(
                        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                        window.kind === "custom" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                >
                    Custom
                </button>
                {!loading && (
                    <span className="ml-auto text-xs text-muted-foreground">
                        {points && points.length > 0 ? `${points.length} points` : ""}
                    </span>
                )}
                {loading && <Loader2 className="ml-auto size-3.5 animate-spin text-muted-foreground" />}
            </div>

            {customOpen && (
                <div className="flex flex-wrap items-end gap-2 rounded-md border border-border/60 p-3">
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        From
                        <input
                            type="datetime-local"
                            value={customFrom}
                            onChange={(event) => setCustomFrom(event.target.value)}
                            className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        To
                        <input
                            type="datetime-local"
                            value={customTo}
                            onChange={(event) => setCustomTo(event.target.value)}
                            className="rounded-md border border-input bg-background px-2 py-1 text-sm text-foreground"
                        />
                    </label>
                    <Button variant="outline" onClick={applyCustom}>
                        Apply
                    </Button>
                </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
                {metrics.map((metric) => (
                    <TimeSeriesChart
                        key={metric.key}
                        label={metric.label}
                        points={(points ?? []).map<TimePoint>((point) => ({
                            t: point.t,
                            v: metric.value(point),
                            note: metric.describe?.(point) ?? undefined
                        }))}
                        from={from}
                        to={to}
                        max={metric.max}
                        tone={metric.tone}
                        format={metric.format}
                        formatTime={stampOf}
                        summary={metric.summary}
                    />
                ))}
            </div>
        </div>
    );
}

/**
 * A percentage as it should read at any magnitude. Rounding to whole numbers
 * turned a container using a sliver of host memory into a flat "0%", which reads
 * as "nothing running" rather than "not much" - so anything under 10% keeps the
 * digits that make it a number, and a non-zero value never renders as zero.
 */
export function percent(value: number): string {
    if (!Number.isFinite(value) || value <= 0) return "0%";
    if (value < 0.01) return "<0.01%";
    if (value < 1) return `${value.toFixed(2)}%`;
    if (value < 10) return `${value.toFixed(1)}%`;
    return `${Math.round(value)}%`;
}

/** Percentage of used/total, or null when either side is missing. */
export function ratioPercent(used: number | null, total: number | null): number | null {
    if (used == null || total == null || total <= 0) return null;
    return (used / total) * 100;
}
