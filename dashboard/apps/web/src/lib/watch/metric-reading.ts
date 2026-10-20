/**
 * The latest value of a metric for a service or a server, read from its
 * samples - shared by Watch's alarm evaluator and the Automations threshold
 * trigger, so both judge the same number from the same rows.
 *
 * A reading carries the time of the sample it came from: a poller that runs
 * faster than the samples arrive must not count one sample twice toward a
 * streak.
 */

import { prisma } from "@polaris/db";
import { sampleValue, volumeDiskGb } from "./alarm-metrics";
import { isLocalMachine, type LocalMachineIdentity } from "@/lib/local-machine";
import { COLLECT_TICK_MS, LOCAL_HOST_SUBJECT, STORAGE_EVERY_TICKS } from "@/lib/metrics-shared";

export const RECENT_SAMPLE_MS = 3 * 60_000;
/** Volumes are measured on the slower storage cadence; three of those missed in a
 *  row is a volume nothing can read, rather than one between measurements. */
export const RECENT_VOLUME_MS = 3 * STORAGE_EVERY_TICKS * COLLECT_TICK_MS;

/** A value and when it was sampled, or why there is none. */
export type MetricReading = { readonly value: number; readonly at: Date } | string;

export interface MetricSubject {
    readonly type: "app" | "host";
    readonly id: string;
}

/**
 * Where a server's samples are filed: the machine Polaris runs on is under
 * its reserved subject whichever way it is named.
 */
export function hostSubject(
    hostId: string,
    host: { id: string; dockerId: string | null; address: string | null } | null,
    identity: LocalMachineIdentity | null
): MetricSubject {
    if (hostId === LOCAL_HOST_SUBJECT) return { type: "host", id: LOCAL_HOST_SUBJECT };
    const local = host && identity ? isLocalMachine(host, identity) : false;
    return { type: "host", id: local ? LOCAL_HOST_SUBJECT : hostId };
}

/** The metric from the subject's latest sample, or why there is none. */
export async function latestMetricValue(
    subject: MetricSubject,
    metric: string,
    now = Date.now()
): Promise<MetricReading> {
    // The newest two: a rate is worked out between them.
    const [latest, previous] = await prisma.metricSample.findMany({
        where: { subjectType: subject.type, subjectId: subject.id },
        orderBy: { ts: "desc" },
        take: 2,
        select: {
            ts: true,
            cpuPercent: true,
            memUsedBytes: true,
            memTotalBytes: true,
            diskUsedBytes: true,
            diskTotalBytes: true,
            netRxBytes: true,
            netTxBytes: true
        }
    });
    if (!latest || now - latest.ts.getTime() >= RECENT_SAMPLE_MS) return "no recent metrics";
    const value = sampleValue(metric, latest, previous ?? null);
    if (value !== null) return { value, at: latest.ts };
    if (metric === "disk") return "this server's disk is not measured";
    return "metric unavailable";
}

/** What a service's volumes hold, from each one's latest measurement. */
export async function serviceDiskGb(applicationId: string, now = Date.now()): Promise<MetricReading> {
    const volumes = await prisma.volume.findMany({
        where: { applicationId },
        select: { id: true }
    });
    if (volumes.length === 0) return "the service has no volumes";
    const since = new Date(now - RECENT_VOLUME_MS);
    const readings = await Promise.all(
        volumes.map((volume) =>
            prisma.metricSample.findFirst({
                where: { subjectType: "volume", subjectId: volume.id, ts: { gte: since } },
                orderBy: { ts: "desc" },
                select: { diskUsedBytes: true, ts: true }
            })
        )
    );
    const present = readings.filter((reading) => reading !== null);
    const value = volumeDiskGb(present);
    if (value === null) return "no recent volume measurement";
    const at = present.reduce((newest, reading) => Math.max(newest, reading.ts?.getTime() ?? 0), 0);
    return { value, at: new Date(at || now) };
}
