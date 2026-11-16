/**
 * The plumbing every `/api/v1/sessions` route shares, so no route can forget
 * it: the key is resolved and its scope checked before anything else, the key
 * is rate-limited, a body or query of the wrong shape is refused naming the
 * field, and a failure from beneath is logged and replaced by a sentence that
 * names nothing internal (`SessionRefusal` is the only message passed through).
 */

import type { Permission } from "@polaris/core";
import { rateLimit } from "@/lib/rate-limit-service";
import { authenticateApiKey, type ApiKeyPrincipal } from "@/lib/api-key-auth";
import { withKeyUsage } from "@/lib/api-usage/recorder";
import { DeployApiRefusal } from "@/lib/deploy/api/refusal";
import { SessionRefusal } from "@/lib/agents/session-service";

/** Calls one key may make in a minute, and how many may change something.
 *  Room for a CI job and its stream reconnects; a ceiling for a script in a loop. */
const CALLS_PER_MINUTE = 240;
const CHANGES_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

const NO_STORE = { "cache-control": "no-store" };

/** A refusal with a status and a sentence the caller may read. */
/**
 * A schema refusal, from whichever copy of Zod threw it. The request shapes
 * live in `@polaris/sdk`, which carries its own Zod, so `instanceof` against
 * this app's would miss every one of them and answer a bad body with a 500.
 */
function zodIssues(caught: unknown): { path: (string | number)[]; message: string }[] | null {
    if (!(caught instanceof Error) || caught.name !== "ZodError") return null;
    const issues = (caught as { issues?: unknown }).issues;
    return Array.isArray(issues) ? (issues as { path: (string | number)[]; message: string }[]) : null;
}

export class SessionApiRefusal extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = "SessionApiRefusal";
    }
}

export function refusal(status: number, message: string, headers?: Record<string, string>): Response {
    return Response.json({ error: message }, { status, headers: { ...NO_STORE, ...headers } });
}

/** Seconds to wait when a budget of this key is spent, or null to go ahead. */
export async function throttleSessionKey(keyId: string, changes: boolean): Promise<number | null> {
    for (const [bucket, limit] of [
        [`session-api:${keyId}`, CALLS_PER_MINUTE],
        ...(changes ? [[`session-api-change:${keyId}`, CHANGES_PER_MINUTE] as const] : [])
    ] as const) {
        const throttle = await rateLimit(bucket, limit, WINDOW_MS);
        if (!throttle.ok) return Math.max(1, Math.ceil(throttle.retryAfterMs / 1000));
    }
    return null;
}

export interface SessionRouteContext {
    readonly principal: ApiKeyPrincipal;
    readonly request: Request;
    readonly url: URL;
    readonly params: Readonly<Record<string, string>>;
}

/** Wrap a handler with the key, its scope, its budget and the error mapping. */
export function sessionApiRoute(
    scope: Permission,
    changes: boolean,
    handler: (context: SessionRouteContext) => Promise<Response>
) {
    return withKeyUsage(
        async (
            request: Request,
            segment: { params: Promise<Record<string, string>> }
        ): Promise<Response> => {
            const principal = await authenticateApiKey(request);
            // i18n-ignore: API status bodies read by programs, in English like the rest of the API
            if (!principal) return refusal(401, "Unauthorized");
            if (!principal.scopes.includes(scope))
                return Response.json(
                    // i18n-ignore: as above
                    { error: `This API key does not have the ${scope} permission.`, requiredScope: scope },
                    { status: 403, headers: NO_STORE }
                );
            const wait = await throttleSessionKey(principal.keyId, changes);
            if (wait !== null)
                // i18n-ignore: as above
                return refusal(429, `Too many calls with this key. Try again in ${wait}s.`, {
                    "Retry-After": String(wait)
                });
            try {
                return await handler({
                    principal,
                    request,
                    url: new URL(request.url),
                    params: await segment.params
                });
            } catch (caught) {
                const issues = zodIssues(caught);
                if (issues) {
                    const first = issues[0];
                    const where = first?.path.join(".");
                    return refusal(400, where ? `${where}: ${first?.message}` : (first?.message ?? "Bad request"));
                }
                if (caught instanceof SessionApiRefusal || caught instanceof DeployApiRefusal)
                    return refusal(caught.status, caught.message);
                if (caught instanceof SessionRefusal) return refusal(409, caught.message);
                console.error(`polaris: ${request.method} ${new URL(request.url).pathname} failed:`, caught);
                // i18n-ignore: as above
                return refusal(500, "Polaris could not do that. Nothing was changed by this call.");
            }
        }
    );
}

/** Answer with JSON, never cached. */
export function answer(data: unknown, status = 200): Response {
    return Response.json(data, { status, headers: NO_STORE });
}

/** The session behind `:id` that this key reaches, or a 404 - the same for
 *  "no such session" and "not yours". */
export function sessionNotFound(): SessionApiRefusal {
    // i18n-ignore: as above
    return new SessionApiRefusal(404, "No session with that id that this key can reach.");
}
