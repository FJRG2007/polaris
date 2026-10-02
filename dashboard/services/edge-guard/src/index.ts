/**
 * polaris-edge-guard entrypoint. A tiny stateless sidecar co-deployed on each
 * server's edge that Traefik forwardAuths to for the WAF denylist and require-login
 * controls. It holds no rule state - every rule arrives per request in the
 * X-Polaris-Waf header - so it keeps enforcing when the Polaris control plane is
 * down. The only secret it needs is POLARIS_AUTH_SECRET, to verify signed edge
 * tokens offline; deny-only routes need no secret at all.
 */

import { randomBytes } from "node:crypto";
import type { GuardConfig } from "./authz.js";
import { createIntelSource } from "./intel.js";
import { createControlPlaneWatch, probeHealth } from "./control-plane.js";
import { createProxyServer } from "./proxy.js";
import { createGuardServer } from "./server.js";

/** Bans, Tor exits and flagged addresses, published by Polaris into a shared volume
 *  and held in memory here. Unset = the feature is not deployed; the guard then
 *  enforces only what each request's own header carries. */
const intel = createIntelSource(process.env.POLARIS_EDGE_INTEL_FILE);

/** What the browser challenge signs with when no shared secret was given - made once
 *  per process, so the challenge works on any guard and its passes simply lapse with
 *  a restart. */
const processKey = randomBytes(32).toString("base64url");

/** Whether the Polaris each route signs visitors in through is answering. Probed in
 *  the background, never on the request path - see control-plane.ts.
 *
 *  POLARIS_CONTROL_PLANE_URL is the address this container reaches Polaris on directly,
 *  set only where the two share a network. The public address is what visitors use, but
 *  from beside Polaris it is often unreachable (no hairpin NAT, split DNS), which would
 *  read as Polaris being down while it is up. */
const probeVia = (process.env.POLARIS_CONTROL_PLANE_URL ?? "").replace(/\/+$/, "");
const controlPlane = createControlPlaneWatch((base) => probeHealth(probeVia || base));

/** Resolve the guard config from the environment (re-read per request). */
function loadConfig(): GuardConfig {
    const now = Date.now();
    const secret = process.env.POLARIS_AUTH_SECRET ?? "";
    return {
        secret,
        authorizeUrl: (process.env.POLARIS_PUBLIC_URL ?? "").replace(/\/+$/, ""),
        cookieName: process.env.POLARIS_EDGE_COOKIE ?? "polaris.edge",
        now: Math.floor(now / 1000),
        intel: intel.current(now),
        challengeSecret: secret || processKey,
        nonce: randomBytes(12).toString("base64url"),
        controlPlane: (base) => controlPlane.reachable(base, now)
    };
}

const port = Number(process.env.POLARIS_EDGE_GUARD_PORT ?? 8080);
const startup = loadConfig();
if (!startup.secret) {
    console.warn("polaris-edge-guard: POLARIS_AUTH_SECRET is unset; require-login routes will always redirect to login.");
}
if (!startup.authorizeUrl) {
    console.warn("polaris-edge-guard: POLARIS_PUBLIC_URL is unset; login redirects will be malformed until it is set.");
}

createGuardServer(loadConfig).listen(port, () => {
    console.log(`polaris-edge-guard listening on :${port}`);
});

/**
 * The proxy listens separately, on its own port.
 *
 * Two ports rather than one server telling the two apart by path, because they are
 * reached for opposite reasons and confusing them is expensive: :8080 answers Traefik's
 * forwardAuth question about a request, and :8081 IS the upstream for a route whose
 * response gets rewritten. A route that reached the wrong one would either have its
 * page served as an auth check or its auth check served as a page.
 */
const proxyPort = Number(process.env.POLARIS_EDGE_PROXY_PORT ?? 8081);
createProxyServer(loadConfig).listen(proxyPort, () => {
    console.log(`polaris-edge-guard proxy listening on :${proxyPort}`);
});
