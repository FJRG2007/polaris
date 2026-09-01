"use client";

/**
 * What the database is doing, while you watch it.
 *
 * The readings are taken here rather than stored: the panel polls, keeps the last
 * few minutes in memory and draws that. A table of samples would mean a
 * background job holding a connection open to every database anybody has ever
 * added, forever, for charts nobody is looking at - and the interesting window
 * when somebody opens this screen is the one that starts when they open it.
 *
 * Counters become rates. `total_commands_processed` climbing by six hundred
 * between two readings eight seconds apart is seventy-five commands a second,
 * which is the number somebody actually wants; the raw total is a number that
 * only goes up and says nothing. A counter that goes backwards is a restart, and
 * the gap is drawn as a gap rather than as a fall to zero.
 *
 * The hit rate is the one derived figure worth its own chart: hits against hits
 * plus misses over the same interval, which is the difference between a cache
 * doing its job and one being read straight through.
 *
 * **A rate needs two readings, and that used to mean an empty panel for the
 * first ten seconds.** The first pair is now taken a second apart and the poll
 * settles to its real cadence afterwards, so there is a line almost at once; and
 * while there is only one reading the panel says what it is waiting for rather
 * than showing an empty chart, which reads as a database doing nothing.
 *
 * **Two things here are not rates at all.** What is taking up the room, and what
 * the engine is asked most often, are the questions somebody opens this screen
 * with when a disk is filling or a page is slow - and neither is a counter
 * climbing. They are read once when the panel opens rather than on the poll:
 * both change over hours, and a catalogue scan every five seconds for a chart
 * nobody is watching change would make this panel the load it is measuring.
 */

import * as actions from "./actions";
import { formatBytes } from "@polaris/core";
import { grouped } from "@/app/(app)/apps/firewall/page-parts";
import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { DatabaseStats, StatValue } from "@/lib/data/stats";
import type { DatabaseInsights } from "@/lib/data/insights";
import { Button, Card, CardBody, Select, TimeSeriesChart, cn, type TimePoint } from "@polaris/ui";

/** How often a reading is taken. Fast enough to watch something happen, slow
 *  enough that the panel is not itself the load. */
const POLL_MS = 5000;

/**
 * How long after the first reading the second is taken.
 *
 * A rate is the difference between two readings, so one reading draws nothing -
 * and at the normal cadence that meant an empty panel for the first ten seconds,
 * which is what "Activity takes too long to load" actually was. The second
 * reading is taken almost at once so there is a line to look at, and the poll
 * settles to its real interval from there. One extra query per visit.
 */
const FIRST_PAIR_MS = 1000;

/** How many readings are kept. Twenty minutes at the default cadence, which is
 *  long enough to see a spike arrive and pass. */
const KEPT = 240;

interface Reading {
    at: number;
    gauges: Record<string, number>;
    counters: Record<string, number>;
    units: Record<string, StatValue["unit"]>;
    labels: Record<string, string>;
}

/** The rate charts, engine by engine: which counters make a rate worth drawing,
 *  and which pair makes a hit rate. Everything else is drawn as a gauge. */
const RATES: Record<string, { keys: string[]; hitRate?: [string, string] }> = {
    redis: { keys: ["commands", "hits", "misses", "expired", "evicted"], hitRate: ["hits", "misses"] },
    postgres: {
        keys: ["commits", "rollbacks", "returned", "inserted", "updated", "deleted"],
        hitRate: ["hits", "misses"]
    },
    mysql: { keys: ["questions", "selects", "writes", "slow"], hitRate: ["hits", "misses"] },
    mariadb: { keys: ["questions", "selects", "writes", "slow"], hitRate: ["hits", "misses"] },
    mongo: { keys: ["query", "insert", "update", "delete", "getmore"] }
};

