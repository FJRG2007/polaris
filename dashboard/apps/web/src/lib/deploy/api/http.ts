/**
 * The plumbing every `/api/v1/deploy` route shares.
 *
 * A route is a sentence long: which operation it is, whether it changes
 * anything, and the call into `surface.ts`. Everything that must be the same on
 * every route lives here so no route can forget it - the key is resolved before
 * anything else, the key is rate-limited, a body that is not JSON or not the
 * right shape is refused with the field that was wrong, and whatever is thrown is
 * passed through `publicFailure` so nothing from beneath the service layer
 * reaches the caller.
 */

import { ZodError } from "zod";
import type { DeployCaller } from "./surface";
import { rateLimit } from "@/lib/rate-limit-service";
import { authenticateApiKey } from "@/lib/api-key-auth";
import { DeployApiRefusal, publicFailure } from "./refusal";

/** Calls one key may make in a minute, and how many of them may change
 *  something. Generous for a CLI or a CI job, and a ceiling for a script that
 *  went into a loop - every call reaches the database and some reach a server. */
const CALLS_PER_MINUTE = 240;
const CHANGES_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

export interface RouteContext {
    readonly caller: DeployCaller;
    readonly request: Request;
    readonly url: URL;
    readonly params: Readonly<Record<string, string>>;
}

type Handler = (context: RouteContext) => Promise<Response>;

function refusal(status: number, message: string, headers?: Record<string, string>): Response {
    return Response.json({ error: message }, { status, headers });
}

/**
 * Wrap a handler with authentication, rate limiting and error mapping.
 *
 * `operation` finishes "Polaris could not ..." when the real reason is kept for
 * the server log; `changes` picks the stricter of the two rate limits.
 */
export function deployRoute(operation: string, changes: boolean, handler: Handler) {
    return async (
        request: Request,
        segment: { params: Promise<Record<string, string>> }
    ): Promise<Response> => {
        const principal = await authenticateApiKey(request);
        if (!principal) return refusal(401, "Unauthorized");

        for (const [bucket, limit] of [
            [`deploy-api:${principal.keyId}`, CALLS_PER_MINUTE],
            ...(changes ? [[`deploy-api-change:${principal.keyId}`, CHANGES_PER_MINUTE] as const] : [])
        ] as const) {
            const throttle = await rateLimit(bucket, limit, WINDOW_MS);
            if (!throttle.ok) {
                const seconds = Math.max(1, Math.ceil(throttle.retryAfterMs / 1000));
                return refusal(429, `Too many calls with this key. Try again in ${seconds}s.`, {
                    "Retry-After": String(seconds)
                });
            }
        }

        const caller: DeployCaller = {
            userId: principal.userId,
            scopes: principal.scopes,
            keyId: principal.keyId,
            projectId: principal.projectId,
            via: "api"
        };
        try {
            return await handler({
                caller,
                request,
                url: new URL(request.url),
                params: await segment.params
            });
        } catch (caught) {
            if (caught instanceof ZodError) {
                const first = caught.issues[0];
                const where = first?.path.join(".");
                return refusal(400, where ? `${where}: ${first?.message}` : (first?.message ?? "Bad request"));
            }
            const failure = publicFailure(caught, operation);
            return refusal(failure.status, failure.message);
        }
    };
}

/** The request body as JSON, or a refusal saying it was not. An empty body is an
 *  empty object, so a POST with nothing to say needs no `{}`. */
export async function readBody(request: Request): Promise<unknown> {
    const text = await request.text();
    if (!text.trim()) return {};
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new DeployApiRefusal(400, "The request body is not JSON.");
    }
}

/** The query string as a plain object, for a schema to parse. */
export function queryOf(url: URL): Record<string, string> {
    return Object.fromEntries(url.searchParams.entries());
}

/** Whether the caller asked for the tab-separated form. */
export function wantsText(url: URL): boolean {
    return url.searchParams.get("format") === "text";
}

/** Answer with JSON, or with the text form when it was asked for and exists. */
export function respond(url: URL, data: unknown, asText?: () => string, status = 200): Response {
    if (asText && wantsText(url)) {
        return new Response(asText(), {
            status,
            headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
        });
    }
    return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}
