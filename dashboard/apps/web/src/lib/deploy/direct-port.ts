/**
 * Whether a service answers on its host port as well as through the edge.
 *
 * A service with a domain on this machine is meant to be reached through the edge:
 * that is where its firewall, its bans, its injection protection and its login
 * stand. A port published on the host's interfaces answers the same container to
 * anybody on the network with none of that in the way, so for such a service the
 * port is closed and the edge dials the container by name instead - unless the
 * owner opened it on purpose, and even then not when the service's firewall guards
 * it, because a guard with a way round it is no guard.
 *
 * Left open, deliberately:
 * - a service with no domain here: its IP and port is the only way it is reached;
 * - a catalog install and the mail server: Polaris itself, or the game client the
 *   app exists for, reaches those on the port (see `setApplicationPublishPort`);
 * - a service on another server: its own edge reaches it by container labels and
 *   never needed the port, and when this edge serves its domains the port is the
 *   only way here, so that is the owner's switch on its settings screen.
 *
 * A kept release (Keep releases) publishes on a port of its own, which is how the
 * edge reaches the release beside the current one; it is reported as reachable
 * here, and closing it is turning Keep releases off.
 */

import { prisma, type Prisma } from "@polaris/db";
import type { ResolvedWaf } from "@polaris/core";
import { resolveWafBatch } from "@/lib/waf-service";

/** The facts the decision is made from, each read from the database. */
export interface DirectPortFacts {
    /** Runs on the machine Polaris and its edge run on. */
    readonly local: boolean;
    /** The host port is published (the stored setting). */
    readonly publishPort: boolean;
    /** The owner opened it on purpose. */
    readonly chosen: boolean;
    /** Polaris, or the client the app is for, reaches it on that port. */
    readonly reachedOnPort: boolean;
    /** It has a domain the edge answers. */
    readonly routed: boolean;
    /** Its firewall does more than the defaults: a login, an address list, a rule. */
    readonly guarded: boolean;
}

/** Whether the service's host port has to be closed, so the edge is the only way in. */
export function closesDirectPort(facts: DirectPortFacts): boolean {
    if (!facts.local || !facts.publishPort || facts.reachedOnPort || !facts.routed) return false;
    return !facts.chosen || facts.guarded;
}

/**
 * Whether a resolved firewall decides anything about who gets in. The protections
 * that are on for everybody by default (injection, framing, address obfuscation)
 * do not count: every service has them, and they are not what a port walks round.
 */
export function guardedBy(waf: ResolvedWaf): boolean {
    return (
        waf.requireLogin ||
        waf.allowLists.some((list) => list.length > 0) ||
        waf.loginAllowLists.some((list) => list.length > 0) ||
        waf.deny.length > 0 ||
        waf.rules.length > 0 ||
        waf.browserIntegrity
    );
}

const FACTS_SELECT = {
    id: true,
    name: true,
    publishPort: true,
    publishPortChosen: true,
    currentDeploymentId: true,
    target: { select: { kind: true } },
    domains: { where: { enabled: true }, select: { id: true }, take: 1 },
    environment: { select: { project: { select: { ownerId: true } } } }
} as const;

/** One service, with the facts and who owns it. */
export interface DirectPortService {
    readonly id: string;
    readonly name: string;
    readonly ownerId: string;
    readonly currentDeploymentId: string | null;
    readonly facts: DirectPortFacts;
}

/** The facts for a set of services, in three queries whatever the count. */
export async function directPortServices(
    where: Prisma.ApplicationWhereInput
): Promise<DirectPortService[]> {
    const apps = await prisma.application.findMany({ where, select: FACTS_SELECT });
    if (apps.length === 0) return [];
    const ids = apps.map((app) => app.id);
    const [installs, mail, waf] = await Promise.all([
        prisma.installedApp.findMany({
            where: { applicationId: { in: ids }, status: { not: "removed" } },
            select: { applicationId: true }
        }),
        prisma.mailServer.findMany({
            where: { applicationId: { in: ids } },
            select: { applicationId: true }
        }),
        resolveWafBatch(ids)
    ]);
    const onPort = new Set(
        [...installs, ...mail].map((row) => row.applicationId).filter(Boolean) as string[]
    );
    return apps.map((app) => ({
        id: app.id,
        name: app.name,
        ownerId: app.environment.project.ownerId,
        currentDeploymentId: app.currentDeploymentId,
        facts: {
            local: app.target.kind === "local",
            publishPort: app.publishPort,
            chosen: app.publishPortChosen,
            reachedOnPort: onPort.has(app.id),
            routed: app.domains.length > 0,
            guarded: (() => {
                const resolved = waf.get(app.id);
                return resolved ? guardedBy(resolved) : false;
            })()
        }
    }));
}

/** Whether one service's host port has to be closed now. */
export async function mustCloseDirectPort(applicationId: string): Promise<boolean> {
    const [service] = await directPortServices({ id: applicationId });
    return service ? closesDirectPort(service.facts) : false;
}

/** Whether one service's firewall decides who gets in (see `guardedBy`). */
export async function guardsService(applicationId: string): Promise<boolean> {
    const resolved = (await resolveWafBatch([applicationId])).get(applicationId);
    return resolved ? guardedBy(resolved) : false;
}
