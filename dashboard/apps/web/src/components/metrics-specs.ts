/**
 * What a consumption chart draws, without the chart.
 *
 * Split from `metrics-history` so that the specs a screen hands the chart can be
 * had without the chart itself: the panel that draws them is loaded when it is
 * first drawn, and the specs are needed at the moment the screen renders.
 */

import { formatBytes } from "@polaris/core";
import type { GaugeTone } from "@polaris/ui";

/** One series returned by the history endpoint. Percentages are derived here. */
export interface ConsumptionPoint {
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
export interface MetricSpec<T = ConsumptionPoint> {
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
    /**
     * What is behind this number, for the metrics that have an answer.
     *
     * Only where there is one. Every chart looking openable and half of them
     * opening a panel that says "nothing to show here" teaches a reader to stop
     * clicking, so a metric with nothing behind it stays exactly the chart it was.
     * The window is handed over because a breakdown answers for the range on
     * screen, not for this instant.
     */
    breakdown?: {
        /** The words on the strip under the chart - what it will answer. */
        label: string;
        open: (window: { from: number; to: number }) => void;
    };
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

/** How many were playing, drawn by the same component as everything else. One
 *  line, because the question is one question. */
export const PLAYER_METRICS: MetricSpec<{ t: number; players: number | null }>[] = [
    {
        key: "players",
        label: "Players",
        value: (point) => point.players,
        format: (value) => (value === 1 ? "1 player" : `${Math.round(value)} players`),
        tone: "primary",
        // The peak is what somebody asks a player chart: the last reading is
        // whoever happens to be on right now, which the panel already says.
        summary: "max"
    }
];

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
        // A chart per direction rather than one with the other on hover: out is
        // what a home connection runs out of first, and in is what a service
        // being pulled from - a download mirror, a game world being fetched - is
        // watched for, and neither is readable as a number on hover.
        key: "net",
        label: "Bandwidth out",
        value: (point) => point.netTxBytesPerSecond,
        format: formatRate,
        tone: "primary",
        summary: "max"
    },
    {
        key: "net-in",
        label: "Bandwidth in",
        value: (point) => point.netRxBytesPerSecond,
        format: formatRate,
        tone: "success",
        summary: "max"
    }
];
