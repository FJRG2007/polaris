/**
 * The app's better-auth instance. Constructed once here (env is guaranteed in a
 * running server) from the shared factory, and re-exported so route handlers,
 * server actions, and the session helpers all share one configuration.
 *
 * The hostnames this deployment answers on are resolved per request from the domain
 * configuration - the same list published to the edge - so signing in on a domain
 * configured after install works immediately, instead of being refused as an
 * untrusted origin until someone restarts the container. The domain modules are
 * imported lazily inside the resolver: they reach the database, and this module is
 * loaded by everything.
 */

import { createAuth } from "@polaris/auth";

export const auth = createAuth({
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
    }
});
