/**
 * What each alarm metric measures, in which unit, and on which targets.
 *
 * One table for the form, the validation and the evaluator, so a metric cannot
 * be offered on a target the evaluator has no reading for, or judged in a unit
 * the form did not ask for.
 *
 * Disk is the metric with two units. A server's disk has a size, so how full it
 * is reads as a share of it. A service's disk is the volumes it mounts, and most
 * of those have no declared size - a share of "unlimited" is no number at all -
 * so a service is judged on how much its volumes hold.
 *
 * Network is judged as a rate: the database keeps counters that only ever climb,
 * so the rate is worked out from the last two readings and the gap between them.
 *
 * Pure - no Prisma - so the client form and the server evaluator share it.
 */

import { counterRate } from "@/lib/metrics-shared";

export const ALARM_TARGET_TYPES = ["application", "host", "domain"] as const;
export const ALARM_METRICS = ["cpu", "memory", "disk", "network_in", "network_out", "service", "http"] as const;

export type AlarmTargetType = (typeof ALARM_TARGET_TYPES)[number];
export type AlarmMetric = (typeof ALARM_METRICS)[number];
export type AlarmUnit = "%" | "GB" | "MB/s";

export const METRIC_LABEL: Record<AlarmMetric, string> = {
    cpu: "CPU",
    memory: "Memory",
    disk: "Disk",
    network_in: "Network in",
    network_out: "Network out",
    service: "Service up",
    http: "Reachable"
};

const BY_TARGET: Record<AlarmTargetType, readonly AlarmMetric[]> = {
    application: ["cpu", "memory", "disk", "network_in", "network_out", "service"],
    host: ["cpu", "memory", "disk", "network_in", "network_out"],
    domain: ["http"]
};

/** The metrics a target can be watched on. */
export function metricsFor(targetType: AlarmTargetType): readonly AlarmMetric[] {
    return BY_TARGET[targetType];
}

/** The unit a threshold is given in, or null for a metric judged up or down. */
export function alarmUnit(metric: string, targetType: string): AlarmUnit | null {
    if (metric === "cpu" || metric === "memory") return "%";
    if (metric === "disk") return targetType === "host" ? "%" : "GB";
    if (metric === "network_in" || metric === "network_out") return "MB/s";
    return null;
}

/** Where the form starts a threshold, per unit. */
export function defaultThreshold(metric: string, targetType: string): number {
    if (metric === "disk") return targetType === "host" ? 90 : 10;
    return alarmUnit(metric, targetType) === "MB/s" ? 10 : 80;
}

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/** Readings further apart than this are not one rate: whatever happened in the
 *  gap is not in either of them. */
export const MAX_RATE_GAP_MS = 5 * 60_000;

/** The columns of a metric sample a threshold is judged on. */
export interface SampleReading {
    readonly ts: Date;
    readonly cpuPercent: number | null;
    readonly memUsedBytes: bigint | null;
    readonly memTotalBytes: bigint | null;
    readonly diskUsedBytes: bigint | null;
    readonly diskTotalBytes: bigint | null;
    readonly netRxBytes: bigint | null;
    readonly netTxBytes: bigint | null;
}

function share(used: bigint | null, total: bigint | null): number | null {
    return used !== null && total !== null && total > 0n ? (Number(used) / Number(total)) * 100 : null;
}

/**
 * A subject's own sample as the metric's value, in the metric's unit. Null when
 * the sample does not carry it - a remote server's disk is not measured, and a
 * rate needs a reading close enough before this one.
 *
 * Not for a service's disk, which is its volumes rather than its own column - see
 * `volumeDiskGb`.
 */
export function sampleValue(metric: string, latest: SampleReading, previous: SampleReading | null): number | null {
    if (metric === "cpu") return latest.cpuPercent;
    if (metric === "memory") return share(latest.memUsedBytes, latest.memTotalBytes);
    if (metric === "disk") return share(latest.diskUsedBytes, latest.diskTotalBytes);
    if (metric === "network_in" || metric === "network_out") {
        if (!previous) return null;
        const gap = latest.ts.getTime() - previous.ts.getTime();
        if (gap > MAX_RATE_GAP_MS) return null;
        const rate =
            metric === "network_in"
                ? counterRate(previous.netRxBytes, latest.netRxBytes, gap)
                : counterRate(previous.netTxBytes, latest.netTxBytes, gap);
        return rate === null ? null : rate / MIB;
    }
    return null;
}

/** What a service's volumes hold together, in GB. Null when none was measured. */
export function volumeDiskGb(readings: readonly { diskUsedBytes: bigint | null }[]): number | null {
    const present = readings.map((reading) => reading.diskUsedBytes).filter((value): value is bigint => value !== null);
    if (present.length === 0) return null;
    return Number(present.reduce((total, value) => total + value, 0n)) / GIB;
}

export function breaches(value: number, operator: string, threshold: number): boolean {
    return operator === "lt" ? value < threshold : value > threshold;
}

/** A value in its unit, for an event line and a notification. */
export function formatAlarmValue(value: number, unit: AlarmUnit): string {
    return unit === "%" ? `${value.toFixed(1)}%` : `${value.toFixed(2)} ${unit}`;
}

/** A threshold as it was typed, with its unit: "> 90%", "< 2.5 GB". */
export function formatThreshold(operator: string, threshold: number, unit: AlarmUnit | null): string {
    const amount = unit === "%" ? `${threshold}%` : `${threshold} ${unit ?? ""}`.trim();
    return `${operator === "lt" ? "<" : ">"} ${amount}`;
}

/** "Disk > 90%", "Network in > 10 MB/s". */
export function describeThreshold(metric: string, targetType: string, operator: string, threshold: number): string {
    const label = METRIC_LABEL[metric as AlarmMetric] ?? metric;
    return `${label} ${formatThreshold(operator, threshold, alarmUnit(metric, targetType))}`;
}
