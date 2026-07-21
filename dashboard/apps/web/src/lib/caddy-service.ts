/**
 * Runtime routing for deployed-app domains through Caddy's admin API. Caddy
 * already fronts the dashboard, so rather than run a second reverse proxy we add
 * and remove routes on it at runtime: each app domain is sent to the app's
 * published host port (host IP + port), which every deploy exposes. Changes are
 * additive and keyed by a stable `@id` per domain, so the dashboard's own routes
 * are never touched and re-syncing is idempotent.
 *
 * Caveat: admin-API changes live in Caddy's running config, which is rebuilt from
 * the Caddyfile on a full reload (e.g. a dashboard update). Routes are therefore
 * re-synced on every deploy so they self-heal.
 */

const admin = (): string => process.env.POLARIS_CADDY_ADMIN ?? "http://caddy:2019";
const routeId = (domainId: string): string => `polaris-app-${domainId}`;
const tlsId = (domainId: string): string => `polaris-apptls-${domainId}`;

export type DomainCert = "internal" | "le" | "none";

async function adminFetch(path: string, init?: RequestInit): Promise<Response | null> {
    try {
        return await fetch(`${admin()}${path}`, {
            ...init,
            headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
        });
    } catch {
        // Caddy not reachable (e.g. sandboxed edition without the proxy): routing is
        // best-effort - the app is still reachable over its host IP:port directly.
        return null;
    }
}

/** Find the running server whose listener includes the given address (":443"/":80"). */
async function findServer(listen: string): Promise<string | null> {
    const res = await adminFetch("/config/apps/http/servers/");
    if (!res || !res.ok) return null;
    const servers = (await res.json()) as Record<string, { listen?: string[] }>;
    for (const [name, cfg] of Object.entries(servers)) {
        if ((cfg.listen ?? []).some((address) => address.includes(listen))) return name;
    }
    return null;
}

/**
 * Add or replace the Caddy route (and, for the internal CA, the TLS policy) that
 * serves one app domain. `dial` is the app's "host:port". A public domain (le)
 * gets automatic HTTPS; a free/LAN domain (internal) is served with Caddy's
 * internal CA; "none" serves plain HTTP.
 */
export async function syncDomainRoute(input: {
    domainId: string;
    hostname: string;
    dial: string;
    cert: DomainCert;
}): Promise<void> {
    await removeDomainRoute(input.domainId);
    const server = await findServer(input.cert === "none" ? ":80" : ":443");
    if (!server) return;

    const route = {
        "@id": routeId(input.domainId),
        match: [{ host: [input.hostname] }],
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: input.dial }] }],
        terminal: true
    };
    await adminFetch(`/config/apps/http/servers/${server}/routes`, {
        method: "POST",
        body: JSON.stringify(route)
    });

    if (input.cert === "internal") {
        const policy = { "@id": tlsId(input.domainId), subjects: [input.hostname], issuers: [{ module: "internal" }] };
        await adminFetch("/config/apps/tls/automation/policies", {
            method: "POST",
            body: JSON.stringify(policy)
        });
    }
}

/** Remove the route and TLS policy for a domain (idempotent). */
export async function removeDomainRoute(domainId: string): Promise<void> {
    await adminFetch(`/id/${routeId(domainId)}`, { method: "DELETE" });
    await adminFetch(`/id/${tlsId(domainId)}`, { method: "DELETE" });
}
