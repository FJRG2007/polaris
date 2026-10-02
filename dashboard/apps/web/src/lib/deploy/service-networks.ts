/**
 * Which networks each deployed service joins, read from what is stored.
 *
 * The planning itself is pure and lives in `@polaris/deploy` (`serviceNetworks`);
 * this is the half that knows where the answers come from: the environment's
 * mode and canvas, whether the service is routed or published, and whether the
 * target can hold a private network at all. A machine whose daemon predates
 * private networks says so in its capabilities, and every service on it stays on
 * the proxy network whatever its environment asks for - the deploy still works,
 * and the next update makes the choice take effect.
 *
 * It also keeps this machine's networks settled: the daemon attaches Polaris's
 * own containers to every private network a deploy names, but an update recreates
 * those containers without them, and an environment switched back to shared
 * leaves a network nothing needs. `reconcilePrivateNetworks` puts both right, on
 * a schedule and once at startup.
 */

import { prisma } from "@polaris/db";
import { getCapabilities } from "@polaris/config";
import { HostdClient } from "@polaris/hostd-client";
import * as deploy from "@polaris/deploy";

/**
 * How an environment made from the Deploy screen keeps its services: closed to
 * every other project, the way Railway's environments are. Environments made
 * before, and the ones Polaris makes for an installed app - whose services the
 * stack's own routers dial on the shared network - keep the column's default.
 */
export const NEW_ENVIRONMENT_NETWORK_MODE: deploy.NetworkMode = "environment";

/** The stored mode, or "shared" for anything that is not one of the three. */
export function networkModeOf(stored: string | null | undefined): deploy.NetworkMode {
    return (deploy.NETWORK_MODES as readonly string[]).includes(stored ?? "")
        ? (stored as deploy.NetworkMode)
        : "shared";
}

interface TargetFacts {
    readonly kind: string;
    readonly hostId: string | null;
    readonly proxyNetwork: string;
}

function isLocal(target: Pick<TargetFacts, "kind" | "hostId">): boolean {
    return target.kind === "local" || !target.hostId;
}

/**
 * Whether a target can hold private networks. Another server always can: the
 * deploy script makes them over SSH. This machine can when its daemon says it
 * makes them - an older one would hand compose a network that does not exist.
 */
export function privateNetworksOn(target: Pick<TargetFacts, "kind" | "hostId">): boolean {
    return isLocal(target) ? getCapabilities().privateNetworks : true;
}

export interface ServiceNetworkFacts {
    readonly environment: {
        readonly id: string;
        readonly networkMode: string;
        readonly layout: string;
    };
    readonly serviceId: string;
    readonly target: TargetFacts;
    /** Whether the service publishes a port on the host. Always false for a
     *  database that is not exposed. */
    readonly published: boolean;
    /** Whether anything routes to it: a domain, or a tunnel. Always false for a
     *  database. */
    readonly routed: boolean;
    /** Whether it carries private names (see `private-names.ts`), and the networks
     *  of its links to other projects. */
    readonly names?: boolean;
    readonly crossLinks?: readonly string[];
}

/**
 * Whether a tunnel is set up for an application - a quick, ngrok or named one.
 * Each keeps its state under a setting of its own (see the three tunnel services),
 * and a tunnel counts as a route: its connector dials the service by name.
 */
export async function hasTunnel(applicationId: string): Promise<boolean> {
    const found = await prisma.setting.findFirst({
        where: {
            key: {
                in: [
                    `deploy.qtunnel.${applicationId}`,
                    `deploy.ngrok.${applicationId}`,
                    `deploy.ntunnel.${applicationId}.token`
                ]
            }
        },
        select: { key: true }
    });
    return found !== null;
}

/** The networks one service joins on its next deploy. */
export function networksForService(facts: ServiceNetworkFacts): string[] {
    const mode = privateNetworksOn(facts.target)
        ? networkModeOf(facts.environment.networkMode)
        : "shared";
    return deploy.serviceNetworks({
        mode,
        proxyNetwork: facts.target.proxyNetwork,
        environmentId: facts.environment.id,
        serviceId: facts.serviceId,
        joinsProxy: deploy.joinsProxy({
            local: isLocal(facts.target),
            published: facts.published,
            routed: facts.routed
        }),
        links: deploy.linksOfLayout(facts.environment.layout),
        names: facts.names,
        crossLinks: facts.crossLinks
    });
}

/**
 * The private networks an application is on, for whatever has to reach it by
 * name from outside its environment - a tunnel's connector, which dials the
 * container itself when its port is closed. Empty for a shared environment.
 */
export async function privateNetworksOfApp(applicationId: string): Promise<string[]> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: {
            id: true,
            publishPort: true,
            target: { select: { kind: true, hostId: true, proxyNetwork: true } },
            environment: { select: { id: true, networkMode: true, layout: true } },
            domains: { where: { enabled: true }, select: { id: true }, take: 1 }
        }
    });
    if (!app) return [];
    return deploy.privateNetworksOf(
        networksForService({
            environment: app.environment,
            serviceId: app.id,
            target: app.target,
            published: app.publishPort,
            routed: app.domains.length > 0
        })
    );
}

