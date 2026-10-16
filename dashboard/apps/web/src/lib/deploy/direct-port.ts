/**
 * Whether a service answers on its host port as well as through the edge.
 *
 * A service with a domain on this machine is meant to be reached through the edge:
 * that is where its firewall, its bans, its injection protection and its login
 * stand. A port published on the host's interfaces answers the same container to
 * anybody on the network with none of that in the way, so for such a service the
 * port is closed and the edge dials the container by name instead - unless the
 * owner opened it on purpose. A port opened on purpose stays open, and the
 * firewall screen says which services it leaves reachable round the edge, with
 * the button that closes them.
 *
 * Left open, deliberately:
 * - a port the owner opened from the service's settings, or pinned in its source
 *   (a game server joined on 25565 is reached by typing that address);
 * - a service with no domain here: its IP and port is the only way it is reached;
 * - a catalog install and the mail server: Polaris itself, or the game client the
 *   app exists for, reaches those on the port (see `setApplicationPublishPort`);
 * - a service on another server: its own edge reaches it by container labels and
 *   never needed the port, and when this edge serves its domains the port is the
 *   only way here, so that is the owner's switch on its settings screen.
 *
 * TCP proxies and extra ports are a door of their own the owner added, and are
 * never touched here: only the service's main port is.
 *
 * A kept release (Keep releases) publishes on a port of its own, which is how the
 * edge reaches the release beside the current one; it is reported as reachable
 * here, and closing it is turning Keep releases off.
 */

import { prisma, type Prisma } from "@polaris/db";
import type { WafScopeType } from "@polaris/core";
import { hostPortForApp } from "@/lib/deploy/host-port";
import { IN_FLIGHT_DEPLOY_STATUSES } from "@/lib/deploy/status";

/** The facts the decision is made from, each read from the database. */
export interface DirectPortFacts {
    /** Runs on the machine Polaris and its edge run on. */
    readonly local: boolean;
    /** The host port is published (the stored setting). */
    readonly publishPort: boolean;
    /** The owner opened it on purpose, from the service's settings. */
    readonly chosen: boolean;
    /** The owner pinned the host port in the service's source settings. */
    readonly pinned: boolean;
    /** Polaris, or the client the app is for, reaches it on that port. */
    readonly reachedOnPort: boolean;
    /** It has a domain the edge answers. */
    readonly routed: boolean;
}

/** Whether the service's host port is closed without asking, so the edge is the
 *  only way in: a port nobody chose, on a service the edge answers for. */
export function closesDirectPort(facts: DirectPortFacts): boolean {
    if (!facts.local || !facts.publishPort || facts.reachedOnPort || !facts.routed) return false;
    return !facts.chosen && !facts.pinned;
}

/** The host port a service pinned in its source settings, if it pinned one. */
export function pinnedHostPort(sourceConfig: string): number | null {
    try {
        const parsed = JSON.parse(sourceConfig) as { hostPort?: unknown };
        return typeof parsed.hostPort === "number" ? parsed.hostPort : null;
    } catch {
        return null;
    }
}

const FACTS_SELECT = {
    id: true,
    name: true,
    publishPort: true,
    publishPortChosen: true,
    sourceConfig: true,
    currentDeploymentId: true,
    desiredState: true,
    asleepSince: true,
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
    /** The host port it publishes on when it is not derived from its id. */
    readonly hostPort: number | null;
    /** A release is up and listening: deployed, not stopped, not asleep. */
    readonly running: boolean;
    readonly facts: DirectPortFacts;
}

/** The facts for a set of services, in three queries whatever the count. */
export async function directPortServices(
    where: Prisma.ApplicationWhereInput
): Promise<DirectPortService[]> {
    const apps = await prisma.application.findMany({
        where: { ...where, binnedAt: null },
        select: FACTS_SELECT
    });
    if (apps.length === 0) return [];
    const ids = apps.map((app) => app.id);
    const [installs, mail] = await Promise.all([
        prisma.installedApp.findMany({
            where: { applicationId: { in: ids }, status: { not: "removed" } },
            select: { applicationId: true }
        }),
        prisma.mailServer.findMany({
            where: { applicationId: { in: ids } },
            select: { applicationId: true }
        })
    ]);
    const onPort = new Set(
        [...installs, ...mail].flatMap((row) => (row.applicationId ? [row.applicationId] : []))
    );
    return apps.map((app) => {
        const hostPort = pinnedHostPort(app.sourceConfig);
        return {
            id: app.id,
            name: app.name,
            ownerId: app.environment.project.ownerId,
            currentDeploymentId: app.currentDeploymentId,
            hostPort,
            running:
                app.currentDeploymentId !== null &&
                app.desiredState === "running" &&
                app.asleepSince === null,
            facts: {
                local: app.target.kind === "local",
                publishPort: app.publishPort,
                chosen: app.publishPortChosen,
                pinned: hostPort !== null,
                reachedOnPort: onPort.has(app.id),
                routed: app.domains.length > 0
            }
        };
    });
}

