/**
 * The run state of many services at once, for a board that draws all of them.
 *
 * Three indexed reads whatever the number of services: when each serving release
 * finished, the newest sample of every service within the window that decides
 * anything, and the machine each sampled service runs on, so a machine the
 * collector could not reach does not read as its services having crashed.
 * Nothing here dials a machine - the samples are what the collector already wrote.
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
    const [releases, samples] = await Promise.all([
        releaseIds.length
            ? prisma.deployment.findMany({
                  where: { id: { in: releaseIds } },
                  select: { id: true, finishedAt: true }
              })
            : [],
        // Bounded by time, so the read covers a few minutes of samples per
        // service rather than the week the table keeps.
        prisma.metricSample.groupBy({
            by: ["subjectId"],
            where: { subjectType: "app", ts: { gte: since } },
            _max: { ts: true }
        })
    ]);
    const placed = await prisma.application.findMany({
        where: { id: { in: [...new Set([...apps.map((app) => app.id), ...samples.map((row) => row.subjectId)])] } },
        select: { id: true, sourceType: true, target: { select: { kind: true, hostId: true, runtime: true } } }
    });
    const placement = new Map(placed.map((row) => [row.id, row]));
    const sampledMachines = new Set(
        samples.flatMap((row) => {
            const target = placement.get(row.subjectId)?.target;
            return target ? [machineOf(target)] : [];
        })
    );
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
            collectorAlive: vouchable(placement.get(app.id), sampledMachines),
            now
        });
    }
    return states;
}

/** The machine the collector reads a service on, keyed as it groups them. */
function machineOf(target: { readonly kind: string; readonly hostId: string | null }): string {
    return target.kind === "local" || !target.hostId ? "local" : `host:${target.hostId}`;
}

/**
 * Whether a missing sample of this service means anything: the collector reached
 * its machine lately, and it names the service by a single container it can find.
 * A swarm task and a compose project run under names of their own, so for those
 * an absent sample says nothing.
 */
function vouchable(
    app: { readonly sourceType: string; readonly target: { readonly kind: string; readonly hostId: string | null; readonly runtime: string } } | undefined,
    sampledMachines: ReadonlySet<string>
): boolean {
    if (!app || app.sourceType === "compose" || app.target.runtime === "swarm") return false;
    return sampledMachines.has(machineOf(app.target));
}
