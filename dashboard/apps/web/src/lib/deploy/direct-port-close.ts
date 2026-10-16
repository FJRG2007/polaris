/**
 * Closing the host ports the edge should be the only way past.
 *
 * Its own module because it drives the deploy service, which reads the decision in
 * `direct-port.ts` while it plans - the two would otherwise import each other.
 *
 * A port only closes when the container is recreated, so each service is started
 * again from its live release's kept image through the ordinary deploy, planned
 * with the port closed. The setting itself is stored closed only when that release
 * is promoted (`promoteRelease`): until then the edge keeps dialling the release
 * that is serving, on its port. A service whose deploy fails keeps running as it
 * was - still reachable on its port, and still shown so on its firewall scope.
 *
 * Two callers, two bars:
 * - at boot, nobody asked, so only what changes over with no downtime is moved:
 *   a kept image to start again (no rebuild of newer code), a change-over the
 *   service can run (no volumes that refuse to be shared, no other host ports, not
 *   a compose stack), and no deploy of it already queued or running, which closes
 *   the port itself when it plans. The rest close on their next deploy, and are
 *   named on the firewall screen until then;
 * - from the firewall screen, the operator asked and was told a service that
 *   cannot change over restarts, so every port they can close is closed.
 */

import { isReleaseImage } from "@polaris/core";
import { prisma, type Prisma } from "@polaris/db";
import { IN_FLIGHT_DEPLOY_STATUSES } from "@/lib/deploy/status";
import { setApplicationPublishPort } from "@/lib/deploy-service";
import { runsCutover, volumesNotYetMade } from "@/lib/deploy/releases";
import { closesDirectPort, directPortServices } from "@/lib/deploy/direct-port";

export interface ClosedPorts {
    readonly closed: readonly string[];
    readonly failed: readonly string[];
    /** Left for their next deploy: closing them now would take them down. */
    readonly deferred: readonly string[];
}

/** What a boot close reads about one service, to know it changes over cleanly. */
export interface QuietCloseFacts {
    readonly cutover: boolean;
    readonly volumesPending: boolean;
    readonly imageKept: boolean;
    readonly deploying: boolean;
}

/** Whether a service's port can be closed with nobody noticing: started again
 *  from the image it runs, beside the running copy, with nothing else in flight. */
export function closesQuietly(facts: QuietCloseFacts): boolean {
    return facts.cutover && !facts.volumesPending && facts.imageKept && !facts.deploying;
}

/** The services among `ids` whose port closes with no downtime (see `closesQuietly`). */
async function quietlyClosable(ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const [apps, inFlight] = await Promise.all([
        prisma.application.findMany({
            where: { id: { in: [...ids] } },
            select: {
                id: true,
                keepReleases: true,
                sourceType: true,
                sourceConfig: true,
                overlapVolumes: true,
                currentDeploymentId: true,
                volumes: { select: { name: true, kind: true, createdAt: true } },
                target: { select: { runtime: true, kind: true } }
            }
        }),
        prisma.deployment.findMany({
            where: {
                deployableType: "application",
                deployableId: { in: [...ids] },
                status: { in: [...IN_FLIGHT_DEPLOY_STATUSES] }
            },
            select: { deployableId: true }
        })
    ]);
    const releases = await prisma.deployment.findMany({
        where: { id: { in: apps.flatMap((app) => app.currentDeploymentId ?? []) } },
        select: { id: true, imageKept: true, imageTag: true }
    });
    const kept = new Set(
        releases.filter((row) => row.imageKept && isReleaseImage(row.imageTag)).map((row) => row.id)
    );
    const deploying = new Set(inFlight.map((row) => row.deployableId));
    const quiet = new Set<string>();
    for (const app of apps) {
        const facts: QuietCloseFacts = {
            // As the deploy will see it: with the port it is closing already closed.
            cutover: runsCutover({ ...app, publishPort: false }, { followsPushedRoutes: true }),
            volumesPending: (await volumesNotYetMade(app)).length > 0,
            imageKept: app.currentDeploymentId !== null && kept.has(app.currentDeploymentId),
            deploying: deploying.has(app.id)
        };
        if (closesQuietly(facts)) quiet.add(app.id);
    }
    return quiet;
}

/**
 * Close the host port of every running service matching `where` that should be
 * reached through the edge alone. One at a time: each is a deploy, and a boot that
 * queued every service on the machine at once would be a boot that rebuilt it.
 *
 * `mode` is who asked: `boot` closes only the ports nobody chose, and only where
 * that costs no downtime; `operator` closes every port in `where` it can, chosen
 * or not, because the operator asked for exactly that.
 */
export async function closeDirectPorts(
    where: Prisma.ApplicationWhereInput,
    options: { readonly mode: "boot" | "operator"; readonly actorId: string | null }
): Promise<ClosedPorts> {
    // Only what is running and has a release to start again: recreating a service
    // somebody stopped, or one asleep, would start it. Those close on their next
    // deploy, and a stopped container listens on nothing in the meantime.
    const services = (
        await directPortServices({
            AND: [
                where,
                {
                    publishPort: true,
                    desiredState: "running",
                    asleepSince: null,
                    currentDeploymentId: { not: null },
                    keepReleases: false,
                    target: { kind: "local" }
                }
            ]
        })
    ).filter((service) =>
        options.mode === "boot"
            ? closesDirectPort(service.facts)
            : service.facts.routed && !service.facts.reachedOnPort
    );
    const quiet =
        options.mode === "boot"
            ? await quietlyClosable(services.map((service) => service.id))
            : null;
    const closed: string[] = [];
    const failed: string[] = [];
    const deferred: string[] = [];
    for (const service of services) {
        if (quiet && !quiet.has(service.id)) {
            deferred.push(service.id);
            continue;
        }
        try {
            await setApplicationPublishPort(service.id, service.ownerId, false, options.actorId);
            closed.push(service.id);
        } catch (error) {
            console.error(`polaris: could not close the host port of service ${service.id}:`, error);
            failed.push(service.id);
        }
    }
    return { closed, failed, deferred };
}
