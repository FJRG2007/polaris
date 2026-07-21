/**
 * Minimal Cloudflare API v4 client for the automated named-tunnel flow. With an
 * account-scoped API token (Account - Cloudflare Tunnel: Edit, Zone - DNS: Edit,
 * Zone: Read) Polaris can create a remotely-managed tunnel, read its connector
 * token, push its ingress rules, and manage the proxied DNS record - so an
 * operator only picks a hostname and Polaris does the rest. Only the endpoints
 * that flow uses are implemented here; every response shape we depend on is
 * checked before use so a changed or error payload throws instead of corrupting
 * state.
 */

const API_BASE = "https://api.cloudflare.com/client/v4";

interface CfEnvelope<T> {
    success: boolean;
    errors?: Array<{ code?: number; message?: string }>;
    result: T;
}

/** Call the Cloudflare API and return `result`, throwing the API's own error text. */
async function cf<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`${API_BASE}${path}`, {
            method,
            cache: "no-store",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch (caught) {
        throw new Error(caught instanceof Error ? `Cloudflare unreachable: ${caught.message}` : "Cloudflare unreachable");
    }
    const payload = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    if (!payload || typeof payload !== "object" || !payload.success) {
        const detail = payload?.errors?.map((error) => error.message).filter(Boolean).join("; ");
        throw new Error(detail || `Cloudflare API error (HTTP ${res.status})`);
    }
    return payload.result;
}

/** Verify an API token is valid and active. */
export async function verifyToken(token: string): Promise<void> {
    const result = await cf<{ status?: string }>(token, "GET", "/user/tokens/verify");
    if (result?.status && result.status !== "active") {
        throw new Error(`The token is ${result.status}, not active`);
    }
}

export interface CfAccount {
    id: string;
    name: string;
}

/** The accounts this token can act on (usually one). */
export async function listAccounts(token: string): Promise<CfAccount[]> {
    const result = await cf<Array<{ id?: unknown; name?: unknown }>>(token, "GET", "/accounts?per_page=50");
    if (!Array.isArray(result)) throw new Error("Unexpected accounts response from Cloudflare");
    return result
        .filter((entry): entry is { id: string; name: string } => typeof entry?.id === "string")
        .map((entry) => ({ id: entry.id, name: typeof entry.name === "string" ? entry.name : entry.id }));
}

export interface CfZone {
    id: string;
    name: string;
}

/** The zones (domains) this token can manage DNS for. */
export async function listZones(token: string): Promise<CfZone[]> {
    const result = await cf<Array<{ id?: unknown; name?: unknown }>>(token, "GET", "/zones?per_page=50");
    if (!Array.isArray(result)) throw new Error("Unexpected zones response from Cloudflare");
    return result
        .filter((entry): entry is { id: string; name: string } => typeof entry?.id === "string" && typeof entry?.name === "string")
        .map((entry) => ({ id: entry.id, name: entry.name }));
}

/** Find the zone whose name is the longest suffix of a hostname (app.example.com -> example.com). */
export async function resolveZoneForHostname(token: string, hostname: string): Promise<CfZone> {
    const zones = await listZones(token);
    const match = zones
        .filter((zone) => hostname === zone.name || hostname.endsWith(`.${zone.name}`))
        .sort((a, b) => b.name.length - a.name.length)[0];
    if (!match) {
        throw new Error(`${hostname} is not on a domain in this Cloudflare account. Add the domain to Cloudflare first.`);
    }
    return match;
}

export interface CfTunnel {
    id: string;
    name: string;
}

/** Create a remotely-managed tunnel (its ingress config lives on Cloudflare's edge). */
export async function createTunnel(token: string, accountId: string, name: string): Promise<CfTunnel> {
    const result = await cf<{ id?: unknown; name?: unknown }>(token, "POST", `/accounts/${accountId}/cfd_tunnel`, {
        name,
        config_src: "cloudflare"
    });
    if (typeof result?.id !== "string") throw new Error("Cloudflare did not return a tunnel id");
    return { id: result.id, name: typeof result.name === "string" ? result.name : name };
}

/** Fetch a tunnel's connector token (the value cloudflared runs with). */
export async function getTunnelToken(token: string, accountId: string, tunnelId: string): Promise<string> {
    const result = await cf<unknown>(token, "GET", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
    if (typeof result !== "string" || !result) throw new Error("Cloudflare did not return a connector token");
    return result;
}

/** Replace a tunnel's ingress so `hostname` routes to `originUrl`, everything else 404s. */
export async function putTunnelIngress(
    token: string,
    accountId: string,
    tunnelId: string,
    hostname: string,
    originUrl: string
): Promise<void> {
    await cf(token, "PUT", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
        config: {
            ingress: [
                { hostname, service: originUrl },
                { service: "http_status:404" }
            ]
        }
    });
}

/**
 * Point the tunnel's ingress at a placeholder instead of the app, so a disabled
 * hostname keeps the tunnel connected (Cloudflare needs an ingress) and the name
 * reserved without exposing the service. Proxies to the Polaris repo for now.
 */
export async function putTunnelPlaceholder(
    token: string,
    accountId: string,
    tunnelId: string,
    hostname: string
): Promise<void> {
    await cf(token, "PUT", `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
        config: {
            ingress: [
                {
                    hostname,
                    service: "https://github.com/FJRG2007/polaris",
                    originRequest: { httpHostHeader: "github.com" }
                },
                { service: "http_status:404" }
            ]
        }
    });
}

/** Point `hostname` at the tunnel via a proxied CNAME, creating or updating the record. */
export async function upsertTunnelCname(
    token: string,
    zoneId: string,
    hostname: string,
    tunnelId: string
): Promise<string> {
    const content = `${tunnelId}.cfargotunnel.com`;
    const existing = await cf<Array<{ id?: unknown }>>(
        token,
        "GET",
        `/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`
    );
    const record = { type: "CNAME", name: hostname, content, proxied: true, ttl: 1 };
    const current = Array.isArray(existing) ? existing.find((entry) => typeof entry?.id === "string") : undefined;
    if (current && typeof current.id === "string") {
        await cf(token, "PUT", `/zones/${zoneId}/dns_records/${current.id}`, record);
        return current.id;
    }
    const created = await cf<{ id?: unknown }>(token, "POST", `/zones/${zoneId}/dns_records`, record);
    if (typeof created?.id !== "string") throw new Error("Cloudflare did not return a DNS record id");
    return created.id;
}

/** Best-effort deletion of a DNS record (teardown never blocks on it). */
export async function deleteDnsRecord(token: string, zoneId: string, recordId: string): Promise<void> {
    await cf(token, "DELETE", `/zones/${zoneId}/dns_records/${recordId}`);
}

/** Best-effort deletion of a tunnel (only succeeds once its connector has stopped). */
export async function deleteTunnel(token: string, accountId: string, tunnelId: string): Promise<void> {
    await cf(token, "DELETE", `/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
}
