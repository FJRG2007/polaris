/**
 * The VPN host at the edge, beyond the plain route Deploy writes for it.
 *
 * Two things the generic app route cannot do:
 *
 * - **No guard in front.** A Tailscale client speaks the control protocol, not
 *   a browser's HTTP: `/key` and `/health` in plain requests, and `/ts2021` as an
 *   HTTP Upgrade (`tailscale-control-protocol`, or a WebSocket from a browser
 *   client) that then carries the Noise session for as long as the device is
 *   up. A bot challenge, a browser-integrity check or a login wall answers that
 *   with a page no client can read, and every device drops off at once. So the
 *   control server's routes are published with no firewall rule on them
 *   (`passthroughWaf`, read by `publishAppRoutes`), whatever the global rules
 *   say - Headscale authenticates every one of those requests itself, by the
 *   machine key.
 * - **Browser sign-in lands on Polaris.** A client with no key opens
 *   `https://<vpn host>/register/<auth id>` in the browser. Headscale's own page
 *   there tells the reader to run a command, and Polaris's session cookie lives
 *   on the dashboard's hostname, not this one, so the edge sends that path to
 *   the dashboard's page for it instead (`/apps/vpn/register/<auth id>`), where
 *   the person signed in adds the device with one press.
 *
 * Every write goes through `writeDynamicFile`, and the file is rendered by a
 * pure function so it is asserted in a test.
 */

import { NO_ROUTES_FILE } from "@polaris/core";
import { writeDynamicFile } from "@/lib/traefik-dynamic";

const FILE = "polaris-vpn.yml";
const ROUTER = "polaris-vpn-register";

/**
 * Above the VPN host's own app router (40, 45 with a path) and the dashboard's
 * public hostnames (50), below the host-less path routers (100) - which never
 * carry `/register/` - and the guarded call path (110).
 */
const PRIORITY = 60;

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const BASE_URL = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/;

export interface VpnEdgeInput {
    /** The control server's hostname, or null when it has none. */
    readonly hostname: string | null;
    /** Where Polaris's dashboard is reached, as `appBaseUrl` gives it. */
    readonly dashboardUrl: string;
}

/** The edge file for the VPN. Nothing routed for a hostname or a dashboard
 *  address that is not one, rather than a rule the edge refuses to load. */
export function renderVpnEdge(input: VpnEdgeInput): string {
    const base = input.dashboardUrl.replace(/\/+$/, "");
    if (!input.hostname || !HOSTNAME.test(input.hostname) || !BASE_URL.test(base)) {
        return NO_ROUTES_FILE;
    }
    return [
        "http:",
        "  routers:",
        `    ${ROUTER}:`,
        `      rule: "Host(\`${input.hostname}\`) && PathPrefix(\`/register/\`)"`,
        "      entryPoints: [websecure]",
        `      priority: ${PRIORITY}`,
        // Never reached: the redirect answers every request this router takes.
        "      service: noop@internal",
        `      middlewares: [${ROUTER}]`,
        "      tls:",
        "        certResolver: letsencrypt",
        "  middlewares:",
        `    ${ROUTER}:`,
        "      redirectRegex:",
        // Only an id in the shape Headscale mints; anything else stays where it is.
        `        regex: "^https?://[^/]+/register/(hskey-authreq-[A-Za-z0-9_-]{24})$"`,
        `        replacement: "${base}/apps/vpn/register/\${1}"`,
        "        permanent: false",
        ""
    ].join("\n");
}

/** Publish the VPN's edge file, or empty it. Best-effort, like the call route:
 *  a missing dynamic directory is a dev run outside compose. */
export async function syncVpnEdge(input: VpnEdgeInput): Promise<boolean> {
    try {
        await writeDynamicFile(FILE, renderVpnEdge(input));
        return true;
    } catch (error) {
        console.error(
            "polaris: publishing the VPN's edge route failed:",
            error instanceof Error ? error.message : error
        );
        return false;
    }
}

/** The firewall decision every route of the control server is published with:
 *  nothing in front of it (see the module comment). */
export const passthroughWaf = {
    allowLists: [],
    deny: [],
    requireLogin: false,
    loginAllowLists: [],
    loginDeny: [],
    browserIntegrity: false,
    sqlInjectionProtection: false,
    xssProtection: false,
    emailObfuscation: false,
    frameProtection: false,
    frameAncestors: [],
    presets: [],
    rules: []
};
