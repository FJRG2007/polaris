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
import { callServer } from "@/lib/chat/call-server";

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

/** The edge config for the call server, or an empty one when there is nothing to
 *  route. Pure, so what the edge is asked to serve can be asserted without a
 *  filesystem. */
export function renderCallServerRoute(serve: boolean): string {
    if (!serve) return "http: {}\n";
    return [
        "http:",
        "  routers:",
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
        ""
    ].join("\n");
}

/**
 * Publish it, or unpublish it. Idempotent, and best-effort in the same way the
 * dashboard's own route is: a dynamic directory that is missing is a dev run
 * outside compose, and it must not turn saving a setting into an error.
 */
export async function syncCallServerRoute(): Promise<void> {
    try {
        const endpoint = await callServer();
        // Only for the server this stack runs. One somebody typed has an address
        // of its own and is dialled directly by the browser.
        const serve = endpoint?.shipped === true;
        await writeFile(join(dynamicDir(), FILE), renderCallServerRoute(serve), "utf8");
    } catch (error) {
        console.error(
            "polaris: publishing the call server route failed:",
            error instanceof Error ? error.message : error
        );
    }
}
