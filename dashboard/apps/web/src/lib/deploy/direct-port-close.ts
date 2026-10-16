/**
 * Closing the host ports the edge should be the only way past.
 *
 * Its own module because it drives the deploy service, which reads the decision in
 * `direct-port.ts` while it plans - the two would otherwise import each other.
 *
 * A port only closes when the container is recreated, so each service is started
 * again from its live release's kept image through the ordinary deploy, which is
 * the zero-downtime change-over: the new container comes up without the port, the
 * old one keeps serving until the new one does, and the edge is moved to dial the
 * container by name. Nothing is torn down abruptly, and a service whose deploy
 * fails keeps running as it was - still reachable on its port, and still shown so
 * on its firewall scope.
 */

import type { Prisma } from "@polaris/db";
import { setApplicationPublishPort } from "@/lib/deploy-service";
import { closesDirectPort, directPortServices } from "@/lib/deploy/direct-port";

export interface ClosedPorts {
    readonly closed: readonly string[];
    readonly failed: readonly string[];
}

/**
 * Close the host port of every service matching `where` whose port the edge should
 * be the only way past. One at a time: each is a deploy, and a boot that queued
 * every service on the machine at once would be a boot that rebuilt the machine.
 */
export async function closeDirectPorts(
    where: Prisma.ApplicationWhereInput = {},
    actorId: string | null = null
): Promise<ClosedPorts> {
    // Only what is running and has a release to start again: recreating a service
    // somebody stopped, or one asleep, would start it. Those close on their next
    // deploy, and a stopped container listens on nothing in the meantime.
    const services = await directPortServices({
        ...where,
        publishPort: true,
        desiredState: "running",
        asleepSince: null,
        currentDeploymentId: { not: null },
        target: { kind: "local" }
    });
    const closed: string[] = [];
    const failed: string[] = [];
    for (const service of services) {
        if (!closesDirectPort(service.facts)) continue;
        try {
            await setApplicationPublishPort(service.id, service.ownerId, false, actorId);
            closed.push(service.id);
        } catch (error) {
            console.error(`polaris: could not close the host port of service ${service.id}:`, error);
            failed.push(service.id);
        }
    }
    return { closed, failed };
}
