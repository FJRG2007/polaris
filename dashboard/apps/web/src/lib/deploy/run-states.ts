/**
 * The run state of many services at once, for a board that draws all of them.
 *
 * Three indexed reads whatever the number of services: when each serving release
 * finished, the newest sample of each service within the window that decides
 * anything, and whether the collector sampled anything at all lately. Nothing here
 * dials a machine - the samples are what the collector already wrote.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { RECENT_SAMPLE_MS, serviceRunState, type ServiceRunState } from "./run-state";

/** What one service contributes to the decision. */
export interface RunStateApp {
    readonly id: string;
    readonly desiredState: string;
    readonly asleepSince: Date | null;
    readonly currentDeploymentId: string | null;
}

export async function serviceRunStates(
    apps: readonly RunStateApp[],
    deployStatuses: Readonly<Record<string, string>>,
    now: number = Date.now()
): Promise<Record<string, ServiceRunState>> {
    if (apps.length === 0) return {};
    const since = new Date(now - RECENT_SAMPLE_MS);
    const releaseIds = apps.map((app) => app.currentDeploymentId).filter((id): id is string => id !== null);
    const [releases, samples, anySample] = await Promise.all([
        releaseIds.length
            ? prisma.deployment.findMany({
                  where: { id: { in: releaseIds } },
                  select: { id: true, finishedAt: true }
              })
            : [],
        // Bounded by time as well as by id, so the read covers a few minutes of
        // samples per service rather than the week the table keeps.
        prisma.metricSample.groupBy({
            by: ["subjectId"],
            where: { subjectType: "app", subjectId: { in: apps.map((app) => app.id) }, ts: { gte: since } },
            _max: { ts: true }
        }),
        prisma.metricSample.findFirst({
            where: { subjectType: "app", ts: { gte: since } },
            select: { ts: true }
        })
    ]);
    const releasedAt = new Map(releases.map((row) => [row.id, row.finishedAt]));
    const lastSample = new Map(samples.map((row) => [row.subjectId, row._max.ts]));
    const states: Record<string, ServiceRunState> = {};
    for (const app of apps) {
        states[app.id] = serviceRunState({
            deployStatus: deployStatuses[app.id] ?? null,
            desiredState: app.desiredState,
            asleep: app.asleepSince !== null,
            releasedAt: app.currentDeploymentId ? (releasedAt.get(app.currentDeploymentId) ?? null) : null,
            lastSampleAt: lastSample.get(app.id) ?? null,
            collectorAlive: anySample !== null,
            now
        });
    }
    return states;
}
