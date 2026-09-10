/**
 * The loop behind sleep mode.
 *
 * Every few seconds, for each service on this machine that sleeps when idle or is
 * asleep: read the edge's recent log once, find the latest visit to any of its
 * addresses, and ask `sleepDecision` what to do. A sleeping service's addresses are
 * still routed to it, so a visit reaches the stopped container, the edge answers
 * with the page saying it is waking up, and that request - in the log like any
 * other - is what this loop wakes it on. The page reloads itself, and the reload
 * after the container is up is the app.
 *
 * Only services on this machine: the edge whose log this reads is this machine's,
 * and a remote server's own edge serves that server's services. Only one copy:
 * sleeping several and waking them is a scaling decision, not this one.
 */

import { prisma } from "@polaris/db";
import { parseHttpLogs } from "@polaris/deploy";
import { tunnelHostForApp } from "./quick-tunnel-service";
import { countsAsVisit, hostnameCovers, sleepDecision, sleepRefusal } from "@polaris/core";
import { EDGE_LOG_RECENT_WINDOW_BYTES, readEdgeLogTail } from "@/lib/edge-access-log";

/** When this process started: a service is not known to have been idle before it. */
const STARTED_AT = Date.now();

/** When each service was last woken by this process, so it is not put straight
 *  back to sleep on a log that has not caught up with the visit yet. */
const wokenAt = new Map<string, number>();

export async function runSleepPass(now = Date.now()): Promise<{ asleep: number; woke: number; slept: number }> {
    const apps = await prisma.application.findMany({
        where: {
            OR: [{ sleepAfterMinutes: { not: null } }, { asleepSince: { not: null } }],
            currentDeploymentId: { not: null },
            desiredState: "running"
        },
        select: {
            id: true,
            replicas: true,
            autoscale: true,
            sleepAfterMinutes: true,
            asleepSince: true,
            currentDeploymentId: true,
            target: { select: { kind: true } },
            environment: { select: { project: { select: { ownerId: true } } } },
            domains: { where: { enabled: true }, select: { hostname: true } }
        }
    });
    if (apps.length === 0) return { asleep: 0, woke: 0, slept: 0 };

    const entries = parseHttpLogs(await readEdgeLogTail(EDGE_LOG_RECENT_WINDOW_BYTES));
    const times = entries.map((entry) => (entry.time ? Date.parse(entry.time) : Number.NaN));
    const windowStart = times.filter(Number.isFinite).reduce<number | null>((min, t) => (min === null || t < min ? t : min), null);

    const deployments = new Map(
        (
            await prisma.deployment.findMany({
                where: { id: { in: apps.map((app) => app.currentDeploymentId as string) } },
                select: { id: true, finishedAt: true }
            })
        ).map((row) => [row.id, row.finishedAt?.getTime() ?? 0])
    );

    const { setApplicationAsleep, syncAppRoutes } = await import("@/lib/deploy-service");
    let asleep = 0;
    let woke = 0;
    let slept = 0;
    for (const app of apps) {
        const names = [...app.domains.map((domain) => domain.hostname.toLowerCase()), tunnelHostForApp(app.id).toLowerCase()];
        let lastVisit: number | null = null;
        entries.forEach((entry, index) => {
            const at = times[index];
            if (at === undefined || !Number.isFinite(at) || !entry.host || !countsAsVisit(entry)) return;
            const host = entry.host.toLowerCase().split(":")[0] ?? "";
            if (!names.some((name) => hostnameCovers(name, host))) return;
            if (lastVisit === null || at > lastVisit) lastVisit = at;
        });
        // Asleep but no longer allowed to be (moved, scaled out) wakes like a visit would.
        const sleeps = sleepRefusal(app) === null ? app.sleepAfterMinutes : null;
        const decision = sleepDecision({
            sleepAfterMinutes: sleeps,
            asleepSince: app.asleepSince?.getTime() ?? null,
            lastVisit,
            windowStart,
            awakeSince: Math.max(STARTED_AT, deployments.get(app.currentDeploymentId as string) ?? 0, wokenAt.get(app.id) ?? 0),
            now
        });
        if (decision === "stay") {
            if (app.asleepSince) asleep += 1;
            continue;
        }
        const ownerId = app.environment.project.ownerId;
        try {
            await setApplicationAsleep(app.id, ownerId, decision === "sleep");
            if (decision === "wake") {
                wokenAt.set(app.id, now);
                woke += 1;
            } else {
                slept += 1;
                asleep += 1;
            }
        } catch (error) {
            console.error(`polaris: could not ${decision} ${app.id}:`, error instanceof Error ? error.message : error);
        }
    }
    // The waking page is chosen per route, so the edge follows every change.
    if (woke + slept > 0) await syncAppRoutes().catch(() => undefined);
    return { asleep, woke, slept };
}
