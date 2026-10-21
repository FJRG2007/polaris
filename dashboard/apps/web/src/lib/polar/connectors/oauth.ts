/**
 * Signing a connector in: OAuth 2.1 the way the MCP authorization spec
 * (revision 2025-11-25) asks a client to.
 *
 * 1. Ask the server something without a token; a 401 names its Protected
 *    Resource Metadata in `WWW-Authenticate` (RFC 9728), and when it does not,
 *    the well-known addresses are tried in the spec's order - the endpoint's
 *    own path first, then the root.
 * 2. Read the authorization server's metadata, trying RFC 8414 and OpenID
 *    discovery in the spec's order, and refuse one that does not list PKCE
 *    `S256` (`code_challenge_methods_supported`), as the spec says to.
 * 3. A client: one registered by hand when the person gave one, else Dynamic
 *    Client Registration (RFC 7591). Client ID Metadata Documents need a
 *    public HTTPS address of this deployment that every install does not have,
 *    so they are not offered.
 * 4. PKCE S256, a `state` tied to the connector, the `resource` parameter
 *    (RFC 8707) on both the authorization and the token request, and the
 *    scope the challenge named - else the server's `scopes_supported`.
 *
 * Every request goes through the fetch it is handed (`fetch.ts`, the
 * guarded one), every answer is size-capped and read against a schema, and
 * every authorization server endpoint must be https.
 *
 * Server-only. No SDK import, so the flow can be asserted against a fake
 * server.
 */

import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";

export type ConnectorFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Any metadata or token answer past this is not one. */
const JSON_MAX = 256 * 1024;

export class ConnectorAuthError extends Error {
    constructor(
        readonly code:
            | "no_metadata"
            | "no_pkce"
            | "no_registration"
            | "insecure"
            | "token_refused"
            | "invalid_answer",
        detail?: string
    ) {
        super(detail ?? code);
        this.name = "ConnectorAuthError";
    }
}

const resourceMetadataSchema = z.object({
    resource: z.string().url().optional(),
    authorization_servers: z.array(z.string().url()).min(1),
    scopes_supported: z.array(z.string()).optional()
});

const serverMetadataSchema = z.object({
    issuer: z.string().optional(),
    authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    registration_endpoint: z.string().url().optional(),
    code_challenge_methods_supported: z.array(z.string()).optional(),
    token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
    scopes_supported: z.array(z.string()).optional()
});
export type ServerMetadata = z.infer<typeof serverMetadataSchema>;

const registrationSchema = z.object({
    client_id: z.string().min(1).max(512),
    client_secret: z.string().max(4096).optional()
});

const tokenSchema = z.object({
    access_token: z.string().min(1).max(16_384),
    token_type: z.string().optional(),
    expires_in: z.coerce.number().positive().optional(),
    refresh_token: z.string().max(16_384).optional(),
    scope: z.string().optional()
});

/** What a token answer leaves stored. */
export interface ConnectorTokens {
    accessToken: string;
    refreshToken: string | null;
    /** Epoch milliseconds; null when the server did not say. */
    expiresAt: number | null;
}

/** Everything the token endpoint needs later, kept with the tokens. */
export interface ConnectorClient {
    clientId: string;
    clientSecret: string | null;
    tokenEndpoint: string;
    authMethod: "none" | "client_secret_basic" | "client_secret_post";
    resource: string;
}

/** An authorization in flight: what the callback checks and spends. */
export interface PendingAuthorization extends ConnectorClient {
    stateHash: string;
    verifier: string;
    redirectUri: string;
    expiresAt: number;
}

/** How long a person has to finish signing in. */
export const PENDING_TTL_MS = 10 * 60_000;

