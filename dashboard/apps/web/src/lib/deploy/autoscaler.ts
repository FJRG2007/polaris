/**
 * The loop that moves a service's replica count by itself.
 *
 * Once a minute, for every running service with a range set: read the CPU of each
 * of its copies and average it, count the requests the edge logged for its
 * addresses in the last minute when it has a traffic target, and ask
 * `autoscaleStep` what the count should be. The streaks the decision needs live
 * in memory - a restart forgets them, which costs a few minutes' patience before
 * the next change and nothing else.
 *
 * The edge's log is read once per pass, and only when some service has a traffic
 * target on this machine - the same reader sleep mode wakes services with.
 *
 * Plain compose only. Swarm's replicas are tasks with names of their own that the
 * machine chooses, so there is nothing here to read them by.
 */

import { prisma } from "@polaris/db";
import { replicaNames } from "@polaris/deploy";
import { servingContainerNames } from "./releases";
import * as activity from "@/lib/activity/activity";
import { recordDeployAudit } from "@/lib/deploy-audit";
import { scaleService, singleCopyReason } from "./scaling-service";
import { hostDockerDriver, localDockerDriver } from "@/lib/docker-service";
import { readEdgeVisits, serviceHostnames, visitTimes, type EdgeVisits } from "./edge-visits";
import {
    AUTOSCALE_IDLE,
    AUTOSCALED_ACTION_PREFIX,
    autoscaleStep,
    parseAutoscale,
    requestRate,
    trafficRefusal,
    type AutoscaleState
} from "@polaris/core";

const states = new Map<string, AutoscaleState>();

/** Average CPU over the copies that answered, or null when none did. */
async function averageCpu(
    app: { target: { kind: string; hostId: string | null }; environment: { project: { ownerId: string } } },
    names: readonly string[]
): Promise<number | null> {
    const driver =
        app.target.kind === "local" || !app.target.hostId
            ? localDockerDriver()
            : await hostDockerDriver(app.target.hostId, app.environment.project.ownerId);
    try {
        const samples = await driver.statsMany([...names]);
        const readings = names.flatMap((name) => {
            const stats = samples.get(name);
            return stats ? [stats.cpuPercent] : [];
        });
        return readings.length > 0 ? readings.reduce((sum, value) => sum + value, 0) / readings.length : null;
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}

export async function runAutoscale(now = Date.now()): Promise<{ checked: number; scaled: number }> {
    const apps = await prisma.application.findMany({
        where: { autoscale: { not: null }, currentDeploymentId: { not: null }, desiredState: "running" },
        include: {
            environment: { include: { project: true } },
            target: true,
            domains: { where: { enabled: true }, select: { hostname: true } },
            _count: { select: { volumes: true } }
        }
    });
    let checked = 0;
    let scaled = 0;
    const names = await servingContainerNames(apps);
    // Read on the first service that needs it, and not at all when none does.
    let log: Promise<EdgeVisits> | null = null;
    for (const app of apps) {
        const config = parseAutoscale(app.autoscale);
        if (!config || app.target.runtime === "swarm" || singleCopyReason(app)) continue;
        // A deploy already on its way decides the count for itself; a second one
        // queued behind it would only undo or repeat it.
        const inFlight = await prisma.deployment.count({
            where: {
                deployableType: "application",
                deployableId: app.id,
                status: { in: ["queued", "building", "deploying"] }
            }
        });
        if (inFlight > 0) continue;
        checked += 1;
        const primary = names.get(app.id);
        const cpu = primary
            ? await averageCpu(app, replicaNames(primary, app.replicas)).catch(() => null)
            : null;
        let requests: number | null = null;
        if (config.requestsPerCopy !== null && trafficRefusal(app) === null) {
            log ??= readEdgeVisits().catch(() => ({ visits: [], windowStart: null }));
            const visits = await log;
            requests = requestRate(visitTimes(visits, serviceHostnames(app)), visits.windowStart, now);
        }
        const step = autoscaleStep(
            config,
            app.replicas,
            { cpuPercent: cpu, requestsPerMinute: requests },
            states.get(app.id) ?? AUTOSCALE_IDLE,
            now
        );
        states.set(app.id, step.state);
        if (step.replicas === app.replicas || step.signal === null) continue;
        try {
            await scaleService(app.id, app.environment.project.ownerId, step.replicas);
            scaled += 1;
            await recordDeployAudit({
                // Nobody pressed anything: the machine did it.
                actorId: null,
                action: "deploy.app.autoscale",
                targetType: "application",
                targetId: app.id,
                metadata: {
                    from: app.replicas,
                    to: step.replicas,
                    signal: step.signal,
                    cpuPercent: cpu,
                    requestsPerMinute: requests
                }
            });
            // And in the service's own history, where its owner reads what
            // happened to it - with what moved it in the action's name.
            await activity
                .record({
                    subjectType: "app",
                    subjectId: app.id,
                    userId: null,
                    action: `${AUTOSCALED_ACTION_PREFIX}${step.signal}`,
                    fromValue: String(app.replicas),
                    toValue: String(step.replicas)
                })
                .catch(() => undefined);
        } catch (error) {
            console.error(`polaris: could not scale ${app.id}:`, error);
        }
    }
    // A service that no longer has a range forgets its streaks.
    const watched = new Set(apps.map((app) => app.id));
    for (const id of states.keys()) if (!watched.has(id)) states.delete(id);
    return { checked, scaled };
}