/** The networks a tunnel's connector for this application joins: the proxy
 *  network it always had, and the application's private ones, so a service with
 *  its port closed is still reached by name once it has left the proxy network. */
export async function connectorNetworks(
    applicationId: string,
    proxyNetwork: string
): Promise<string[]> {
    return [...new Set([proxyNetwork, ...(await privateNetworksOfApp(applicationId))])];
}

/**
 * Every private network Polaris still has a use for: each isolated environment's
 * own, and in `links` mode each of its services'. Named whatever machine they run
 * on - a name that is not on this one is simply not there to keep.
 *
 * Where this machine gives services their private names, also every
 * environment's names network (each service's, in `links` mode) and every link
 * between two projects. An older daemon would refuse those names outright, so
 * they are only sent to one that makes them.
 */
export async function wantedPrivateNetworks(): Promise<string[]> {
    const names = getCapabilities().privateNames;
    const environments = await prisma.environment.findMany({
        where: names ? {} : { networkMode: { not: "shared" } },
        select: {
            id: true,
            networkMode: true,
            applications: { select: { id: true } },
            databases: { select: { id: true } }
        }
    });
    const wanted = new Set<string>();
    for (const environment of environments) {
        const mode = networkModeOf(environment.networkMode);
        if (mode === "environment") wanted.add(deploy.environmentNetwork(environment.id));
        if (mode === "links") {
            for (const service of [...environment.applications, ...environment.databases]) {
                wanted.add(deploy.serviceNetwork(service.id));
                if (names) wanted.add(deploy.serviceNamesNetwork(service.id));
            }
        } else if (names) {
            wanted.add(deploy.namesNetwork(environment.id));
        }
    }
    if (names) {
        const links = await prisma.privateLink.findMany({ select: { id: true }, take: MAX_LINKS });
        for (const link of links) wanted.add(deploy.crossLinkNetwork(link.id));
    }
    return [...wanted].sort();
}

/** The most links between projects one reconcile reads. */
const MAX_LINKS = 5000;

/** Where which private networks on this machine are dual stack is remembered
 *  between reconciles. */
const IPV6_SETTING = "deploy.privnet.ipv6";

/**
 * Which of this machine's private networks are dual stack, as the last
 * reconcile found them - or null when that is not known: never reconciled yet,
 * or a daemon that does not say.
 */
export async function dualStackNetworks(): Promise<ReadonlySet<string> | null> {
    const row = await prisma.setting.findUnique({
        where: { key: IPV6_SETTING },
        select: { value: true }
    });
    if (!row) return null;
    try {
        const parsed = JSON.parse(row.value) as unknown;
        return Array.isArray(parsed)
            ? new Set(parsed.filter((one): one is string => typeof one === "string"))
            : null;
    } catch {
        return null;
    }
}

/**
 * Settle this machine's private networks against the ones still wanted. Nothing
 * to do where the daemon cannot make them. A network an application is still on
 * is never removed - the daemon checks - so an environment switched back to
 * shared keeps working until its services are deployed onto the new setting.
 */
export async function reconcilePrivateNetworks(): Promise<{
    kept: number;
    removed: number;
} | null> {
    if (!getCapabilities().privateNetworks) return null;
    // A link whose service is gone has no network left to keep.
    await pruneCrossLinks();
    const report = await new HostdClient().reconcilePrivateNetworks(await wantedPrivateNetworks());
    if (report.ipv6) {
        const value = JSON.stringify([...report.ipv6].sort());
        await prisma.setting.upsert({
            where: { key: IPV6_SETTING },
            create: { key: IPV6_SETTING, value },
            update: { value }
        });
    }
    return { kept: report.kept, removed: report.removed };
}

/**
 * Remove the links between projects whose services are gone. A link names its
 * two services by id with no key behind it, so removing a service leaves the
 * row; it is skipped wherever it is read, and dropped here.
 */
export async function pruneCrossLinks(): Promise<number> {
    const links = await prisma.privateLink.findMany({
        select: { id: true, targetKind: true, targetId: true, sourceId: true },
        take: MAX_LINKS
    });
    if (links.length === 0) return 0;
    const targets = (kind: string) =>
        links.filter((link) => link.targetKind === kind).map((link) => link.targetId);
    const [sources, apps, dbs] = await Promise.all([
        prisma.application.findMany({
            where: { id: { in: links.map((link) => link.sourceId) } },
            select: { id: true }
        }),
        prisma.application.findMany({
            where: { id: { in: targets("application") } },
            select: { id: true }
        }),
        prisma.managedDatabase.findMany({
            where: { id: { in: targets("database") } },
            select: { id: true }
        })
    ]);
    const present = new Set([...sources, ...apps, ...dbs].map((one) => one.id));
    const gone = links
        .filter((link) => !present.has(link.sourceId) || !present.has(link.targetId))
        .map((link) => link.id);
    if (gone.length > 0) await prisma.privateLink.deleteMany({ where: { id: { in: gone } } });
    return gone.length;
}
