/**
 * What a deploy of a service does to the version already running, as the screen
 * says it: whether it changes over with no gap, and when it cannot, every reason
 * why - in the same words the deploy acts on (`deployStrategy`), so what the screen
 * promises and what the deploy does are one decision.
 */

import { prisma } from "@polaris/db";
import { hostPortForApp } from "./host-port";
import { deployStrategy, volumesNotYetMade, type DeployStrategy } from "./releases";
import { storedExternalNetworks, type ExternalNetwork } from "./external-networks";

export interface DeployBehaviourView {
    readonly strategy: DeployStrategy;
    /** Whether it has volumes, which is when sharing them is a choice at all. */
    readonly hasVolumes: boolean;
    /** Whether the choice is offered: plain compose only - swarm never lets two
     *  tasks share a volume. */
    readonly overlapChoice: boolean;
    readonly overlapVolumes: boolean;
    readonly externalNetworks: readonly ExternalNetwork[];
    /** The name it answers to on such a network when none is given. */
    readonly defaultAlias: string;
}

export async function deployBehaviour(applicationId: string, ownerId: string): Promise<DeployBehaviourView> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: {
            id: true,
            slug: true,
            keepReleases: true,
            publishPort: true,
            sourceType: true,
            sourceConfig: true,
            overlapVolumes: true,
            externalNetworks: true,
            currentDeploymentId: true,
            volumes: { select: { name: true, kind: true, createdAt: true } },
            target: { select: { kind: true, hostId: true, runtime: true } }
        }
    });
    if (!app) throw new Error("Application not found");
    // Another server's edge is asked whether it takes routes from here - one
    // connection, and only for a service on another server.
    let followsPushedRoutes = true;
    if (app.target.kind !== "local" && app.target.hostId) {
        const { readServerEdge } = await import("./server-edge");
        followsPushedRoutes = await readServerEdge(app.target.hostId, ownerId)
            .then((edge) => edge.pushable)
            .catch(() => false);
    }
    const strategy = deployStrategy(app, { followsPushedRoutes }, hostPortForApp);
    // The deploy itself runs in place once more while a volume it would share is
    // not made yet, and the screen says so rather than promising no gap.
    const notYetMade = strategy.mode === "overlap" ? await volumesNotYetMade(app) : [];
    return {
        strategy:
            notYetMade.length > 0 ? { mode: "restart", reasons: [{ code: "newVolumes", names: notYetMade }] } : strategy,
        hasVolumes: app.volumes.length > 0,
        overlapChoice: app.volumes.length > 0 && app.target.runtime === "compose",
        overlapVolumes: app.overlapVolumes,
        externalNetworks: storedExternalNetworks(app.externalNetworks),
        defaultAlias: app.slug
    };
}

/** Let a service with volumes change over beside its running version, or not.
 *  The next deploy does it. False when nothing changed. */
export async function setOverlapVolumes(applicationId: string, ownerId: string, value: boolean): Promise<boolean> {
    const app = await prisma.application.findFirst({
        where: { id: applicationId, environment: { project: { ownerId } } },
        select: { overlapVolumes: true }
    });
    if (!app) throw new Error("Application not found");
    if (app.overlapVolumes === value) return false;
    await prisma.application.update({ where: { id: applicationId }, data: { overlapVolumes: value } });
    return true;
}
