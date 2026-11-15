/**
 * Who is calling the compatible API. A Polaris API key with `polar.use`,
 * presented the way each client sends it: Claude Code puts
 * `ANTHROPIC_API_KEY` in `x-api-key` and `ANTHROPIC_AUTH_TOKEN` in
 * `Authorization: Bearer`; OpenAI clients always send Bearer. The owner must
 * also be allowed Polar right now: a key outlives a change of policy.
 *
 * A session on Polaris's native engine calls with its own session token
 * instead (`nativeSessionForToken`): it spends the models of the person who
 * started it, for as long as the session lasts, and no key enters its machine.
 */

import { authenticateApiKey } from "@/lib/api-key-auth";
import { nativeSessionForToken } from "@/lib/agents/session-service";
import { polarAccessFor, type PolarAccess } from "@/lib/polar/access";
import { compatError, errorResponse, isCompatError, type CompatError } from "@/lib/polar/compat/errors";

export interface CompatCaller {
    userId: string;
    /** The API key, or null for a native session's token. */
    keyId: string | null;
    /** The native session calling, or null for an API key. */
    sessionId: string | null;
    access: PolarAccess;
}

/** The request as `authenticateApiKey` reads it: an `x-api-key` stands in for
 *  a missing Bearer header. Only headers are read, so no body is copied. */
function withBearer(request: Request): Request {
    if (request.headers.get("authorization")) return request;
    const key = request.headers.get("x-api-key")?.trim();
    if (!key) return request;
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${key}`);
    return new Request(request.url, { method: "GET", headers });
}

/** The Bearer value, or "" when there is none. */
function bearerOf(request: Request): string {
    const header = request.headers.get("authorization") ?? "";
    return /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
}

export async function compatCaller(request: Request): Promise<CompatCaller | CompatError> {
    const authorized = withBearer(request);
    const principal = await authenticateApiKey(authorized);
    if (!principal) {
        const session = await nativeSessionForToken(bearerOf(authorized)).catch((error: unknown) => {
            console.error("[polar] native session token lookup failed", error);
            return null;
        });
        if (!session) return compatError("authentication_error", "Invalid or missing Polaris API key.");
        const access = await polarAccessFor(session.userId);
        if (!access.use) {
            return compatError("permission_error", "This account is not allowed to use Polar.");
        }
        return { userId: session.userId, keyId: null, sessionId: session.id, access };
    }
    if (!principal.scopes.includes("polar.use")) {
        return compatError("permission_error", "This API key does not have the polar.use permission.");
    }
    const access = await polarAccessFor(principal.userId);
    if (!access.use) {
        return compatError("permission_error", "This account is not allowed to use Polar.");
    }
    return { userId: principal.userId, keyId: principal.keyId, sessionId: null, access };
}

/**
 * The HEAD and OPTIONS answer free-claude-code gives on each generation route
 * (`api/routes.py`, `_probe_response`): 204 with the methods allowed, behind
 * the same key check as the route, so a client can test its key and base URL
 * without spending a call.
 */
export function compatProbe(allow: string, wire: "anthropic" | "openai") {
    return async (request: Request): Promise<Response> => {
        const caller = await compatCaller(request);
        if (isCompatError(caller)) return errorResponse(caller, wire);
        return new Response(null, { status: 204, headers: { allow } });
    };
}
