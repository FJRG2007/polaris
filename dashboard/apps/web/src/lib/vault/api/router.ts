/**
 * The vault's Bitwarden-compatible surface, as one table.
 *
 * These paths are not Polaris's to design - they are what official clients ask
 * for, down to the trailing segment - and there are enough of them that a folder
 * tree per path would bury the shape in scaffolding. One route table is greppable
 * ("which handler answers /api/ciphers/:id/share?" is one search), and it is the
 * artifact somebody comparing this against a client's expectations actually
 * wants to read.
 *
 * Two rules the table encodes and no handler may re-decide:
 *
 *  - `auth: "bearer"` means the request is resolved to an account before the
 *    handler runs, and refused with a plain 401 otherwise. A handler never sees
 *    an unauthenticated caller.
 *  - `auth: "none"` is the short list of endpoints that cannot require a token,
 *    each of which does its own rate limiting because it is reachable by anyone.
 */

import type { VaultPrincipal } from "@/lib/vault/auth";
import { authenticateVault, vaultUnauthorized } from "@/lib/vault/auth";

/** What a handler is given. */
export interface VaultContext {
    request: Request;
    /** The `:name` segments matched out of the path. */
    params: Record<string, string>;
    /** Set for every `bearer` route, absent for the open ones. */
    principal: VaultPrincipal | null;
    /** The query string of the request. */
    query: URLSearchParams;
}

export type VaultHandler = (context: VaultContext) => Promise<Response>;

export interface VaultRoute {
    method: "GET" | "POST" | "PUT" | "DELETE";
    /** Segments, with `:name` for a capture. Matched after the `/vault` prefix. */
    path: string;
    auth: "none" | "bearer";
    handle: VaultHandler;
}

/** The account behind a bearer route, which the table guarantees is there. */
export function requirePrincipal(context: VaultContext): VaultPrincipal {
    if (!context.principal) throw new Error("A bearer route ran without a principal");
    return context.principal;
}

/** Read a JSON body, or null when there is not one. */
export async function readJsonBody(request: Request): Promise<unknown> {
    try {
        return await request.json();
    } catch {
        return null;
    }
}

/**
 * Read a body that may be JSON or form-encoded.
 *
 * The token endpoint is form-encoded because OAuth2 says so, while everything
 * else is JSON - and some clients send the token request as JSON anyway. Taking
 * either costs one branch and saves a class of "works in one client" bug.
 */
export async function readAnyBody(request: Request): Promise<Record<string, string>> {
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
        const parsed = await readJsonBody(request);
        if (parsed && typeof parsed === "object") {
            return Object.fromEntries(
                Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
                    key,
                    value === null || value === undefined ? "" : String(value)
                ])
            );
        }
        return {};
    }
    try {
        const form = await request.formData();
        const out: Record<string, string> = {};
        for (const [key, value] of form.entries()) {
            if (typeof value === "string") out[key] = value;
        }
        return out;
    } catch {
        return {};
    }
}

/** Match one route pattern against a request's segments. */
function match(pattern: string, segments: string[]): Record<string, string> | null {
    const parts = pattern.split("/").filter(Boolean);
    if (parts.length !== segments.length) return null;
    const params: Record<string, string> = {};
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index]!;
        const segment = segments[index]!;
        if (part.startsWith(":")) {
            params[part.slice(1)] = decodeURIComponent(segment);
            continue;
        }
        // Case-insensitive: clients differ on "/api/Ciphers" and "/api/ciphers",
        // and a 404 from a capital letter is an unfindable bug.
        if (part.toLowerCase() !== segment.toLowerCase()) return null;
    }
    return params;
}

/**
 * Dispatch a request to the table.
 *
 * A path nobody claims gets a 404 with the error shape clients read, not an
 * empty one: a client that receives an unparseable body on an unknown route
 * reports it as a server fault rather than as a route it should not have called.
 */
export async function dispatchVault(
    routes: readonly VaultRoute[],
    request: Request,
    segments: string[]
): Promise<Response> {
    const url = new URL(request.url);
    let pathExists = false;

    for (const route of routes) {
        const params = match(route.path, segments);
        if (!params) continue;
        pathExists = true;
        if (route.method !== request.method) continue;

        let principal: VaultPrincipal | null = null;
        if (route.auth === "bearer") {
            principal = await authenticateVault(request);
            if (!principal) return vaultUnauthorized();
        }
        return route.handle({ request, params, principal, query: url.searchParams });
    }

    return Response.json(
        { message: pathExists ? "Method not allowed" : "Not found", object: "error" },
        { status: pathExists ? 405 : 404 }
    );
}
