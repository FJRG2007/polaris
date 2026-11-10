/**
 * Who is calling the compatible API. A Polaris API key with `polar.use`,
 * presented the way each client sends it: Claude Code puts
 * `ANTHROPIC_API_KEY` in `x-api-key` and `ANTHROPIC_AUTH_TOKEN` in
 * `Authorization: Bearer`; OpenAI clients always send Bearer. The owner must
 * also be allowed Polar right now: a key outlives a change of policy.
 */

import { authenticateApiKey } from "@/lib/api-key-auth";
import { polarAccessFor, type PolarAccess } from "@/lib/polar/access";
import { compatError, errorResponse, isCompatError, type CompatError } from "@/lib/polar/compat/errors";

export interface CompatCaller {
    userId: string;
    keyId: string;
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

export async function compatCaller(request: Request): Promise<CompatCaller | CompatError> {
    const principal = await authenticateApiKey(withBearer(request));
    if (!principal) {
        return compatError("authentication_error", "Invalid or missing Polaris API key.");
    }
    if (!principal.scopes.includes("polar.use")) {
        return compatError("permission_error", "This API key does not have the polar.use permission.");
    }
    const access = await polarAccessFor(principal.userId);
    if (!access.use) {
        return compatError("permission_error", "This account is not allowed to use Polar.");
    }
    return { userId: principal.userId, keyId: principal.keyId, access };
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
