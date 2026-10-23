/**
 * What Watch sees on a small team's machines: three servers, the services
 * deployed on them and the containers they run, each with its last hour of CPU.
 * Addresses are the documentation ranges, so no picture names a real machine.
 */

import { id } from "./people";
import type { SceneContext } from "../runtime/scene";
import type { SparkPoint, WatchCard } from "@/lib/watch-overview-service";

const GIB = 1024 ** 3;
/** The hour a sparkline covers, in the points the overview buckets it into. */
const POINTS = 30;
const BUCKET = (60 * 60 * 1000) / POINTS;

/** A line around `base` with a little noise and, when asked, a climb at the end. */
function spark(now: number, base: number, seed: number, climb = 0): SparkPoint[] {
    return Array.from({ length: POINTS }, (_, i) => {
        // Noise in proportion to the load, so a quiet machine draws a calm line.
        const wave = (Math.sin((i + seed) * 0.9) * 0.1 + Math.cos((i * seed) % 7) * 0.05) * base;
        const rise = climb && i > POINTS - 8 ? ((i - (POINTS - 8)) / 8) * climb : 0;
        return {
            t: now - (POINTS - 1 - i) * BUCKET,
            v: Math.max(1, Math.round(base + wave + rise))
        };
    });
}

interface Subject {
    readonly name: string;
    readonly detail: string;
    readonly cpu: number;
    /** Memory used and total, in GiB. */
    readonly mem: [number, number];
    readonly climb?: number;
    readonly alarms?: number;
}

function cards(
    ctx: SceneContext,
    kind: WatchCard["kind"],
    subjects: readonly Subject[]
): WatchCard[] {
    return subjects.map((subject, n) => {
        const subjectId = id(`watch-${kind}`, n + 1);
        const line = spark(ctx.now, subject.cpu, n + 2, subject.climb);
        return {
            id: subjectId,
            kind,
            name: subject.name,
            detail: subject.detail,
            state: "up",
            // What the overview service writes, in its own words.
            stateLabel: kind === "container" ? "Up 6 days" : "Reporting",
            cpuPercent: line.at(-1)?.v ?? subject.cpu,
            memUsedBytes: Math.round(subject.mem[0] * GIB),
            memTotalBytes: subject.mem[1] * GIB,
            spark: line,
            alarms: subject.alarms ?? 0,
            href: `/watch/${kind}/${subjectId}`
        };
    });
}

export function watchServers(ctx: SceneContext): WatchCard[] {
    return cards(ctx, "server", [
        {
            name: "atlas",
            detail: "polaris@192.0.2.10 - the machine Polaris runs on",
            cpu: 22,
            mem: [9.4, 32]
        },
        {
            name: "orion",
            detail: "deploy@192.0.2.24",
            cpu: 61,
            mem: [27.1, 64],
            climb: 18,
            alarms: 1
        },
        { name: "vega", detail: "deploy@198.51.100.7", cpu: 9, mem: [2.2, 8] }
    ]);
}

export function watchServices(ctx: SceneContext): WatchCard[] {
    return cards(ctx, "service", [
        { name: "storefront", detail: "Northwind / production", cpu: 34, mem: [1.6, 4] },
        { name: "api", detail: "Northwind / production", cpu: 47, mem: [2.4, 4], climb: 12 },
        { name: "worker", detail: "Northwind / production", cpu: 18, mem: [0.9, 2] },
        { name: "docs", detail: "Northwind / staging", cpu: 4, mem: [0.3, 1] }
    ]);
}

export function watchContainers(ctx: SceneContext): WatchCard[] {
    return cards(ctx, "container", [
        { name: "postgres", detail: "postgres:16 on atlas", cpu: 14, mem: [3.1, 32] },
        { name: "redis", detail: "redis:7 on atlas", cpu: 5, mem: [0.4, 32] },
        { name: "traefik", detail: "traefik:v3 on atlas", cpu: 3, mem: [0.2, 32] },
        { name: "minio", detail: "minio on orion", cpu: 8, mem: [1.1, 64] }
    ]);
}

/** Alarms in the "alarm" state across everything: the one on orion. */
export const WATCH_FIRING = 1;