export function StatsPanel({ connectionId }: { connectionId: string }) {
    const [readings, setReadings] = useState<Reading[]>([]);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [engine, setEngine] = useState("");
    const [chosen, setChosen] = useState<string>("");
    /** What is in here and what it is asked, read once on the way in. Null until
     *  the answer lands, which is what draws the skeleton rather than an empty
     *  chart. */
    const [insights, setInsights] = useState<DatabaseInsights | null>(null);
    // Kept in a ref as well so the timer below reads the current one without
    // being rebuilt - a poll that restarts on every reading is a poll that
    // never fires at the interval it says it does.
    const running = useRef(false);

    const sample = useCallback(async () => {
        if (running.current) return;
        running.current = true;
        setBusy(true);
        const result = await actions.statsAction(connectionId);
        running.current = false;
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return;
        }
        const stats = result.stats;
        if (!stats) return;
        setError("");
        setEngine(stats.engine);
        setReadings((current) => [...current, toReading(stats)].slice(-KEPT));
    }, [connectionId]);

    useEffect(() => {
        setReadings([]);
        void sample();
        // The second one quickly, so there is a rate to draw; then the real
        // cadence. Both are cleared together, so leaving the panel mid-pair does
        // not leave a timer behind.
        const soon = setTimeout(() => void sample(), FIRST_PAIR_MS);
        const timer = setInterval(() => void sample(), POLL_MS);
        return () => {
            clearTimeout(soon);
            clearInterval(timer);
        };
    }, [sample]);

    // Once, when the panel opens. Not on the poll: see the note at the top.
    useEffect(() => {
        let alive = true;
        setInsights(null);
        void actions.insightsAction(connectionId).then((result) => {
            if (!alive) return;
            // A failure here is not the panel's failure. The rates above are
            // still worth watching, and an engine that will not answer this is
            // said in the section itself.
            setInsights(result.insights ?? { biggest: [], frequent: [], frequentUnavailable: "" });
        });
        return () => {
            alive = false;
        };
    }, [connectionId]);

    const latest = readings[readings.length - 1];
    const rates = RATES[engine] ?? { keys: [] };
    const rateKeys = rates.keys.filter((key) => latest?.counters[key] !== undefined);
    const shown = chosen || rateKeys[0] || "";

    if (!latest) {
        return (
            <Card>
                <CardBody className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
                    {error ? (
                        <span className="text-danger">{error}</span>
                    ) : (
                        <>
                            <Loader2 className="size-4 animate-spin" />
                            Taking the first reading. A rate is the difference between two, so the
                            charts appear a moment after this one.
                        </>
                    )}
                </CardBody>
            </Card>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            {error && (
                <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-sm text-danger">
                    {error}
                </p>
            )}

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {Object.keys(latest.gauges).map((key) => (
                    <Card key={key}>
                        <CardBody className="flex flex-col gap-0.5 p-3">
                            <span className="truncate text-xs text-muted-foreground">
                                {latest.labels[key]}
                            </span>
                            <span className="text-lg font-semibold tabular-nums">
                                {format(latest.gauges[key] ?? 0, latest.units[key] ?? "count")}
                            </span>
                        </CardBody>
                    </Card>
                ))}
            </div>

            {rateKeys.length > 0 && (
                <Card>
                    <CardBody className="flex flex-col gap-3">
                        <div className="flex items-center gap-2">
                            <Select
                                className="w-56"
                                value={shown}
                                onValueChange={setChosen}
                                aria-label="Which rate to draw"
                                options={rateKeys.map((key) => ({
                                    value: key,
                                    label: `${latest.labels[key]} a second`
                                }))}
                            />
                            <span className="text-xs text-muted-foreground">
                                {readings.length} readings, {POLL_MS / 1000}s apart
                            </span>
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                title="Take one now"
                                aria-label="Take a reading now"
                                onClick={() => void sample()}
                            >
                                {busy ? (
                                    <Loader2 className="size-4 animate-spin" />
                                ) : (
                                    <RefreshCw className="size-4" />
                                )}
                            </Button>
                        </div>
                        <TimeSeriesChart
                            points={ratePoints(readings, shown)}
                            from={readings[0]?.at ?? latest.at}
                            to={latest.at}
                            label={`${latest.labels[shown] ?? shown} a second`}
                            format={(value) => value.toFixed(value < 10 ? 1 : 0)}
                        />
                    </CardBody>
                </Card>
            )}

            {rates.hitRate && (
                <Card>
                    <CardBody className="flex flex-col gap-3">
                        <span className="text-xs text-muted-foreground">
                            Hit rate - how much of what was asked for was already in memory
                        </span>
                        <TimeSeriesChart
                            points={hitRatePoints(readings, rates.hitRate)}
                            from={readings[0]?.at ?? latest.at}
                            to={latest.at}
                            label="Hit rate"
                            max={100}
                            format={(value) => `${value.toFixed(1)}%`}
                        />
                    </CardBody>
                </Card>
            )}

            <BiggestPanel insights={insights} />
            <FrequentPanel insights={insights} />
        </div>
    );
}

