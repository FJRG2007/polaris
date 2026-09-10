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

/** What Cloudflare said when it refused a request, or that it could not be
 *  reached - sentences about the request, safe to show whoever made it. */
export class CloudflareApiError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CloudflareApiError";
    }
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
        throw new CloudflareApiError(
            caught instanceof Error ? `Cloudflare unreachable: ${caught.message}` : "Cloudflare unreachable"
        );
    }
    const payload = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
    if (!payload || typeof payload !== "object" || !payload.success) {
        const detail = payload?.errors?.map((error) => error.message).filter(Boolean).join("; ");
        throw new CloudflareApiError(detail || `Cloudflare API error (HTTP ${res.status})`);
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
        throw new CloudflareApiError(
            `${hostname} is not on a domain in this Cloudflare account. Add the domain to Cloudflare first.`
        );
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

export interface CfDnsRecord {
    id: string;
    /** What the record points at today (an IP for an A record). */
    content: string;
}

/**
 * Every record of one type/name that already exists. Callers that are about to write a
 * name the operator may already be using check this first: an upsert replaces what is
 * there, and the name can be their domain's apex. All of them are returned, not the
 * first - a name legitimately holds several A records (an apex on a CDN usually has
 * two to four), and judging the name by one of them would both miss records pointing
 * elsewhere and leave them behind after a write.
 */
export async function findDnsRecords(
    token: string,
    zoneId: string,
    type: string,
    name: string
): Promise<CfDnsRecord[]> {
    const existing = await cf<Array<{ id?: unknown; content?: unknown }>>(
        token,
        "GET",
        `/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`
    );
    if (!Array.isArray(existing)) return [];
    return existing
        .filter((entry): entry is { id: string; content?: unknown } => typeof entry?.id === "string")
        .map((entry) => ({ id: entry.id, content: typeof entry.content === "string" ? entry.content : "" }));
}

/** Delete every record of a type/name except one, so a name that round-robined between
 *  several addresses ends up pointing only where the caller asked. */
export async function pruneDnsRecords(token: string, zoneId: string, keepId: string, records: CfDnsRecord[]): Promise<void> {
    for (const record of records) {
        if (record.id !== keepId) await deleteDnsRecord(token, zoneId, record.id);
    }
}

/** Create or replace a DNS record of one type/name, returning its record id. */
async function upsertRecord(
    token: string,
    zoneId: string,
    record: { type: string; name: string; content: string; proxied: boolean; ttl: number }
): Promise<string> {
    // The first is the one rewritten; a name holding several is the caller's business
    // (see pruneDnsRecords), since only it knows whether the others should survive.
    const [current] = await findDnsRecords(token, zoneId, record.type, record.name);
    if (current) {
        await cf(token, "PUT", `/zones/${zoneId}/dns_records/${current.id}`, record);
        return current.id;
    }
    const created = await cf<{ id?: unknown }>(token, "POST", `/zones/${zoneId}/dns_records`, record);
    if (typeof created?.id !== "string") throw new Error("Cloudflare did not return a DNS record id");
    return created.id;
}

/** Point `hostname` at the tunnel via a proxied CNAME, creating or updating the record. */
export async function upsertTunnelCname(
    token: string,
    zoneId: string,
    hostname: string,
    tunnelId: string
): Promise<string> {
    return upsertRecord(token, zoneId, {
        type: "CNAME",
        name: hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
        ttl: 1
    });
}

/**
 * Point `hostname` (a zone host or its `*.` wildcard) straight at an IP. Left
 * unproxied: the record must resolve to the server's own address so Let's Encrypt
 * can validate it over HTTP and so the edge, not Cloudflare, terminates TLS.
 */
export async function upsertARecord(token: string, zoneId: string, hostname: string, ip: string): Promise<string> {
    return upsertRecord(token, zoneId, { type: "A", name: hostname, content: ip, proxied: false, ttl: 300 });
}

/**
 * Point a service record at a host and port, so a client that looks one up
 * connects without being told the port.
 *
 * The components go in `data` rather than in a packed `content` string: the API
 * documents each of them there, and a record written field by field is one the
 * next writer can read back the same way. Never proxied - Cloudflare's proxy
 * handles HTTP, and what looks a SRV record up is a game client.
 */
export async function upsertSrvRecord(
    token: string,
    zoneId: string,
    name: string,
    target: string,
    port: number
): Promise<string> {
    const record = {
        type: "SRV",
        name,
        ttl: 300,
        data: { priority: 0, weight: 5, port, target }
    };
    const [current] = await findDnsRecords(token, zoneId, "SRV", name);
    if (current) {
        await cf(token, "PUT", `/zones/${zoneId}/dns_records/${current.id}`, record);
        return current.id;
    }
    const created = await cf<{ id?: unknown }>(token, "POST", `/zones/${zoneId}/dns_records`, record);
    if (typeof created?.id !== "string") throw new Error("Cloudflare did not return a DNS record id");
    return created.id;
}

/**
 * Add one TXT record beside whatever is already at that name, returning its id so
 * the caller can take exactly that one away again.
 *
 * Never an update: a certificate for `example.com` and `*.example.com` is proven
 * by two different answers published at the same `_acme-challenge` name at the
 * same time, and rewriting the record in place leaves only the second - so the
 * first validation reads the wrong value and the whole order fails. A short TTL
 * because the record exists for the length of one validation.
 */
export async function createTxtRecord(token: string, zoneId: string, name: string, content: string): Promise<string> {
    const created = await cf<{ id?: unknown }>(token, "POST", `/zones/${zoneId}/dns_records`, {
        type: "TXT",
        name,
        content,
        ttl: 60
    });
    if (typeof created?.id !== "string") throw new Error("Cloudflare did not return a DNS record id");
    return created.id;
}

/** One record as a mail server's DNS needs to read it: an MX has a priority,
 *  an SRV has its fields in `data`. */
export interface CfZoneRecord {
    readonly id: string;
    readonly type: string;
    readonly name: string;
    readonly content: string;
    readonly priority: number | null;
}

/**
 * A TXT record's value as one string. Cloudflare may hand the content back as
 * the quoted character-strings it is stored as (`"v=spf1 " "mx -all"`); read
 * that way, an SPF record would not be recognised as one, and a second would be
 * published beside it - which invalidates both.
 */
export function unquoteTxt(content: string): string {
    const trimmed = content.trim();
    if (!trimmed.startsWith('"')) return trimmed;
    const parts = [...trimmed.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => (match[1] ?? "").replace(/\\(.)/g, "$1"));
    return parts.length > 0 ? parts.join("") : trimmed;
}

/** Every record of one type at one name, with the fields a comparison needs. */
export async function listZoneRecords(
    token: string,
    zoneId: string,
    type: string,
    name: string
): Promise<CfZoneRecord[]> {
    const rows = await cf<Array<Record<string, unknown>>>(
        token,
        "GET",
        `/zones/${zoneId}/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`
    );
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((row) => {
        if (typeof row.id !== "string") return [];
        const data = (row.data ?? {}) as Record<string, unknown>;
        const raw = typeof row.content === "string" ? row.content : "";
        const content =
            type === "SRV"
                ? `${String(data.priority ?? 0)} ${String(data.weight ?? 0)} ${String(data.port ?? 0)} ${String(data.target ?? "")}`
                : type === "TXT"
                  ? unquoteTxt(raw)
                  : raw;
        return [
            {
                id: row.id,
                type,
                name: typeof row.name === "string" ? row.name : name,
                content,
                priority: typeof row.priority === "number" ? row.priority : null
            }
        ];
    });
}

/** The body Cloudflare takes for a mail record: MX carries a priority, SRV its
 *  fields in `data`, everything else a content string. Never proxied - a mail
 *  record is read by resolvers and mail servers, not browsers. */
function zoneRecordBody(record: { type: string; name: string; value: string; priority: number | null }): Record<string, unknown> {
    if (record.type === "SRV") {
        const [priority, weight, port, target] = record.value.split(" ");
        return {
            type: "SRV",
            name: record.name,
            ttl: 3600,
            data: { priority: Number(priority), weight: Number(weight), port: Number(port), target }
        };
    }
    return {
        type: record.type,
        name: record.name,
        content: record.value,
        ttl: 3600,
        proxied: false,
        ...(record.type === "MX" ? { priority: record.priority ?? 10 } : {})
    };
}

export async function createZoneRecord(
    token: string,
    zoneId: string,
    record: { type: string; name: string; value: string; priority: number | null }
): Promise<string> {
    const created = await cf<{ id?: unknown }>(token, "POST", `/zones/${zoneId}/dns_records`, zoneRecordBody(record));
    if (typeof created?.id !== "string") throw new Error("Cloudflare did not return a DNS record id");
    return created.id;
}

/** One record as the zone holds it, for the record editor. */
export interface CfDnsRecord {
    id: string;
    type: string;
    name: string;
    /** The value as Cloudflare writes it out - for SRV and CAA, their fields in one line. */
    content: string;
    ttl: number;
    proxied: boolean;
    proxiable: boolean;
    priority: number | null;
    /** The separate fields of an SRV or CAA record. */
    data: Record<string, unknown> | null;
}

/** How many records are read per request, and the most pages read for one zone. */
const RECORDS_PER_PAGE = 100;
const MAX_RECORD_PAGES = 50;

/** Every record in a zone, page by page, in the order Cloudflare keeps them. */
export async function listDnsRecords(token: string, zoneId: string): Promise<CfDnsRecord[]> {
    const records: CfDnsRecord[] = [];
    for (let page = 1; page <= MAX_RECORD_PAGES; page += 1) {
        const batch = await cf<unknown[]>(
            token,
            "GET",
            `/zones/${zoneId}/dns_records?per_page=${RECORDS_PER_PAGE}&page=${page}`
        );
        if (!Array.isArray(batch)) throw new Error("Unexpected DNS records response from Cloudflare");
        for (const entry of batch) {
            const row = entry as Record<string, unknown>;
            if (typeof row.id !== "string" || typeof row.type !== "string" || typeof row.name !== "string") continue;
            records.push({
                id: row.id,
                type: row.type,
                name: row.name,
                content: typeof row.content === "string" ? row.content : "",
                ttl: typeof row.ttl === "number" ? row.ttl : 1,
                proxied: row.proxied === true,
                proxiable: row.proxiable === true,
                priority: typeof row.priority === "number" ? row.priority : null,
                data: row.data && typeof row.data === "object" ? (row.data as Record<string, unknown>) : null
            });
        }
        if (batch.length < RECORDS_PER_PAGE) break;
    }
    return records;
}

/** Add a record, returning its id. `record` is the API's own shape. */
export async function createDnsRecord(token: string, zoneId: string, record: object): Promise<string> {
    const created = await cf<{ id?: unknown }>(token, "POST", `/zones/${zoneId}/dns_records`, record);
    if (typeof created?.id !== "string") throw new Error("Cloudflare did not return a DNS record id");
    return created.id;
}

export async function updateZoneRecord(
    token: string,
    zoneId: string,
    recordId: string,
    record: { type: string; name: string; value: string; priority: number | null }
): Promise<void> {
    await cf(token, "PUT", `/zones/${zoneId}/dns_records/${recordId}`, zoneRecordBody(record));
}

/** Replace a record's every field with these. */
export async function updateDnsRecord(token: string, zoneId: string, recordId: string, record: object): Promise<void> {
    await cf(token, "PUT", `/zones/${zoneId}/dns_records/${recordId}`, record);
}

/** One record, or null when the zone has no record by that id. */
export async function getDnsRecord(
    token: string,
    zoneId: string,
    recordId: string
): Promise<{ id: string; type: string; name: string } | null> {
    try {
        const row = await cf<{ id?: unknown; type?: unknown; name?: unknown }>(
            token,
            "GET",
            `/zones/${zoneId}/dns_records/${recordId}`
        );
        return typeof row?.id === "string" && typeof row.type === "string" && typeof row.name === "string"
            ? { id: row.id, type: row.type, name: row.name }
            : null;
    } catch {
        return null;
    }
}

/** Best-effort deletion of a DNS record (teardown never blocks on it). */
export async function deleteDnsRecord(token: string, zoneId: string, recordId: string): Promise<void> {
    await cf(token, "DELETE", `/zones/${zoneId}/dns_records/${recordId}`);
}

/** Best-effort deletion of a tunnel (only succeeds once its connector has stopped). */
export async function deleteTunnel(token: string, accountId: string, tunnelId: string): Promise<void> {
    await cf(token, "DELETE", `/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
}
