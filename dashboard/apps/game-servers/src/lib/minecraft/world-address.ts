/**
 * Where a server and its players reach the map archives this instance serves.
 *
 * A player's client is somewhere on the internet, so a pack needs the public
 * address and has none without one. A server's container is usually on this
 * machine, and it must not need one: `polaris.local` does not resolve inside a
 * container, and an instance with no public address is exactly the one whose
 * maps would otherwise stop working. So without a public address a world is
 * fetched through the edge from inside the container network - a game server
 * joins the proxy network the edge is on, and reaches it by the edge's
 * container name.
 *
 * The edge has no route for that name of its own, so this app publishes one in
 * its edge file (`polaris-app-game-servers.yml`): plain HTTP on the internal
 * name, the world path only, to the dashboard. The world path is keyed, so the
 * route opens nothing a key does not already open. Written whenever an address
 * is asked for and by the component sweep, so it exists on every instance after
 * the update without anybody doing anything.
 *
 * A server on another machine reaches neither this edge nor its name, and
 * fetches its world from the public address - which is the one it is given
 * whenever there is one.
 */

import { modToken } from "./mod-token";
import { host } from "@polaris/app-host";
import { WORLD_PATH, type MapAddresses } from "./maps";

const APP_ID = "game-servers";
const ROUTER = "polaris-game-servers-worlds";

/**
 * In the band of the path routers that have to keep winning their prefix (see
 * the edge section of CLAUDE.md). Nothing else claims this host on plain HTTP,
 * but the number is stated rather than left to the length of the rule.
 */
const PRIORITY = 100;

/** The edge as a container on the proxy network reaches it. */
export function internalEdgeOrigin(): string {
    return process.env.POLARIS_EDGE_ORIGIN || "http://traefik";
}

const HOSTNAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;
const ORIGIN = /^https?:\/\/[A-Za-z0-9.:[\]-]+\/?$/;

/** The edge file: one router for the world path on the internal name. A name or
 *  an origin that is not plainly one publishes nothing, so a configured value
 *  cannot reach the YAML unchecked. */
export function renderWorldEdge(edgeHost: string, origin: string): string {
    if (!HOSTNAME.test(edgeHost) || !ORIGIN.test(origin)) return "http: {}\n";
    return [
        "http:",
        "  routers:",
        `    ${ROUTER}:`,
        `      rule: "Host(\`${edgeHost}\`) && PathPrefix(\`${WORLD_PATH}/\`)"`,
        "      entryPoints: [web]",
        `      priority: ${PRIORITY}`,
        `      service: ${ROUTER}`,
        "  services:",
        `    ${ROUTER}:`,
        "      loadBalancer:",
        "        servers:",
        `          - url: "${origin}"`,
        ""
    ].join("\n");
}

/** Writes the route. Logs and carries on when the edge cannot be written: the
 *  next sweep writes it again. */
export async function syncWorldEdge(): Promise<boolean> {
    try {
        const edgeHost = new URL(internalEdgeOrigin()).hostname;
        const origin = await host.appEdge.appEdgeOrigin();
        await host.appEdge.writeAppEdge(APP_ID, renderWorldEdge(edgeHost, origin));
        return true;
    } catch (caught) {
        console.error(
            "[minecraft-world] the world route was not written:",
            caught instanceof Error ? caught.message : caught
        );
        return false;
    }
}

/** Where the archives are served from now. Writes the internal route when it is
 *  the one a world will be fetched through. */
export async function mapAddresses(): Promise<MapAddresses> {
    const pub = await host.domainService.publicAppUrl().catch(() => null);
    if (pub === null) await syncWorldEdge();
    return { world: pub ?? internalEdgeOrigin(), pack: pub, key: modToken() };
}
