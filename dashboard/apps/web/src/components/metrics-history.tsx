"use client";

/**
 * Reusable consumption-history panel: a range selector (1h/6h/1d/7d/30d or a
 * custom window) over a grid of time-series charts. Shared by Deploy services and
 * Drive devices - both hit an endpoint that returns { points } for the chosen
 * window; this component only picks the range, fetches, and draws.
 */

import {
    CONSUMPTION_METRICS,
    formatRate,
    percent,
    PLAYER_METRICS,
    ratioPercent,
    type ConsumptionPoint,
    type MetricSpec
} from "@/components/metrics-specs";
import { ChevronRight, Loader2 } from "lucide-react";
import { useDisplayFormat } from "@/components/display-format";
import { readSnapshot, writeSnapshot } from "@/lib/snapshot-cache";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, TimeSeriesChart, cn, type TimePoint } from "@polaris/ui";
import {
    LIVE_INTERVAL_MS,
    RANGE_ORDER,
    RANGE_PRESETS,
    RAW_MAX_SPAN_MS,
    type RangePreset
} from "@/lib/metrics-shared";

type Point = ConsumptionPoint;

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
    metrics,
    live
}: {
    endpoint: string;
    metrics: MetricSpec<T>[];
    /** A stream that says `tick` when the collector wrote new samples for this
     *  subject. While it is connected the charts re-read on each tick instead of
     *  polling; without one, or while it is down, they poll as before. */
    live?: string;
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
    // Whether the collector is telling this panel when to re-read.
    const [pushed, setPushed] = useState(false);
    const lastLoad = useRef(0);

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
            lastLoad.current = at;
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
            // Pushed to: the ticks below are the cadence, and a timer beside them
            // would only re-read what the last tick already drew.
            if (timer === null && !pushed) timer = setInterval(() => load(true), every);
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
    }, [window, load, pushed]);

    /**
     * Re-read when the collector says it wrote something for this subject.
     *
     * A window of raw samples gains a point on every tick, so it re-reads on every
     * one. A wide window reads hourly rollups that a tick does not change, so it
     * re-reads no more often than it used to poll. A hidden tab skips the tick and
     * catches up when it is shown, through the visibility handler above.
     */
    const onTick = useRef<() => void>(() => undefined);
    onTick.current = () => {
        if (window.kind === "custom" || document.visibilityState !== "visible") return;
        const raw = RANGE_PRESETS[window.preset] <= RAW_MAX_SPAN_MS;
        if (raw || Date.now() - lastLoad.current >= LIVE_INTERVAL_MS[window.preset]) load(true);
    };

    useEffect(() => {
        if (!live || typeof EventSource === "undefined") return;
        const source = new EventSource(live);
        source.addEventListener("ready", () => setPushed(true));
        source.addEventListener("tick", () => onTick.current());
        // Dropped: poll until the browser has it back and it says ready again.
        source.onerror = () => setPushed(false);
        return () => {
            source.close();
            setPushed(false);
        };
    }, [live]);

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
                        {points && points.length > 0
                            ? `${points.length} points${pushed && window.kind === "preset" ? " - live" : ""}`
                            : ""}
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
                            className="rounded-md border border-border bg-field px-2 py-1 text-sm text-foreground"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        To
                        <input
                            type="datetime-local"
                            value={customTo}
                            onChange={(event) => setCustomTo(event.target.value)}
                            className="rounded-md border border-border bg-field px-2 py-1 text-sm text-foreground"
                        />
                    </label>
                    <Button variant="outline" onClick={applyCustom}>
                        Apply
                    </Button>
                </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
                {metrics.map((metric) => {
                    const breakdown = metric.breakdown;
                    const chart = (
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
                            // Joined to the strip below rather than floated above
                            // it: two stacked cards read as two things, and this
                            // is one card with a way in at the bottom.
                            className={breakdown ? "rounded-b-none border-b-0" : undefined}
                        />
                    );
                    if (!breakdown) return chart;
                    return (
                        <div key={metric.key} className="flex flex-col">
                            {chart}
                            {/* Its own control rather than the whole card: pressing
                                the plot is how the value under the pointer is read,
                                and on a phone that is the only way. */}
                            <button
                                type="button"
                                onClick={() => breakdown.open({ from, to })}
                                className="flex items-center justify-between gap-2 rounded-b-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                {breakdown.label}
                                <ChevronRight className="size-3.5 shrink-0" />
                            </button>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/** Re-exported for the screens that already take them from here. */
export { CONSUMPTION_METRICS, formatRate, percent, PLAYER_METRICS, ratioPercent, type MetricSpec };
