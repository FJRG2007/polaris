/**
 * Release containers a service no longer runs, found by the engine's labels and
 * taken away.
 *
 * A promotion takes down what it replaced by the project name it works out from
 * the replaced deployment row, through the compose file the daemon kept for that
 * project. That misses a release created under a shape the row does not describe
 * (the service's own `polaris-<hash>` project from before releases had projects
 * of their own) and one whose compose file no longer names its container - and
 * the miss was silent: the row said removed, the container kept serving beside the
 * new one, and only an older router rule decided which of the two a visitor got.
 *
 * So both the promotion and a periodic sweep also ask the machine which
 * containers carry the service's release project label, and remove every one that
 * is in none of the projects the service keeps. The safety rules:
 *
 *   - Only a container whose compose project or stack is exactly the shape of a
 *     service release, and whose service Polaris holds on that machine
 *     (`release-containers.ts`). Nothing an operator started, no tunnel, no
 *     database, nothing of a removed service.
 *   - Never the release serving, never one still on record as running (a kept
 *     release, one the edge could not be moved off yet), and never anything of a
 *     service with a deploy in flight or a promotion under way.
 *   - Never a container younger than a grace period in the sweep, which reads
 *     the machine before the records so a deploy that starts in between is seen.
 *   - Never a volume: a container is removed with its volumes left in place.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import {
    orphanedReleaseContainers,
    removalPlan,
    supersededContainers,
    type ReleaseContainer,
    type RuntimePorts
} from "@polaris/deploy";
import * as deployReleases from "./releases";
import { getPorts, type TargetRow } from "./runtime";
import { IN_FLIGHT_DEPLOY_STATUSES } from "./status";

/** How old a container has to be before the sweep may call it superseded. */
export const ORPHAN_GRACE_MS = 30 * 60 * 1000;

/** A deployment row, reduced to what names its project. */
interface ReleaseRow {
    readonly id: string;
    readonly deployableId: string;
    readonly status: string;
    readonly commitSha: string | null;
    readonly isolated: boolean;
    readonly cutover: boolean;
}

const KEPT_STATUSES = ["running", ...IN_FLIGHT_DEPLOY_STATUSES];

/**
 * The projects one service keeps: the one serving, and the project of every
 * release still on record as running or on its way up. A row whose project is
 * not settled yet (in flight) keeps both shapes it could run under.
 */
export function keptProjects(
    base: deployReleases.ReleaseRef,
    serving: string,
    rows: readonly ReleaseRow[]
): Set<string> {
    const keep = new Set([serving]);
    for (const row of rows) {
        const own = deployReleases.releaseRef(base, deployReleases.markerOf(row)).project;
        if (row.status !== "running") {
            keep.add(base.project);
            keep.add(own);
        } else keep.add(row.isolated ? own : base.project);
    }
    return keep;
}

/** What a removal pass did, for its log line. */
export interface RemovedRelease {
    readonly name: string;
    readonly project: string;
}

/**
 * Remove `found`: compose containers one by one, swarm stacks whole. A container
 * that will not go is logged and skipped - the next pass tries it again.
 */
async function removeAll(
    ports: RuntimePorts,
    found: readonly ReleaseContainer[]
): Promise<RemovedRelease[]> {
    const plan = removalPlan(found);
    const removed: RemovedRelease[] = [];
    for (const container of plan.containers) {
        try {
            await ports.removeContainer?.(container.id);
            removed.push({ name: container.name, project: container.project });
        } catch (error) {
            console.error(
                `polaris: could not remove the superseded release container ${container.name} (${container.project}):`,
                error
            );
        }
    }
    for (const stack of plan.stacks) {
        try {
            await ports.stackDown(stack);
            removed.push({ name: stack, project: stack });
        } catch (error) {
            console.error(
                `polaris: could not remove the superseded release stack ${stack}:`,
                error
            );
        }
    }
    return removed;
}

/**
 * After a promotion: take down every container of this service that is in none of
 * the projects it keeps, whatever project it was created under. `retiring` are the
 * rows the promotion is taking down, which no longer count as kept even while
 * their status still says running. Resolves what it removed; a machine that
 * cannot list its containers removes nothing.
 */
