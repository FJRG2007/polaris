/**
 * What the OAuth endpoints share on the wire: their answers, their errors, the
 * cross-origin headers, and reading a body without trusting its size.
 *
 * Every endpoint here is called by an app, not by a page of Polaris, and holds
 * no cookie - so any origin may call it (an assistant that runs in a browser
 * tab has to), and doing so grants nothing a direct request would not.
 */

import { readCappedBody } from "@/lib/request-body";

export const CORS_HEADERS: Readonly<Record<string, string>> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
    "Access-Control-Max-Age": "86400"
};

/** Never cached: a token response held by a proxy is a token handed to whoever
 *  asks that proxy next (RFC 6749 section 5.1). */
const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

export function oauthJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return Response.json(body, { status, headers: { ...CORS_HEADERS, ...NO_STORE, ...headers } });
}

/** An error in the shape RFC 6749 section 5.2 and RFC 7591 section 3.2.2 use. */
export function oauthError(
    error: string,
    description: string,
    status = 400,
    headers: Record<string, string> = {}
): Response {
    return oauthJson({ error, error_description: description }, status, headers);
}

/** A metadata document: public, the same for everyone, worth caching briefly. */
export function metadataJson(body: unknown): Response {
    return Response.json(body, { headers: { ...CORS_HEADERS, "Cache-Control": "public, max-age=300" } });
}

export function preflight(): Response {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Too many requests, with the wait in the header a client reads. */
export function slowDown(retryAfterMs: number): Response {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return oauthError("slow_down", `Too many requests. Try again in ${seconds}s.`, 429, {
        "Retry-After": String(seconds)
    });
}

/**
 * A form body (what RFC 6749 requires at the token endpoint), or JSON for the
 * clients that send it anyway, as string parameters. Null when it is too large
 * or unreadable. A parameter that appears twice is dropped, as section 3.2
 * requires.
 */
export async function readParameters(request: Request, most: number): Promise<Map<string, string> | null> {
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > most) return null;
    const bytes = await readCappedBody(request, most);
    if (!bytes) return null;
    const text = new TextDecoder().decode(bytes);
    const type = request.headers.get("content-type") ?? "";
    const out = new Map<string, string>();
    if (type.includes("application/json")) {
        let body: unknown;
        try {
            body = JSON.parse(text);
        } catch {
            return null;
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) return null;
        for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
            if (typeof value === "string") out.set(key, value);
        }
        return out;
    }
    const form = new URLSearchParams(text);
    for (const key of new Set(form.keys())) {
        const values = form.getAll(key);
        if (values.length === 1) out.set(key, values[0]!);
    }
    return out;
}

/** The client's id and secret, from HTTP Basic (RFC 6749 section 2.3.1, where
 *  both halves are form-encoded) or from the body. */
export function clientCredentials(
    request: Request,
    params: Map<string, string>
): { clientId: string | null; secret: string | null } {
    const header = request.headers.get("authorization") ?? "";
    const [scheme, value] = header.trim().split(/\s+/, 2);
    if (scheme?.toLowerCase() === "basic" && value) {
        try {
            const decoded = Buffer.from(value, "base64").toString("utf8");
            const split = decoded.indexOf(":");
            if (split > 0) {
                return {
                    clientId: decodeURIComponent(decoded.slice(0, split).replace(/\+/g, " ")),
                    secret: decodeURIComponent(decoded.slice(split + 1).replace(/\+/g, " "))
                };
            }
        } catch {
            return { clientId: null, secret: null };
        }
    }
    return { clientId: params.get("client_id") ?? null, secret: params.get("client_secret") ?? null };
}
