/**
 * POST /api/oauth/register - Dynamic Client Registration (RFC 7591).
 *
 * How VS Code, Cursor and most other MCP clients introduce themselves before
 * sending somebody to the consent screen. Open to anyone, as the MCP spec
 * expects, so it is fenced: a small body, a few registrations an hour from one
 * address and a ceiling for the whole instance, redirect addresses that are
 * https or this computer only, and registrations nobody approved removed after
 * a day. A registration grants nothing - a person still has to say yes.
 */

import { clientIp } from "@/lib/request-context";
import { readCappedBody } from "@/lib/request-body";
import { rateLimit } from "@/lib/rate-limit-service";
import { hostOf, logRefusal } from "@/lib/mcp/oauth/log";
import { MAX_REDIRECT_URIS, checkRegistration, registerClient } from "@/lib/mcp/oauth/clients";
import { oauthError, oauthJson, preflight, slowDown } from "@/lib/mcp/oauth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A registration is a few hundred bytes; this is room for ten long addresses. */
const BODY_MAX = 32 * 1024;
const HOUR = 60 * 60 * 1000;
/** Per address: an editor registers once per server, a busy office a handful. */
const PER_ADDRESS_PER_HOUR = 20;
/** For the whole instance, so many addresses together cannot fill the table. */
const PER_INSTANCE_PER_HOUR = 500;
/** Throttled keys already logged, until their window ends; bounded so many addresses cannot grow it. */
const loggedUntil = new Map<string, number>();
const MAX_LOGGED_KEYS = 1000;

/** True the first time a key is refused in its window, so a flood logs one line instead of one per request. */
function firstRefusalInWindow(key: string, retryAfterMs: number): boolean {
    const now = Date.now();
    if ((loggedUntil.get(key) ?? 0) > now) return false;
    if (loggedUntil.size >= MAX_LOGGED_KEYS) {
        for (const [logged, until] of loggedUntil) if (until <= now) loggedUntil.delete(logged);
        if (loggedUntil.size >= MAX_LOGGED_KEYS) return false;
    }
    loggedUntil.set(key, now + retryAfterMs);
    return true;
}

export async function POST(request: Request): Promise<Response> {
    const ip = (await clientIp()) ?? "unknown";
    for (const [key, limit] of [
        [`oauth-register:${ip}`, PER_ADDRESS_PER_HOUR],
        ["oauth-register:all", PER_INSTANCE_PER_HOUR]
    ] as const) {
        const throttle = await rateLimit(key, limit, HOUR);
        if (!throttle.ok) {
            if (firstRefusalInWindow(key, throttle.retryAfterMs)) {
                logRefusal("registration", {
                    reason: key.endsWith(":all")
                        ? "rate limited (whole instance)"
                        : "rate limited (per address)",
                    retry_after_s: Math.ceil(throttle.retryAfterMs / 1000)
                });
            }
            return slowDown(throttle.retryAfterMs);
        }
    }

    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > BODY_MAX) {
        logRefusal("registration", { reason: "body too large", bytes: declared });
        return oauthError("invalid_client_metadata", "The registration is too large", 413);
    }
    const bytes = await readCappedBody(request, BODY_MAX);
    if (!bytes) {
        logRefusal("registration", { reason: "body too large" });
        return oauthError("invalid_client_metadata", "The registration is too large", 413);
    }
    let body: unknown;
    try {
        body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        logRefusal("registration", { reason: "body is not JSON" });
        return oauthError("invalid_client_metadata", "The registration must be a JSON object");
    }

    const checked = checkRegistration(body);
    if (!checked.ok) {
        const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
        logRefusal("registration", {
            reason: `${checked.refusal.error}: ${checked.refusal.description}`,
            client_name: typeof fields.client_name === "string" ? fields.client_name : undefined,
            redirect_hosts: Array.isArray(fields.redirect_uris)
                ? fields.redirect_uris.slice(0, MAX_REDIRECT_URIS).map(hostOf).join(", ")
                : undefined
        });
        return oauthError(checked.refusal.error, checked.refusal.description);
    }
    return oauthJson(await registerClient(checked), 201);
}

export function OPTIONS(): Response {
    return preflight();
}