export async function downSupersededReleases(
    app: deployReleases.ReleaseSubject,
    ports: RuntimePorts,
    retiring: readonly string[]
): Promise<RemovedRelease[]> {
    if (!ports.releaseContainers || !ports.removeContainer) return [];
    // The machine first, the records after: anything listed was created by a
    // deployment whose row exists by the time the rows are read.
    const containers = await ports.releaseContainers();
    const base = deployReleases.serviceRef(app.environment.project.slug, app.slug, app.id);
    const serving = (await deployReleases.currentReleaseRef(app)).project;
    const rows = await prisma.deployment.findMany({
        where: {
            deployableType: "application",
            deployableId: app.id,
            status: { in: KEPT_STATUSES },
            ...(retiring.length > 0 ? { id: { notIn: [...retiring] } } : {})
        },
        select: {
            id: true,
            deployableId: true,
            status: true,
            commitSha: true,
            isolated: true,
            cutover: true
        }
    });
    const found = supersededContainers(containers, base.project, keptProjects(base, serving, rows));
    const removed = await removeAll(ports, found);
    for (const one of removed) {
        console.log(
            `polaris: removed superseded release ${one.name} (${one.project}) of service ${app.id}`
        );
    }
    return removed;
}

/**
 * The selection the sweep makes for one machine: every service Polaris holds there
 * that has a current release and nothing in flight, mapped to the projects it
 * keeps. Pure over what was read, so it can be asserted.
 */
export function sweepServices(
    apps: readonly (deployReleases.ReleaseSubject & { readonly busy?: boolean })[],
    serving: ReadonlyMap<string, deployReleases.ServingRelease>,
    rows: readonly ReleaseRow[]
): Map<string, Set<string>> {
    const services = new Map<string, Set<string>>();
    for (const app of apps) {
        if (!app.currentDeploymentId || app.busy) continue;
        const own = rows.filter((row) => row.deployableId === app.id);
        // A deploy on its way up has a project that is not settled; the whole
        // service waits for the next pass.
        if (own.some((row) => row.status !== "running")) continue;
        const current = serving.get(app.id);
        if (!current) continue;
        const base = deployReleases.serviceRef(app.environment.project.slug, app.slug, app.id);
        services.set(base.project, keptProjects(base, current.project, own));
    }
    return services;
}

/** What one sweep removed, per machine. */
export interface OrphanSweep {
    readonly targetId: string;
    readonly removed: readonly RemovedRelease[];
}

/**
 * Every machine Polaris deploys services to: remove the release containers, running
 * or stopped, that are not a release their service still runs. A machine that cannot
 * be reached or listed is skipped and tried on the next pass.
 */
export async function sweepOrphanReleases(now = Date.now()): Promise<OrphanSweep[]> {
    const apps = await prisma.application.findMany({
        where: { currentDeploymentId: { not: null } },
        select: {
            id: true,
            slug: true,
            currentDeploymentId: true,
            environment: { select: { project: { select: { slug: true, ownerId: true } } } },
            target: {
                select: { id: true, kind: true, hostId: true, runtime: true, proxyNetwork: true }
            }
        }
    });
    const byTarget = new Map<string, typeof apps>();
    for (const app of apps) {
        const list = byTarget.get(app.target.id) ?? [];
        list.push(app);
        byTarget.set(app.target.id, list);
    }
    const { releaseBusy } = await import("@/lib/deploy-service");
    const swept: OrphanSweep[] = [];
    for (const [targetId, onTarget] of byTarget) {
        const first = onTarget[0];
        if (!first) continue;
        let ports: RuntimePorts;
        try {
            ports = await getPorts(first.target as TargetRow, first.environment.project.ownerId);
        } catch {
            continue;
        }
        try {
            if (!ports.releaseContainers || !ports.removeContainer) continue;
            const containers = await ports.releaseContainers().catch(() => null);
            if (!containers) continue;
            const ids = onTarget.map((app) => app.id);
            const [rows, serving] = await Promise.all([
                prisma.deployment.findMany({
                    where: {
                        deployableType: "application",
                        deployableId: { in: ids },
                        status: { in: KEPT_STATUSES }
                    },
                    select: {
                        id: true,
                        deployableId: true,
                        status: true,
                        commitSha: true,
                        isolated: true,
                        cutover: true
                    }
                }),
                deployReleases.servingReleases(onTarget)
            ]);
            const services = sweepServices(
                onTarget.map((app) => ({ ...app, busy: releaseBusy(app.id) })),
                serving,
                rows
            );
            const found = orphanedReleaseContainers(containers, services, now, ORPHAN_GRACE_MS);
            if (found.length === 0) continue;
            const removed = await removeAll(ports, found);
            for (const one of removed) {
                console.log(
                    `polaris: swept superseded release ${one.name} (${one.project}) on target ${targetId}`
                );
            }
            swept.push({ targetId, removed });
        } finally {
            await ports.dispose?.().catch(() => undefined);
        }
    }
    return swept;
}
