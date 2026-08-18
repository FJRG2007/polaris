/**
 * The call server's signalling route at the edge.
 *
 * It has to go through the edge at all because the dashboard is served over
 * HTTPS and a page on HTTPS may not open a plain WebSocket - a media server on a
 * bare port is one the browser refuses to dial before it has sent a byte. On a
 * path rather than a subdomain, so this needs no DNS record and no second
 * certificate: the browser dials whichever hostname it already reached Polaris
 * on, which is the local name from the sofa and the domain from a phone.
 *
 * Written here rather than declared as container labels, because the media
 * server runs on the host's network - it has to, or the addresses it hands
 * browsers reach nothing - and a container with no address on any Docker network
 * is one the label discovery cannot build a route to. So it goes in the file the
 * edge watches, beside the dashboard's own, and is dialled the way the edge
 * dials a deployed app: by the host's name from inside the network.
 *
 * Conditional, which is the other reason it is not a static file: an instance
 * pointed at a call server somebody else runs has no use for this route, and
 * leaving one behind would publish a path that reaches nothing.
 */

import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { dashboardHosts } from "@/lib/domain-edge";
import { callServer } from "@/lib/chat/call-server";
import { resolvePolarisWaf } from "@/lib/waf-service";

/** Traefik's file-provider directory, the volume both containers mount. */
function dynamicDir(): string {
    return process.env.POLARIS_TRAEFIK_DYNAMIC_DIR ?? "/dynamic";
}

/** Where the shipped media server answers, from inside the Docker network. By
 *  this name rather than by the box's address: that one is read once and stored,
 *  and when the lease moves the route answers 502 with a healthy server behind
 *  it. The same name every app route already uses. */
function callServerOrigin(): string {
    return process.env.POLARIS_CALL_SERVER_ORIGIN ?? "http://host.docker.internal:7880";
}

const FILE = "polaris-livekit.yml";
const ROUTER = "polaris-livekit";
const STRIP = `${ROUTER}-strip`;
/** The same path on the hostnames the firewall's allowlist covers. Its own
 *  router, and its own middleware name: the file provider merges every file into
 *  one config, so a name borrowed from the dashboard's route is a duplicate. */
const GUARDED = `${ROUTER}-guarded`;
const ALLOW = `${ROUTER}-allow`;

/** The path the browser dials. Matches POLARIS_CALL_SERVER_URL's default, which
 *  is what tells the browser to come here in the first place. */
export const CALL_PATH = "/livekit";

/**
 * Above the dashboard's own host rules, which would otherwise take this path.
 * The same 100 the terminal WebSocket router uses, and for the same reason: a
 * router with no host of its own has to keep winning its prefix on every
 * hostname, and Traefik otherwise ranks by rule length.
 */
const PRIORITY = 100;

/**
 * Who may reach this path on the hostnames the firewall covers.
 *
 * A path router matches every hostname, so without this it outranks the
 * dashboard's own route on the operator's domain and answers from anywhere -
 * quietly stepping outside a restriction they set on purpose. Scoped to those
 * hostnames rather than applied to the path everywhere, because the local names
 * have no firewall rule of their own and a call between two devices in the house
 * must keep working while the internet is shut out.
 *
 * The allowlist and nothing else. The rest of the firewall is the edge guard,
 * which judges a request by its URL and its headers - there is nothing of the
 * sort in a WebSocket upgrade, and putting it in front of one buys nothing for
 * the risk of ending every call at the handshake.
 */
export interface CallRouteGuard {
    /** The public hostnames the dashboard's own route serves. */
    readonly hosts: readonly string[];
    /** The addresses allowed to reach them. Empty means no restriction was set,
     *  and then there is nothing to carry over. */
    readonly allow: readonly string[];
}

/** The edge config for the call server, or an empty one when there is nothing to
 *  route. Pure, so what the edge is asked to serve can be asserted without a
 *  filesystem. */
export function renderCallServerRoute(serve: boolean, guard?: CallRouteGuard): string {
    if (!serve) return "http: {}\n";
    const hosts = guard?.hosts ?? [];
    const allow = guard?.allow ?? [];
    const guarded = hosts.length > 0 && allow.length > 0;
    const guardedRouter = guarded
        ? [
              `    ${GUARDED}:`,
              `      rule: "(${hosts.map((host) => `Host(\`${host}\`)`).join(" || ")}) && PathPrefix(\`${CALL_PATH}\`)"`,
              "      entryPoints: [websecure]",
              // Above the open one, which still carries the path on every other
              // name this deployment answers to.
              `      priority: ${PRIORITY + 10}`,
              `      service: ${ROUTER}`,
              `      middlewares: [${ALLOW}, ${STRIP}]`,
              "      tls: {}"
          ]
        : [];
    const allowList = guarded
        ? [
              `    ${ALLOW}:`,
              "      ipAllowList:",
              `        sourceRange: [${allow.map((entry) => `"${entry}"`).join(", ")}]`
          ]
        : [];
    return [
        "http:",
        "  routers:",
        ...guardedRouter,
        `    ${ROUTER}:`,
        `      rule: "PathPrefix(\`${CALL_PATH}\`)"`,
        "      entryPoints: [websecure]",
        `      priority: ${PRIORITY}`,
        `      service: ${ROUTER}`,
        `      middlewares: [${STRIP}]`,
        "      tls: {}",
        "  services:",
        `    ${ROUTER}:`,
        "      loadBalancer:",
        "        servers:",
        `          - url: "${callServerOrigin()}"`,
        "  middlewares:",
        // The media server serves from the root, so the prefix comes back off
        // on the way in.
        `    ${STRIP}:`,
        "      stripPrefix:",
        "        prefixes:",
        `          - "${CALL_PATH}"`,
        ...allowList,
        ""
    ].join("\n");
}

/**
 * Publish it, or unpublish it. Idempotent, and best-effort in the same way the
 * dashboard's own route is: a dynamic directory that is missing is a dev run
 * outside compose, and it must not turn saving a setting into an error.
 *
 * @returns whether the route was written. Reported rather than swallowed because
 *   this file is the whole of how a browser reaches the media server: a database
 *   still starting when this first runs would otherwise leave no route at all,
 *   and every call would fail at the WebSocket until somebody saved a domain.
 */
export async function syncCallServerRoute(): Promise<boolean> {
    try {
        const endpoint = await callServer();
        // Only for the server this stack runs. One somebody typed has an address
        // of its own and is dialled directly by the browser.
        const serve = endpoint?.shipped === true;
        // Read before the write, and not caught into an empty default: publishing
        // the path without the allowlist is publishing it to everybody, so a read
        // that fails leaves the file as it is and says so below.
        const [hosts, waf] = await Promise.all([dashboardHosts(), resolvePolarisWaf()]);
        const guard = { hosts, allow: waf.allowLists[0] ?? [] };
        await writeFile(join(dynamicDir(), FILE), renderCallServerRoute(serve, guard), "utf8");
        // Written, and still not settled. There are two reasons this publishes
        // nothing - calls deliberately run somewhere else, or the shipped server
        // could not be prepared this early - and only the first is an answer.
        // Reported as success, the second takes the route away at boot and nothing
        // puts it back, so every call fails at the WebSocket on a deployment that
        // was one retry from working.
        return serve || endpoint !== null;
    } catch (error) {
        console.error(
            "polaris: publishing the call server route failed:",
            error instanceof Error ? error.message : error
        );
        return false;
    }
}