/** The parameters of a `WWW-Authenticate: Bearer ...` challenge. */
export function parseChallenge(header: string | null): {
    resourceMetadata: string | null;
    scope: string | null;
    error: string | null;
} {
    const found: Record<string, string> = {};
    if (header) {
        const pattern = /([a-zA-Z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
        for (const match of header.matchAll(pattern)) {
            const key = match[1]!.toLowerCase();
            if (!(key in found)) found[key] = (match[2] ?? match[3] ?? "").replace(/\\(.)/g, "$1");
        }
    }
    return {
        resourceMetadata: found.resource_metadata ?? null,
        scope: found.scope ?? null,
        error: found.error ?? null
    };
}

async function readJson(response: Response): Promise<unknown> {
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > JSON_MAX) throw new ConnectorAuthError("invalid_answer");
    const text = await response.text();
    if (text.length > JSON_MAX) throw new ConnectorAuthError("invalid_answer");
    try {
        return JSON.parse(text);
    } catch {
        throw new ConnectorAuthError("invalid_answer");
    }
}

/** A JSON GET that answers null for anything but a 200 with a body that reads. */
async function getJson<T>(
    fetch: ConnectorFetch,
    url: string,
    schema: z.ZodType<T>
): Promise<T | null> {
    let response: Response;
    try {
        response = await fetch(url, { headers: { accept: "application/json" } });
    } catch {
        return null;
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return null;
    }
    try {
        const parsed = schema.safeParse(await readJson(response));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** The well-known resource metadata addresses for a server, in the spec's order. */
export function resourceMetadataUrls(server: string): string[] {
    const url = new URL(server);
    const path = url.pathname.replace(/\/+$/, "");
    const urls = path ? [`${url.origin}/.well-known/oauth-protected-resource${path}`] : [];
    urls.push(`${url.origin}/.well-known/oauth-protected-resource`);
    return urls;
}

/** The authorization server metadata addresses for an issuer, in the spec's order. */
export function serverMetadataUrls(issuer: string): string[] {
    const url = new URL(issuer);
    const path = url.pathname.replace(/\/+$/, "");
    if (!path) {
        return [
            `${url.origin}/.well-known/oauth-authorization-server`,
            `${url.origin}/.well-known/openid-configuration`
        ];
    }
    return [
        `${url.origin}/.well-known/oauth-authorization-server${path}`,
        `${url.origin}/.well-known/openid-configuration${path}`,
        `${url.origin}${path}/.well-known/openid-configuration`
    ];
}

/** An MCP `initialize` with no token, to be told how to sign in. */
async function probe(
    fetch: ConnectorFetch,
    server: string
): Promise<{ metadata: string | null; scope: string | null }> {
    try {
        const response = await fetch(server, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json"
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                    protocolVersion: "2025-11-25",
                    capabilities: {},
                    clientInfo: { name: "Polaris", version: "1.0.0" }
                }
            })
        });
        await response.body?.cancel().catch(() => undefined);
        const challenge = parseChallenge(response.headers.get("www-authenticate"));
        return { metadata: challenge.resourceMetadata, scope: challenge.scope };
    } catch {
        return { metadata: null, scope: null };
    }
}

function isHttps(url: string): boolean {
    try {
        return new URL(url).protocol === "https:";
    } catch {
        return false;
    }
}

/**
 * Whether resource metadata describes this server: same origin, and the
 * server's path at or under the resource's (RFC 9728 section 3.3).
 */
export function resourceCovers(resource: string | undefined, server: string): boolean {
    if (!resource) return true;
    try {
        const named = new URL(resource);
        const asked = new URL(server);
        if (named.origin !== asked.origin) return false;
        const base = named.pathname.replace(/\/+$/, "");
        const path = asked.pathname.replace(/\/+$/, "");
        return path === base || path.startsWith(`${base}/`);
    } catch {
        return false;
    }
}

export interface Discovered {
    metadata: ServerMetadata;
    resource: string;
    scope: string | null;
}

/** Steps 1 and 2: where to sign in, checked. */
export async function discover(fetch: ConnectorFetch, server: string): Promise<Discovered> {
    const challenge = await probe(fetch, server);
    const candidates = challenge.metadata ? [challenge.metadata] : resourceMetadataUrls(server);
    let resource: z.infer<typeof resourceMetadataSchema> | null = null;
    for (const candidate of candidates) {
        resource = await getJson(fetch, candidate, resourceMetadataSchema);
        if (resource) break;
    }
    if (!resource || !resourceCovers(resource.resource, server)) {
        throw new ConnectorAuthError("no_metadata");
    }
    const issuer = resource.authorization_servers[0]!;
    if (!isHttps(issuer)) throw new ConnectorAuthError("insecure");
    let metadata: ServerMetadata | null = null;
    for (const candidate of serverMetadataUrls(issuer)) {
        metadata = await getJson(fetch, candidate, serverMetadataSchema);
        if (metadata) break;
    }
    if (!metadata) throw new ConnectorAuthError("no_metadata");
    if (!metadata.code_challenge_methods_supported?.includes("S256")) {
        throw new ConnectorAuthError("no_pkce");
    }
    const endpoints = [metadata.authorization_endpoint, metadata.token_endpoint];
    if (metadata.registration_endpoint) endpoints.push(metadata.registration_endpoint);
    if (!endpoints.every(isHttps)) throw new ConnectorAuthError("insecure");
    const scope = challenge.scope ?? (resource.scopes_supported?.join(" ") || null);
    return { metadata, resource: resource.resource ?? server, scope };
}

function authMethodFor(
    metadata: ServerMetadata,
    secret: string | null
): ConnectorClient["authMethod"] {
    if (!secret) return "none";
    const methods = metadata.token_endpoint_auth_methods_supported;
    return methods &&
        !methods.includes("client_secret_basic") &&
        methods.includes("client_secret_post")
        ? "client_secret_post"
        : "client_secret_basic";
}