/**
 * A bar in a list, drawn as a share of the largest.
 *
 * Deliberately not a chart component: ten labelled bars where the label is the
 * thing being measured is a list, and a list is what somebody reads down looking
 * for a name they recognise. A pie of ten tables is unreadable, and a time series
 * of a number that changes hourly is a flat line.
 */
function Bar({
    label,
    value,
    of,
    caption,
    title
}: {
    label: string;
    value: number;
    /** The largest in the set, which is what the width is a share of. */
    of: number;
    caption: string;
    title?: string;
}) {
    // A zero-width bar for the smallest row reads as "nothing", so everything
    // that exists at all gets a sliver.
    const share = of > 0 ? Math.max(2, Math.round((value / of) * 100)) : 0;
    return (
        <div className="flex flex-col gap-0.5">
            <div className="flex items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={title ?? label}>
                    {label}
                </span>
                <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{caption}</span>
            </div>
            <div className="bg-border h-1.5 overflow-hidden rounded-full">
                <div className="bg-primary h-full rounded-full" style={{ width: `${share}%` }} />
            </div>
        </div>
    );
}

/** What a section looks like while its one read is in flight, and when it has
 *  nothing to say. */
function InsightCard({
    title,
    note,
    insights,
    empty,
    children
}: {
    title: string;
    note?: string;
    insights: DatabaseInsights | null;
    empty: string;
    children: ReactNode;
}) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h3 className="text-sm font-medium">{title}</h3>
                    {note ? <p className="text-muted-foreground text-xs">{note}</p> : null}
                </div>
                {insights === null ? (
                    <div className="flex flex-col gap-2" aria-hidden="true">
                        {[0, 1, 2, 3].map((row) => (
                            <div key={row} className={cn("bg-muted h-6 animate-pulse rounded")} />
                        ))}
                    </div>
                ) : (
                    (children ?? <p className="text-muted-foreground text-xs">{empty}</p>)
                )}
            </CardBody>
        </Card>
    );
}

/** Where the room is going. The question somebody opens this screen with when a
 *  disk is filling, and the one a rate cannot answer. */
function BiggestPanel({ insights }: { insights: DatabaseInsights | null }) {
    const rows = insights?.biggest ?? [];
    if (insights !== null && rows.length === 0) return null;
    const largest = rows[0]?.bytes ?? 0;
    return (
        <InsightCard
            title="Biggest tables"
            note="Table, indexes and out-of-line storage together - what the table actually costs."
            insights={insights}
            empty="Nothing to measure yet."
        >
            {rows.length > 0 ? (
                <div className="flex flex-col gap-2">
                    {rows.map((row) => (
                        <Bar
                            key={row.name}
                            label={row.name}
                            value={row.bytes}
                            of={largest}
                            caption={
                                row.rows === null
                                    ? formatBytes(row.bytes)
                                    : `${formatBytes(row.bytes)} - about ${grouped(row.rows)} rows`
                            }
                        />
                    ))}
                </div>
            ) : null}
        </InsightCard>
    );
}

