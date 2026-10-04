/**
 * Where everything in Polaris's MCP authorization lives, and the rules for the
 * addresses an app hands it.
 *
 * Pure, so the routes, the consent page and the tests share one answer. Nothing
 * here reads a request: the origin is passed in by whoever resolved it.
 *
 * Built to the MCP authorization spec (modelcontextprotocol.io, revision
 * 2025-11-25 and 2026-07-28): Protected Resource Metadata (RFC 9728) points at
 * this instance as its own authorization server, whose metadata (RFC 8414)
 * names the endpoints below.
 */

/** The MCP endpoint, which is the one resource these tokens are for. */
export const MCP_PATH = "/api/mcp";
export const AUTHORIZE_PATH = "/oauth/authorize";
export const TOKEN_PATH = "/api/oauth/token";
export const REGISTER_PATH = "/api/oauth/register";
export const REVOKE_PATH = "/api/oauth/revoke";
export const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

/** The longest address accepted anywhere in the flow. */
export const MAX_URI_LENGTH = 2048;

/** The resource identifier for this instance's MCP endpoint (RFC 8707): the
 *  URL a client connects to, lowercase scheme and host, no trailing slash. */
export function mcpResource(origin: string): string {
    return `${new URL(origin).origin}${MCP_PATH}`;
}

/** Where a client finds the resource metadata for the MCP endpoint - the
 *  path-suffixed form, which is the first one the spec has clients try. */
export function resourceMetadataUrl(origin: string): string {
    return `${new URL(origin).origin}${RESOURCE_METADATA_PATH}${MCP_PATH}`;
}

/**
 * A resource indicator in its canonical form, or null when it is not one.
 *
 * RFC 8707 makes it an absolute URI with no fragment; the MCP spec has clients
 * send it without a trailing slash and with the scheme and host lowercase, and
 * some send it with the slash anyway. Both spellings name the same endpoint, so
 * both are folded to one before they are compared.
 */
export function canonicalResource(value: string): string | null {
    if (value.length > MAX_URI_LENGTH || value.includes("#")) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "";
    return `${url.origin}${path}${url.search}`;
}

/** Whether a presented resource names the expected one. */
export function sameResource(presented: string, expected: string): boolean {
    const a = canonicalResource(presented);
    return a !== null && a === canonicalResource(expected);
}

/** Hostnames that can only ever be this computer. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopback(url: URL): boolean {
    return LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * A redirect address an app may register, or null.
 *
 * https anywhere, or http to this computer and nowhere else (RFC 8252 section
 * 7.3, which is how a desktop app or a terminal receives the code). No fragment,
 * because the code is appended as a query and a fragment would swallow it; no
 * credentials, because there is no reason for one and a URL with a password in
 * it is somebody's password. Private-use schemes (`cursor://`) are refused: none
 * of the clients this is built for needs one, and they are the ones another app
 * on the machine can claim.
 */
export function acceptableRedirectUri(value: string): URL | null {
    if (value.length === 0 || value.length > MAX_URI_LENGTH || value.includes("#")) return null;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url;
    if (url.protocol === "http:" && isLoopback(url)) return url;
    return null;
}

/**
 * Whether a presented redirect address is one the app registered.
 *
 * Exact string match, with the one exception RFC 8252 requires: a loopback
 * address matches whatever port it arrives with, because a native app is given
 * a free port by the operating system at the moment it listens. The host, the
 * path and the query still have to be the registered ones.
 */
export function redirectMatches(registered: readonly string[], presented: string): boolean {
    const url = acceptableRedirectUri(presented);
    if (!url) return false;
    for (const candidate of registered) {
        if (candidate === presented) return true;
        const known = acceptableRedirectUri(candidate);
        if (!known || known.protocol !== "http:" || url.protocol !== "http:") continue;
        if (!isLoopback(known) || known.hostname !== url.hostname) continue;
        if (known.pathname === url.pathname && known.search === url.search) return true;
    }
    return false;
}

/** Append the answer to an authorization to the app's redirect address, keeping
 *  any query it registered with. */
export function withParams(redirectUri: string, params: Record<string, string | undefined>): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.toString();
}

/** Protected Resource Metadata (RFC 9728) for the MCP endpoint. */
export function protectedResourceMetadata(origin: string, scopes: readonly string[]) {
    const issuer = new URL(origin).origin;
    return {
        resource: mcpResource(issuer),
        authorization_servers: [issuer],
        scopes_supported: [...scopes],
        bearer_methods_supported: ["header"],
        resource_name: "Polaris"
    };
}

/** The token endpoint's ways of telling who an app is. `none` first: every
 *  assistant and editor is a public client, and Claude only uses a metadata
 *  document when the server lists it. */
export const TOKEN_AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
export type TokenAuthMethod = (typeof TOKEN_AUTH_METHODS)[number];

/** Authorization Server Metadata (RFC 8414). */
export function authorizationServerMetadata(origin: string, scopes: readonly string[]) {
    const issuer = new URL(origin).origin;
    return {
        issuer,
        authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
        token_endpoint: `${issuer}${TOKEN_PATH}`,
        registration_endpoint: `${issuer}${REGISTER_PATH}`,
        revocation_endpoint: `${issuer}${REVOKE_PATH}`,
        scopes_supported: [...scopes],
        response_types_supported: ["code"],
        response_modes_supported: ["query"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: [...TOKEN_AUTH_METHODS],
        revocation_endpoint_auth_methods_supported: [...TOKEN_AUTH_METHODS],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true
    };
}

/**
 * The challenge on a 401 from the MCP endpoint (RFC 6750 section 3, RFC 9728
 * section 5.1): where to find the resource metadata, and the scopes a client
 * should ask for when it has nothing better to go on.
 */
export function wwwAuthenticate(origin: string, scopes: readonly string[], invalidToken = false): string {
    const parts = [`resource_metadata="${resourceMetadataUrl(origin)}"`];
    if (scopes.length > 0) parts.push(`scope="${scopes.join(" ")}"`);
    if (invalidToken) parts.push(`error="invalid_token"`);
    return `Bearer ${parts.join(", ")}`;
}
