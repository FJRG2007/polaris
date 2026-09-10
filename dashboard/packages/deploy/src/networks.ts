/**
 * Which networks a deployed service joins.
 *
 * Every service used to join the one shared proxy network, which meant any
 * container Polaris ran could reach any other by name: a database in one project
 * was a connection string away from an application in somebody else's. An
 * environment now chooses how its services see each other:
 *
 * - `shared` is what every environment made before this does, unchanged.
 * - `environment` gives the environment a private network every service in it
 *   joins. Its services reach each other by name; nothing outside it can.
 * - `links` gives each service a network of its own, and a service joins the
 *   networks of the ones its canvas links point at - so only linked services can
 *   reach each other, and a link drawn on the board is a connection made.
 *
 * In both private modes a service stays on the shared proxy network only when the
 * edge has to reach it there (see `joinsProxy`), and a database never does: it is
 * reached by the services beside it, and the dashboard is attached to the private
 * network by the daemon that creates it.
 *
 * Pure: the names are derived from ids, so a network is found again by name on
 * every deploy, and the daemon that creates it recognises the shape.
 */

import { shortHash } from "./naming.js";

export const NETWORK_MODES = ["shared", "environment", "links"] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];

/** The prefix every private network carries - the only names the daemon creates. */
export const PRIVATE_NETWORK_PREFIX = "polaris-net-";

/** The private network an environment's services share. */
export function environmentNetwork(environmentId: string): string {
    return `${PRIVATE_NETWORK_PREFIX}e${shortHash(`environment:${environmentId}`, 10)}`;
}

/** The private network one service answers on in `links` mode. */
export function serviceNetwork(serviceId: string): string {
    return `${PRIVATE_NETWORK_PREFIX}s${shortHash(`service:${serviceId}`, 10)}`;
}

/** Whether a name is one of these, in exactly the shape the daemon accepts. */
export function isPrivateNetwork(name: string): boolean {
    return /^polaris-net-[es][a-f0-9]{10}$/.test(name);
}

/** A link on an environment's canvas, from one service to another. */
export interface ServiceLink {
    readonly source: string;
    readonly target: string;
}

/** The links an environment's stored canvas layout holds. Anything malformed is
 *  read as no links, which in `links` mode means no service reaches another. */
export function linksOfLayout(layout: string | null | undefined): ServiceLink[] {
    if (!layout) return [];
    try {
        const parsed = JSON.parse(layout) as { links?: unknown };
        if (!Array.isArray(parsed.links)) return [];
        return parsed.links.flatMap((link: unknown) => {
            const entry = link as { source?: unknown; target?: unknown } | null;
            return entry && typeof entry.source === "string" && typeof entry.target === "string"
                ? [{ source: entry.source, target: entry.target }]
                : [];
        });
    } catch {
        return [];
    }
}

export interface NetworkPlanInput {
    readonly mode: NetworkMode;
    /** The shared proxy network the target's edge routes through. */
    readonly proxyNetwork: string;
    readonly environmentId: string;
    readonly serviceId: string;
    /** Whether the edge must reach this service over the proxy network - see
     *  `joinsProxy`. Always false for a database. */
    readonly joinsProxy: boolean;
    /** The canvas links, for `links` mode. */
    readonly links?: readonly ServiceLink[];
}

/**
 * The networks one service joins, proxy first when it joins it at all, so the
 * edge's routing is exactly as it was for every service that still needs it.
 */
export function serviceNetworks(input: NetworkPlanInput): string[] {
    if (input.mode === "shared") return [input.proxyNetwork];
    const proxy = input.joinsProxy ? [input.proxyNetwork] : [];
    if (input.mode === "environment") return [...proxy, environmentNetwork(input.environmentId)];
    // Its own, so what links to it can reach it, and each one it links to. A link
    // in either direction is a connection both ways, because a reply travels the
    // same network the request came in on.
    const peers = new Set<string>();
    for (const link of input.links ?? []) {
        if (link.source === input.serviceId && link.target !== input.serviceId) peers.add(link.target);
    }
    return [...proxy, serviceNetwork(input.serviceId), ...[...peers].sort().map(serviceNetwork)];
}

/**
 * Whether the edge has to reach a service over the proxy network.
 *
 * On this machine the edge dials a service with a published port on the host's
 * own address, so only a service with its port closed and a route to it needs to
 * be on the proxy network - and one without any route is reached by nobody but
 * its neighbours. On another server routing rides the container's own labels
 * over the proxy network, so every routed service there stays on it.
 */
export function joinsProxy(service: {
    readonly local: boolean;
    readonly published: boolean;
    readonly routed: boolean;
}): boolean {
    if (!service.routed) return false;
    return !service.local || !service.published;
}

/** The label every private network is created with - the daemon uses the same -
 *  so the ones nothing wants any more can be found without touching anyone else's. */
export const PRIVATE_NETWORK_LABEL = "polaris.network=private";

/** The containers another server's edge runs as (see `onboardingScript`). They
 *  dial services by name, so they join every private network on that server - a
 *  domain added after a deploy is then reachable without redeploying the service. */
export const REMOTE_EDGE_CONTAINERS = ["polaris-traefik", "polaris-edge-guard"] as const;

/** How many fallback ranges are tried when a server has no address pool left. */
const FALLBACK_ATTEMPTS = 32;

/** FNV-1a over the name, the daemon's own hash, so a network asks for the same
 *  fallback range on every server and every attempt order matches. */
function nameHash(name: string): number {
    let hash = 0x811c9dc5;
    for (const byte of Buffer.from(name, "utf8")) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

/** The `/24` a network tries on its `attempt`th go once Docker's pools are used up. */
export function fallbackSubnet(name: string, attempt: number): string {
    return `10.211.${(nameHash(name) + attempt) % 256}.0/24`;
}

/**
 * The shell statements that make sure each private network exists on another
 * server before compose is asked to join it, and that its edge is on it.
 *
 * The same thing the daemon does on this machine, in a form an SSH session can
 * run: create the network when it is missing, falling back to explicit ranges
 * when Docker has none left, and fail with a sentence when none of them works.
 * Only names in the private shape are ever acted on.
 */
export function ensurePrivateNetworksScript(names: readonly string[], swarm: boolean): string[] {
    const driver = swarm ? "--driver overlay --attachable" : "--driver bridge";
    const statements: string[] = [];
    for (const name of [...new Set(names)].filter(isPrivateNetwork)) {
        const create = `docker network create --label ${PRIVATE_NETWORK_LABEL} ${driver}`;
        const ranges = Array.from({ length: FALLBACK_ATTEMPTS }, (_, attempt) => fallbackSubnet(name, attempt));
        const missing = [
            `${create} ${name} >/dev/null 2>&1 || { for s in ${ranges.join(" ")}; do ${create} --subnet "$s" ${name} >/dev/null 2>&1 && break; done; true; }`,
            `docker network inspect ${name} >/dev/null 2>&1 || { echo "could not create network ${name}: this server has no address range left for another network" >&2; exit 1; }`
        ];
        statements.push(
            `if ! docker network inspect ${name} >/dev/null 2>&1; then ${missing.join("; ")}; fi`,
            `for c in ${REMOTE_EDGE_CONTAINERS.join(" ")}; do docker network connect ${name} "$c" >/dev/null 2>&1 || true; done`
        );
    }
    return statements;
}

/** The private networks in a list, in order - what a connector or an edge has to
 *  join to reach a service by name once it has left the proxy network. */
export function privateNetworksOf(networks: readonly string[]): string[] {
    return [...new Set(networks.filter(isPrivateNetwork))];
}