/**
 * What the engine is asked most often.
 *
 * Only where the engine records it, and it says which thing is missing when it
 * does not - Postgres needs an extension, MySQL needs the performance schema, and
 * on a managed database neither is something the person reading this can turn on.
 * A sentence naming it is worth more than an empty chart, which reads as a
 * database doing nothing.
 *
 * The statements are the engine's own normalized forms: the literals have already
 * been replaced by the server, so nothing here prints somebody's data back at
 * them.
 */
function FrequentPanel({ insights }: { insights: DatabaseInsights | null }) {
    const rows = insights?.frequent ?? [];
    const unavailable = insights?.frequentUnavailable ?? "";
    if (insights !== null && rows.length === 0 && !unavailable) return null;
    const most = rows[0]?.calls ?? 0;
    return (
        <InsightCard
            title="Most repeated statements"
            note="Counted by the engine since it last started, with the values already stripped out."
            insights={insights}
            empty={unavailable || "Nothing recorded yet."}
        >
            {rows.length > 0 ? (
                <div className="flex flex-col gap-2">
                    {rows.map((row) => (
                        <Bar
                            key={row.statement}
                            label={row.statement}
                            title={row.statement}
                            value={row.calls}
                            of={most}
                            caption={
                                row.totalMs === null
                                    ? `${grouped(row.calls)} calls`
                                    : `${grouped(row.calls)} calls - ${grouped(row.totalMs)}ms total`
                            }
                        />
                    ))}
                </div>
            ) : null}
        </InsightCard>
    );
}

function toReading(stats: DatabaseStats): Reading {
    const reading: Reading = { at: stats.at, gauges: {}, counters: {}, units: {}, labels: {} };
    for (const value of stats.gauges) {
        reading.gauges[value.key] = value.value;
        reading.units[value.key] = value.unit;
        reading.labels[value.key] = value.label;
    }
    for (const value of stats.counters) {
        reading.counters[value.key] = value.value;
        reading.units[value.key] = value.unit;
        reading.labels[value.key] = value.label;
    }
    return reading;
}

/** A counter turned into a rate: the difference over the seconds between the two
 *  readings it came from. */
function ratePoints(readings: readonly Reading[], key: string): TimePoint[] {
    const points: TimePoint[] = [];
    for (let index = 1; index < readings.length; index += 1) {
        const previous = readings[index - 1] as Reading;
        const current = readings[index] as Reading;
        const seconds = (current.at - previous.at) / 1000;
        const delta = (current.counters[key] ?? 0) - (previous.counters[key] ?? 0);
        // A counter that went backwards is a server that restarted. There is no
        // rate to report for that interval, and drawing the fall as traffic would
        // be worse than drawing nothing.
        points.push({ t: current.at, v: seconds > 0 && delta >= 0 ? delta / seconds : null });
    }
    return points;
}

/** Hits over hits plus misses, per interval rather than since the server
 *  started: a lifetime ratio barely moves and hides the ten minutes that
 *  matter. */
function hitRatePoints(readings: readonly Reading[], pair: [string, string]): TimePoint[] {
    const points: TimePoint[] = [];
    for (let index = 1; index < readings.length; index += 1) {
        const previous = readings[index - 1] as Reading;
        const current = readings[index] as Reading;
        const hits = (current.counters[pair[0]] ?? 0) - (previous.counters[pair[0]] ?? 0);
        const misses = (current.counters[pair[1]] ?? 0) - (previous.counters[pair[1]] ?? 0);
        const total = hits + misses;
        points.push({
            t: current.at,
            // Nothing was asked for in that interval, so there is no rate. Null
            // rather than 100%, which would read as a cache doing well while it
            // was doing nothing.
            v: hits < 0 || misses < 0 || total <= 0 ? null : (hits / total) * 100
        });
    }
    return points;
}

function format(value: number, unit: StatValue["unit"]): string {
    if (unit === "bytes") return formatBytes(value);
    if (unit === "percent") return `${value.toFixed(1)}%`;
    if (unit === "ms") return `${value.toFixed(1)}ms`;
    if (!Number.isInteger(value)) return value.toFixed(2);
    return value.toLocaleString("en-US");
}
