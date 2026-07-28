/**
 * Bearer-token authentication for API routes acting on a user's behalf. This is
 * the counterpart of the session guard: same account, different credential, and
 * the same network rules applied before anything is served.
 *
 * A key is presented as `Authorization: Bearer plk_....`. Verification resolves
 * the owner and intersects the key's scopes with what that owner holds right now,
 * so a demoted user's keys shrink with them and nothing survives in the token
 * itself. Failures are reported as one generic 401 - which key, why, and whether
 * it exists are all the caller's problem, not information to hand out.
 */

import { touchApiKey, verifyApiKey } from "@polaris/auth";
import type { Permission } from "@polaris/core";
import { evaluateNetworkRules } from "@/lib/network-rules";
import { clientIp } from "@/lib/request-context";

export interface ApiKeyPrincipal {
    keyId: string;
    userId: string;
    scopes: Permission[];
}

/** Extract the presented key, or null when the header is absent or malformed. */
function bearerToken(request: Request): string | null {
    const header = request.headers.get("authorization");
    if (!header) return null;
    const [scheme, ...rest] = header.trim().split(/\s+/);
    if (scheme?.toLowerCase() !== "bearer") return null;
    const token = rest.join("");
    return token.length > 0 ? token : null;
}

/**
 * Resolve the caller from an API key, or null when there is no usable one. The
 * usage stamp is written on success and never blocks the request.
 */
export async function authenticateApiKey(request: Request): Promise<ApiKeyPrincipal | null> {
    const token = bearerToken(request);
    if (!token) return null;

    const verified = await verifyApiKey(token);
    if (!verified) return null;

    const ip = await clientIp();
    const decision = await evaluateNetworkRules(verified.rules, ip);
    if (!decision.allowed) return null;

    await touchApiKey(verified.id, ip);
    return { keyId: verified.id, userId: verified.userId, scopes: verified.scopes };
}

/**
 * Guard for an API route: resolve the key and require one scope. Returns either
 * the principal or the Response to send back, so a handler stays a single
 * `if (result instanceof Response) return result` away from its work.
 */
export async function requireApiKey(
    request: Request,
    required?: Permission
): Promise<ApiKeyPrincipal | Response> {
    const principal = await authenticateApiKey(request);
    if (!principal) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (required && !principal.scopes.includes(required)) {
        return Response.json({ error: "Forbidden", requiredScope: required }, { status: 403 });
    }
    return principal;
}