/** Step 3: a client of the authorization server. */
export async function obtainClient(
    fetch: ConnectorFetch,
    discovered: Discovered,
    redirectUri: string,
    registered: { clientId: string; clientSecret: string | null } | null
): Promise<ConnectorClient> {
    const { metadata } = discovered;
    if (registered) {
        return {
            clientId: registered.clientId,
            clientSecret: registered.clientSecret,
            tokenEndpoint: metadata.token_endpoint,
            authMethod: authMethodFor(metadata, registered.clientSecret),
            resource: discovered.resource
        };
    }
    if (!metadata.registration_endpoint) throw new ConnectorAuthError("no_registration");
    const response = await fetch(metadata.registration_endpoint, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
            client_name: "Polaris",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none"
        })
    });
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ConnectorAuthError("no_registration");
    }
    const parsed = registrationSchema.safeParse(await readJson(response));
    if (!parsed.success) throw new ConnectorAuthError("invalid_answer");
    const secret = parsed.data.client_secret ?? null;
    return {
        clientId: parsed.data.client_id,
        clientSecret: secret,
        tokenEndpoint: metadata.token_endpoint,
        authMethod: authMethodFor(metadata, secret),
        resource: discovered.resource
    };
}

function base64url(bytes: Buffer): string {
    return bytes.toString("base64url");
}

export function hashState(state: string): string {
    return createHash("sha256").update(state).digest("hex");
}

/** PKCE S256 (RFC 7636): a 43-character verifier and its challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
    const verifier = base64url(randomBytes(32));
    return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

/**
 * Steps 1 to 4 up to the browser: where to send the person, and what the
 * callback needs, to be stored encrypted. `state` starts with the connector's
 * id so the callback can find it; only its hash is kept.
 */
export async function beginAuthorization(
    fetch: ConnectorFetch,
    input: {
        connectorId: string;
        server: string;
        redirectUri: string;
        registered: { clientId: string; clientSecret: string | null } | null;
        now?: number;
    }
): Promise<{ authorizationUrl: string; pending: PendingAuthorization }> {
    const discovered = await discover(fetch, input.server);
    const client = await obtainClient(fetch, discovered, input.redirectUri, input.registered);
    const { verifier, challenge } = pkcePair();
    const state = `${input.connectorId}.${base64url(randomBytes(24))}`;
    const url = new URL(discovered.metadata.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("resource", client.resource);
    if (discovered.scope) url.searchParams.set("scope", discovered.scope);
    return {
        authorizationUrl: url.href,
        pending: {
            ...client,
            stateHash: hashState(state),
            verifier,
            redirectUri: input.redirectUri,
            expiresAt: (input.now ?? Date.now()) + PENDING_TTL_MS
        }
    };
}

/** The connector id a callback's `state` names, or null for one that names none. */
export function stateConnectorId(state: string): string | null {
    const id = state.split(".")[0] ?? "";
    return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

async function tokenRequest(
    fetch: ConnectorFetch,
    client: ConnectorClient,
    params: Record<string, string>,
    now: number
): Promise<ConnectorTokens> {
    const body = new URLSearchParams({ ...params, resource: client.resource });
    const headers: Record<string, string> = {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
    };
    if (client.authMethod === "client_secret_basic" && client.clientSecret) {
        const pair = `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`;
        headers.authorization = `Basic ${Buffer.from(pair).toString("base64")}`;
    } else {
        body.set("client_id", client.clientId);
        if (client.authMethod === "client_secret_post" && client.clientSecret) {
            body.set("client_secret", client.clientSecret);
        }
    }
    const response = await fetch(client.tokenEndpoint, {
        method: "POST",
        headers,
        body: body.toString()
    });
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ConnectorAuthError("token_refused", `token endpoint answered ${response.status}`);
    }
    const parsed = tokenSchema.safeParse(await readJson(response));
    if (!parsed.success) throw new ConnectorAuthError("invalid_answer");
    if (parsed.data.token_type && parsed.data.token_type.toLowerCase() !== "bearer") {
        throw new ConnectorAuthError("invalid_answer");
    }
    return {
        accessToken: parsed.data.access_token,
        refreshToken: parsed.data.refresh_token ?? null,
        expiresAt: parsed.data.expires_in ? now + parsed.data.expires_in * 1000 : null
    };
}

/** The callback: the state must match and be fresh, then the code is spent. */
export async function finishAuthorization(
    fetch: ConnectorFetch,
    pending: PendingAuthorization,
    input: { state: string; code: string; now?: number }
): Promise<ConnectorTokens> {
    const now = input.now ?? Date.now();
    if (pending.expiresAt < now || hashState(input.state) !== pending.stateHash) {
        throw new ConnectorAuthError("token_refused", "state");
    }
    return tokenRequest(
        fetch,
        pending,
        {
            grant_type: "authorization_code",
            code: input.code,
            redirect_uri: pending.redirectUri,
            code_verifier: pending.verifier
        },
        now
    );
}

/** A refresh; a server that rotates the refresh token hands back a new one. */
export async function refreshTokens(
    fetch: ConnectorFetch,
    client: ConnectorClient,
    refreshToken: string,
    now = Date.now()
): Promise<ConnectorTokens> {
    const tokens = await tokenRequest(
        fetch,
        client,
        { grant_type: "refresh_token", refresh_token: refreshToken },
        now
    );
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

/** Whether an access token is too close to its end to send. */
export function tokenExpiring(
    tokens: Pick<ConnectorTokens, "expiresAt">,
    now = Date.now()
): boolean {
    return tokens.expiresAt !== null && tokens.expiresAt - 60_000 <= now;
}
