/**
 * What a threshold trigger can read: a registry of reading sources, each
 * belonging to a kind of subject (a server, a service, a UPS) that says which
 * subjects an account may watch.
 *
 * Built in are the readings Watch already samples and the UPS's. Anything
 * else - a NAS's disk temperatures, say - registers a kind and its sources
 * with `registerThresholdKind` from its own module, and the trigger, the
 * evaluator and the picker take it from here without a change.
 */

import { prisma } from "@polaris/db";
import { localMachineIdentity } from "@/lib/local-machine";
import { assertOwnsTarget, listAlarmTargets } from "@/lib/watch-service";
import {
    hostSubject,
    latestMetricValue,
    RECENT_SAMPLE_MS,
    serviceDiskGb,
    type MetricReading
} from "@/lib/watch/metric-reading";
import type { RunActor } from "./types";

export interface ThresholdSubject {
    readonly id: string;
    readonly name: string;
}

export interface ThresholdSource {
    /** `<kind>.<reading>`, as a trigger's config stores it. */
    readonly id: string;
    /** The unit the value is typed and judged in. */
    readonly unit: string;
    read(subjectId: string, now: number): Promise<MetricReading>;
}

export interface ThresholdKind {
    readonly kind: string;
    /** The subjects this account may watch, for the picker. */
    subjects(actor: RunActor): Promise<ThresholdSubject[]>;
    /** Checked on every evaluation: losing access stops the readings. */
    mayRead(actor: RunActor, subjectId: string): Promise<boolean>;
    readonly sources: readonly ThresholdSource[];
}

const KINDS = new Map<string, ThresholdKind>();

export function registerThresholdKind(kind: ThresholdKind): void {
    KINDS.set(kind.kind, kind);
}

export function thresholdKinds(): readonly ThresholdKind[] {
    return [...KINDS.values()];
}

/** The kind and source a stored source id names, or null when nothing provides it now. */
export function thresholdSource(
    id: string
): { kind: ThresholdKind; source: ThresholdSource } | null {
    const kind = KINDS.get(id.slice(0, id.indexOf(".")));
    const source = kind?.sources.find((entry) => entry.id === id);
    return kind && source ? { kind, source } : null;
}

async function owns(actor: RunActor, type: string, id: string): Promise<boolean> {
    return assertOwnsTarget(actor.id, type, id).then(
        () => true,
        () => false
    );
}

async function hostReading(hostId: string, metric: string, now: number): Promise<MetricReading> {
    const [host, identity] = await Promise.all([
        prisma.host.findUnique({
            where: { id: hostId },
            select: { id: true, dockerId: true, address: true }
        }),
        localMachineIdentity().catch(() => null)
    ]);
    return latestMetricValue(hostSubject(hostId, host, identity), metric, now);
}

const SAMPLED = ["cpu", "memory", "disk", "network_in", "network_out"] as const;

registerThresholdKind({
    kind: "host",
    subjects: async (actor) =>
        (await listAlarmTargets(actor.id)).hosts.map(({ id, name }) => ({ id, name })),
    mayRead: (actor, id) => owns(actor, "host", id),
    sources: SAMPLED.map((metric) => ({
        id: `host.${metric}`,
        unit: metric.startsWith("network") ? "MB/s" : "%",
        read: (id, now) => hostReading(id, metric, now)
    }))
});

registerThresholdKind({
    kind: "app",
    subjects: async (actor) => (await listAlarmTargets(actor.id)).apps,
    mayRead: (actor, id) => owns(actor, "application", id),
    sources: SAMPLED.map((metric) => ({
        id: `app.${metric}`,
        unit: metric === "disk" ? "GB" : metric.startsWith("network") ? "MB/s" : "%",
        read: (id, now) =>
            metric === "disk"
                ? serviceDiskGb(id, now)
                : latestMetricValue({ type: "app", id }, metric, now)
    }))
});

type UpsColumn = "charge" | "runtimeS" | "load" | "inputV" | "outputV" | "batteryV" | "powerW";

/** A UPS's newest sample's column, in the unit it is typed in. */
async function upsReading(
    upsId: string,
    column: UpsColumn,
    scale: number,
    now: number
): Promise<MetricReading> {
    const sample = await prisma.upsSample.findFirst({
        where: { upsId },
        orderBy: { ts: "desc" },
        select: {
            ts: true,
            charge: true,
            runtimeS: true,
            load: true,
            inputV: true,
            outputV: true,
            batteryV: true,
            powerW: true
        }
    });
    if (!sample || now - sample.ts.getTime() >= RECENT_SAMPLE_MS) return "no recent metrics";
    const value = sample[column];
    return typeof value === "number" ? { value: value / scale, at: sample.ts } : "metric unavailable";
}

const UPS_READINGS: readonly { id: string; column: UpsColumn; unit: string; scale: number }[] = [
    { id: "ups.charge", column: "charge", unit: "%", scale: 1 },
    { id: "ups.runtime", column: "runtimeS", unit: "min", scale: 60 },
    { id: "ups.load", column: "load", unit: "%", scale: 1 },
    { id: "ups.input_voltage", column: "inputV", unit: "V", scale: 1 },
    { id: "ups.output_voltage", column: "outputV", unit: "V", scale: 1 },
    { id: "ups.battery_voltage", column: "batteryV", unit: "V", scale: 1 },
    { id: "ups.power", column: "powerW", unit: "W", scale: 1 }
];

// A UPS is an instance administrator's, as every UPS screen and route is.
registerThresholdKind({
    kind: "ups",
    subjects: async (actor) =>
        actor.isAdmin
            ? prisma.ups.findMany({
                  select: { id: true, name: true },
                  orderBy: { name: "asc" },
                  take: 200
              })
            : [],
    mayRead: async (actor, id) =>
        actor.isAdmin &&
        (await prisma.ups.findUnique({ where: { id }, select: { id: true } })) !== null,
    sources: UPS_READINGS.map((entry) => ({
        id: entry.id,
        unit: entry.unit,
        read: (id, now) => upsReading(id, entry.column, entry.scale, now)
    }))
});
