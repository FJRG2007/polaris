/**
 * The app's better-auth instance. Constructed once here (env is guaranteed in a
 * running server) from the shared factory, and re-exported so route handlers,
 * server actions, and the session helpers all share one configuration. Requests
 * to the auth endpoints go through handleAuthRequest instead, which differs only
 * in which address a passkey is bound to.
 *
 * The hostnames this deployment answers on are resolved per request from the domain
 * configuration - the same list published to the edge - so signing in on a domain
 * configured after install works immediately, instead of being refused as an
 * untrusted origin until someone restarts the container. The domain modules are
 * imported lazily inside the resolver: they reach the database, and this module is
 * loaded by everything.
 */

import { createRequestAuth } from "@polaris/auth";

const requestAuth = createRequestAuth({
    configuredHosts: async () => {
        const [{ dashboardHosts, publicHostname }, { getPolarisPublicUrl }] = await Promise.all([
            import("./domain-edge"),
            import("./polaris-tunnel-service")
        ]);
        const [hosts, tunnel] = await Promise.all([
            dashboardHosts(),
            // A tunnel publishes the dashboard on a hostname nobody configured - the
            // provider mints it - so it is collected separately from the domains.
            getPolarisPublicUrl().catch(() => null)
        ]);
        const tunnelHost = publicHostname(tunnel);
        return tunnelHost ? [...hosts, tunnelHost] : hosts;
    },
    // Lazily imported for the same reason as the domain modules: the mail service
    // reaches the database and pulls in an SMTP client, and this module is loaded
    // by everything. Resolved per send, so nominating a channel takes effect
    // without a restart.
    sendMail: async (message) => {
        const { sendAuthEmail } = await import("./auth-mail");
        return sendAuthEmail(message);
    },
    // Same reason, and the same per-send resolution: which methods an account
    // accepts, and whether any of them can deliver, is decided at the moment a
    // code is asked for rather than fixed when the server started.
    sendTwoFactorCode: async (input) => {
        const { sendTwoFactorCode } = await import("./two-factor-delivery");
        return sendTwoFactorCode(input);
    }
});

export const auth = requestAuth.auth;

/**
 * The catch-all route's handler. It serves each request with the passkey relying
 * party of the address it arrived on, so a passkey can be added and used on any
 * of the names this deployment answers on rather than only the published one.
 */
export const handleAuthRequest = requestAuth.handle;