/**
 * Whether a deploy that closes the service's port is queued or running. The
 * setting is stored closed only when that release is promoted, so until then this
 * is what says the port is on its way closed - to the settings screen, and to any
 * deploy planned behind it, which has to come up closed as well.
 */
export async function closingInFlight(applicationId: string): Promise<boolean> {
    const pending = await prisma.deployment.count({
        where: {
            deployableType: "application",
            deployableId: applicationId,
            status: { in: [...IN_FLIGHT_DEPLOY_STATUSES] },
            closesPort: true
        }
    });
    return pending > 0;
}

/** Whether one service's host port has to be closed now. */
export async function mustCloseDirectPort(applicationId: string): Promise<boolean> {
    const [service] = await directPortServices({ id: applicationId });
    return service ? closesDirectPort(service.facts) : false;
}

/**
 * The services a firewall scope covers, as a query. Null for Polaris's own scope,
 * which guards the dashboard rather than any deployed service. A scope somebody
 * owns is narrowed to their own services as well, so a server they run that holds
 * other people's services never names those to them.
 */
export async function servicesOfScope(
    scopeType: WafScopeType,
    scopeId: string,
    ownerId: string | null
): Promise<Prisma.ApplicationWhereInput | null> {
    const owned: Prisma.ApplicationWhereInput =
        ownerId === null ? {} : { environment: { project: { ownerId } } };
    switch (scopeType) {
        case "polaris":
            return null;
        case "global":
            return {};
        case "server-group": {
            const members = await prisma.hostGroupMember.findMany({
                where: { groupId: scopeId },
                select: { hostId: true }
            });
            const hostIds = members.map((member) => member.hostId);
            return { AND: [owned, { target: { hostId: { in: hostIds } } }] };
        }
        case "server":
            return { AND: [owned, { target: { hostId: scopeId } }] };
        case "project":
            return { AND: [owned, { environment: { projectId: scopeId } }] };
        case "environment":
            return { AND: [owned, { environmentId: scopeId }] };
        case "application":
            return { AND: [owned, { id: scopeId }] };
    }
}

/** Why a reachable port is not one the firewall screen can close. */
export type DirectAccessHeld = "keptRelease" | "installed";

/** A service the edge answers for that still answers on a host port too. */
export interface DirectAccess {
    readonly applicationId: string;
    readonly name: string;
    /** `host:port`, or the port alone when the machine's address is unknown. */
    readonly address: string;
    /** Null when closing it is a change-over Polaris can make here. */
    readonly held: DirectAccessHeld | null;
    /** A deploy that closes the port is queued or running. */
    readonly closing: boolean;
}

/** The pure part of `directAccessIn`: which services, on which port, and whether
 *  each can be closed here. */
export function directAccessOf(
    services: readonly DirectPortService[],
    keptReleases: ReadonlySet<string>,
    machineAddress: string | null,
    closing: ReadonlySet<string> = new Set()
): DirectAccess[] {
    const found: DirectAccess[] = [];
    for (const service of services) {
        if (!service.running || !service.facts.local || !service.facts.routed) continue;
        const kept =
            service.currentDeploymentId !== null && keptReleases.has(service.currentDeploymentId);
        if (!service.facts.publishPort && !kept) continue;
        const port =
            service.hostPort ??
            hostPortForApp(kept ? (service.currentDeploymentId as string) : service.id);
        found.push({
            applicationId: service.id,
            name: service.name,
            address: machineAddress ? `${machineAddress}:${port}` : String(port),
            held: kept ? "keptRelease" : service.facts.reachedOnPort ? "installed" : null,
            closing: closing.has(service.id)
        });
    }
    return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every service under a scope that the edge answers for and that is still
 * reachable on a host port, round its firewall: what the firewall screen says
 * about the scope, so it never claims a protection that a port walks round.
 * Bounded by the scope's own services.
 */
export async function directAccessIn(
    where: Prisma.ApplicationWhereInput,
    machineAddress: string | null
): Promise<DirectAccess[]> {
    const services = await directPortServices({ AND: [where, { target: { kind: "local" } }] });
    const live = services.flatMap((service) =>
        service.facts.routed && service.currentDeploymentId ? [service.currentDeploymentId] : []
    );
    const open = services.flatMap((service) => (service.facts.publishPort ? [service.id] : []));
    const [kept, closing] = await Promise.all([
        live.length === 0
            ? []
            : prisma.deployment.findMany({
                  where: { id: { in: live }, isolated: true, cutover: false },
                  select: { id: true }
              }),
        open.length === 0
            ? []
            : prisma.deployment.findMany({
                  where: {
                      deployableType: "application",
                      deployableId: { in: open },
                      status: { in: [...IN_FLIGHT_DEPLOY_STATUSES] },
                      closesPort: true
                  },
                  select: { deployableId: true },
                  distinct: ["deployableId"]
              })
    ]);
    return directAccessOf(
        services,
        new Set(kept.map((row) => row.id)),
        machineAddress,
        new Set(closing.map((row) => row.deployableId))
    );
}
