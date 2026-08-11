"use client";

/**
 * Reusable consumption-history panel: a range selector (1h/6h/1d/7d/30d or a
 * custom window) over a grid of time-series charts. Shared by Deploy services and
 * Drive devices - both hit an endpoint that returns { points } for the chosen
 * window; this component only picks the range, fetches, and draws.
 */

import { Loader2 } from "lucide-react";
import { formatBytes } from "@polaris/core";
import { useDisplayFormat } from "@/components/display-format";
import { useCallback, useEffect, useMemo, useState } from "react";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import { Button, TimeSeriesChart, cn, type GaugeTone, type TimePoint } from "@polaris/ui";
import { LIVE_INTERVAL_MS, RANGE_ORDER, RANGE_PRESETS, type RangePreset } from "@/lib/metrics-shared";

/** One series returned by the history endpoint. Percentages are derived here. */
interface Point {
    t: number;
    cpuPercent: number | null;
    cpuTempC: number | null;
    memUsedBytes: number | null;
    memTotalBytes: number | null;
    diskUsedBytes: number | null;
    diskTotalBytes: number | null;
    netRxBytesPerSecond: number | null;
    netTxBytesPerSecond: number | null;
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

/** How long a kept window is still worth painting while the fresh one is fetched.
 *
 *  A custom window is pinned to two absolute instants, so what was drawn in it is
 *  what would be drawn in it now - it only expires because a day-old copy of
 *  anything is no longer worth the storage. A preset window slides with the
 *  clock: kept long enough, its points fall off the left of the axis they would be
 *  drawn against, and a chart of data that is all off-screen reads as a chart with
 *  no data. A quarter of the span is the point at which what is kept still fills
 *  most of it. */
const KEPT_MAX_AGE_MS = 24 * 3_600_000;

function keptWindowLimit(window: Window): number {
    return window.kind === "custom" ? KEPT_MAX_AGE_MS : Math.min(KEPT_MAX_AGE_MS, RANGE_PRESETS[window.preset] / 4);
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
    // When the shown data was fetched. A preset window is relative to "now", so
    // it has to move with each refresh - otherwise the points keep arriving while
    // the X axis stays where it was and the newest ones fall off the right edge.
    const [fetchedAt, setFetchedAt] = useState(() => Date.now());

    const { from, to } = useMemo(() => {
        if (window.kind === "custom") return { from: window.from, to: window.to };
        return { from: fetchedAt - RANGE_PRESETS[window.preset], to: fetchedAt };
    }, [window, fetchedAt]);

    // One key per subject and window, so switching range or opening a different
    // subject reads back that combination rather than the last one drawn.
    const keptKey = `metrics.${endpoint}.${queryFor(window)}`;

    /** One fetch. `quiet` refreshes in place: a periodic tick must not blank the
     *  charts into a loading state every time it runs. */
    const load = useCallback(
        (quiet = false) => {
            if (!quiet) setLoading(true);
            const separator = endpoint.includes("?") ? "&" : "?";
            const controller = new AbortController();
            const at = Date.now();
            void fetch(`${endpoint}${separator}${queryFor(window)}`, { cache: "no-store", signal: controller.signal })
                .then((res) => (res.ok ? res.json() : null))
                .then((body) => {
                    const fetched = (body?.points ?? []) as T[];
                    setPoints(fetched);
                    setFetchedAt(at);
                    writeSnapshot(keptKey, fetched);
                })
                .catch(() => undefined)
                .finally(() => {
                    if (!quiet) setLoading(false);
                });
            return () => controller.abort();
        },
        [endpoint, window, keptKey]
    );

    /**
     * Draw the window as it was last seen, then fetch it again.
     *
     * A history chart is a database read behind a network round trip, and until it
     * lands there is nothing to draw - which is why every one of these used to
     * open as an empty frame with a spinner in the corner. The last answer for
     * this exact subject and range is kept in the tab, so a revisit, a range the
     * operator has already been on, or a second panel showing the same subject
     * paints the shape immediately and the fetch behind it only moves the line.
     *
     * The axis is set back to when the kept points were taken, not to now: drawing
     * an hour-old window against this instant's axis would shift every point off
     * its own timestamp, and the fetch that follows puts both right together.
     */
    useEffect(() => {
        const kept = readSnapshot<T[]>(keptKey, keptWindowLimit(window));
        if (kept) {
            setPoints(kept.value);
            setFetchedAt(kept.at);
            setLoading(false);
        } else {
            setPoints(null);
        }
        return load(kept !== null);
    }, [keptKey, window, load]);

    /**
     * Keep the window current without a reload. A live window is re-fetched on a
     * cadence proportional to its own resolution - a 30-day chart gains nothing
     * from a poll every 15 seconds - and a custom window pinned to the past is
     * not polled at all, because it cannot change.
     *
     * Polling stops while the tab is hidden and catches up on return, so a
     * dashboard left open overnight is not still asking every 15 seconds.
     */
    useEffect(() => {
        if (window.kind === "custom") return;
        const every = LIVE_INTERVAL_MS[window.preset];
        if (!every) return;

        let timer: ReturnType<typeof setInterval> | null = null;
        const start = (): void => {
            if (timer === null) timer = setInterval(() => load(true), every);
        };
        const stop = (): void => {
            if (timer !== null) {
                clearInterval(timer);
                timer = null;
            }
        };
        const onVisibility = (): void => {
            if (document.visibilityState === "visible") {
                load(true);
                start();
            } else {
                stop();
            }
        };

        if (document.visibilityState === "visible") start();
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            stop();
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [window, load]);

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

/** Bytes per second, as somebody reading a bandwidth chart says it. */
export function formatRate(value: number): string {
    return `${formatBytes(value)}/s`;
}

/**
 * What something costs, as every screen that charts consumption shows it.
 *
 * Four questions, because the first two never answered the ones people actually
 * arrive with. A game server is CPU and memory while it is running, and disk and
 * bandwidth for as long as it exists: a world grows until a volume is full, and a
 * server full of players is the largest thing on a home connection. CPU alone said
 * none of that.
 *
 * Memory and disk are charted in bytes rather than as a share, with the share on
 * hover: against a host's total, a container using a few hundred megabytes is a
 * flat zero line, which reads as "nothing running" instead of "not much". A server
 * and a service are measured differently but presented identically on purpose -
 * the question is the same one, and two shapes for it would only invite comparing
 * a percentage against a byte count.
 *
 * Disk and bandwidth chart nothing at all where nothing is measured, rather than
 * a zero: a service with no volume is not a service storing nothing.
 */
export const CONSUMPTION_METRICS: MetricSpec[] = [
    { key: "cpu", label: "CPU", value: (point) => point.cpuPercent, format: percent, tone: "primary", max: 100 },
    {
        key: "mem",
        label: "Memory",
        value: (point) => point.memUsedBytes,
        describe: (point) => {
            const share = ratioPercent(point.memUsedBytes, point.memTotalBytes);
            return share === null || point.memTotalBytes === null
                ? null
                : `${percent(share)} of ${formatBytes(point.memTotalBytes)}`;
        },
        format: formatBytes,
        tone: "success"
    },
    {
        key: "disk",
        label: "Storage",
        value: (point) => point.diskUsedBytes,
        describe: (point) => {
            const share = ratioPercent(point.diskUsedBytes, point.diskTotalBytes);
            return share === null || point.diskTotalBytes === null
                ? null
                : `${percent(share)} of ${formatBytes(point.diskTotalBytes)}`;
        },
        format: formatBytes,
        tone: "warning"
    },
    {
        // One chart for both directions would need two lines; the number people
        // are actually watching for is how much is going out, because that is the
        // half a home connection runs out of first. In is on hover beside it.
        key: "net",
        label: "Bandwidth out",
        value: (point) => point.netTxBytesPerSecond,
        describe: (point) =>
            point.netRxBytesPerSecond === null ? null : `${formatRate(point.netRxBytesPerSecond)} in`,
        format: formatRate,
        tone: "primary",
        summary: "max"
    }
];
