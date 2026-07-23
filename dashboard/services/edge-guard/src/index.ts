/**
 * polaris-edge-guard entrypoint. A tiny stateless sidecar co-deployed on each
 * server's edge that Traefik forwardAuths to for the WAF denylist and require-login
 * controls. It holds no rule state - every rule arrives per request in the
 * X-Polaris-Waf header - so it keeps enforcing when the Polaris control plane is
 * down. The only secret it needs is POLARIS_AUTH_SECRET, to verify signed edge
 * tokens offline; deny-only routes need no secret at all.
 */

import { createGuardServer } from "./server.js";
import type { GuardConfig } from "./authz.js";

/** Resolve the guard config from the environment (re-read per request). */
function loadConfig(): GuardConfig {
    return {
        secret: process.env.POLARIS_AUTH_SECRET ?? "",
        authorizeUrl: (process.env.POLARIS_PUBLIC_URL ?? "").replace(/\/+$/, ""),
        cookieName: process.env.POLARIS_EDGE_COOKIE ?? "polaris.edge",
        now: Math.floor(Date.now() / 1000)
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
