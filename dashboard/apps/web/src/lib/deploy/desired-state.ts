/**
 * Services that are running here after somebody stopped them.
 *
 * Stopping a service is two things that can come apart: the record says
 * `desiredState: "stopped"`, and the container on the machine is halted. The
 * record is written first on purpose - a stop that half-succeeded must not leave
 * the app claiming it should be up - so the half that fails is the container,
 * and when it does, nothing ever went back for it. The screen said stopped, the
 * machine kept running it, and the only person who could tell was somebody
 * reading `docker ps`.
 *
 * That is not a hypothetical. A service migrated to Vercel was stopped in the
 * same breath as a deploy of it was finishing: the stop found a container that
 * was being replaced that second, failed, and the replacement went on serving -
 * and holding its memory - for two days, on a project whose owner had been told
 * it had moved.
 *
 * So the pass: for every service this Polaris believes is stopped, ask the
 * machine what is actually up under its project, and stop what is. Nothing is
 * removed and nothing is started - a service that should be running is the boot
 * reconcile's business, and a container that belongs to no service at all is
 * `host-containers`'s. This one only closes the gap between a stop somebody
 * asked for and a stop that happened.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { serviceRef } from "./releases";
import { getPorts } from "./runtime";

/** What one pass did, for the line it logs. */
export interface DesiredStatePass {
    /** Services believed to be stopped that were looked at. */
    readonly checked: number;
    /** Containers found running under one of them and halted. */
    readonly stopped: number;
    /** Machines that would not answer. Their services are looked at again on the
     *  next pass rather than being assumed to be right. */
    readonly unreachable: number;
}

/**
 * Stop whatever is still running under a service that should not be.
 *
 * Grouped by machine so a pass costs one connection per target rather than one
 * per service, and a target that refuses costs nothing after the first.
 */
export async function runDesiredStatePass(): Promise<DesiredStatePass> {
    const apps = await prisma.application.findMany({
        where: {
            desiredState: "stopped",
            // Something has been deployed here. A service that was never
            // released has no container to find, and asking about it is a round
            // trip to a machine for an answer that is known.
            currentDeploymentId: { not: null }
        },
        select: {
            id: true,
            slug: true,
            target: {
                select: { id: true, kind: true, hostId: true, runtime: true, proxyNetwork: true }
            },
            environment: { select: { project: { select: { slug: true, ownerId: true } } } }
        }
    });
    if (apps.length === 0) return { checked: 0, stopped: 0, unreachable: 0 };

    type Deployed = (typeof apps)[number];
    const byTarget = new Map<string, Deployed[]>();
    for (const app of apps) {
        const held = byTarget.get(app.target.id);
        if (held) held.push(app);
        else byTarget.set(app.target.id, [app]);
    }

    let stopped = 0;
    let unreachable = 0;
    for (const group of byTarget.values()) {
        const first = group[0];
        if (!first) continue;
        const ports = await getPorts(first.target, first.environment.project.ownerId).catch(
            () => null
        );
        if (!ports) {
            unreachable += group.length;
            continue;
        }
        try {
            for (const app of group) {
                const { project } = serviceRef(app.environment.project.slug, app.slug, app.id);
                // Running only - that is what the listing filters on - so a
                // service that is properly down answers with nothing and costs
                // one call.
                // Optional on the interface: a runtime that cannot list is one
                // this pass has nothing to say about, rather than one to guess
                // at.
                const running = ports.listContainers
                    ? await ports.listContainers(project).catch(() => null)
                    : [];
                if (running === null) {
                    unreachable += 1;
                    continue;
                }
                for (const name of running) {
                    // One at a time, and a failure on one is not a reason to
                    // leave the next one up. The next pass tries again.
                    const halted = await ports
                        .container(name, "stop")
                        .then(() => true)
                        .catch(() => false);
                    if (halted) stopped += 1;
                }
            }
        } finally {
            await ports.dispose().catch(() => undefined);
        }
    }

    return { checked: apps.length, stopped, unreachable };
}
