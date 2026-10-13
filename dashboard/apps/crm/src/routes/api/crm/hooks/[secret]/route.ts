/**
 * A CRM workflow's webhook: POST `/api/crm/hooks/<secret>` with a JSON body
 * runs the workflow the secret names, and `{{body.<path>}}` in its actions is
 * that body's value. No session - the secret in the address is the key - and
 * rate limited per address and per caller. An address that names no enabled
 * webhook workflow is a plain 404, whatever was sent.
 */

import { host } from "@polaris/app-host";
import { hookHash, runHook } from "../../../../../lib/workflows";
import { MAX_HOOK_BODY } from "../../../../../model/workflows";

/** Calls one caller may make per minute, across every address. */
const PER_CALLER = 120;

/** Calls one address may take per minute, from everybody. */
const PER_HOOK = 60;

/** What a secret looks like: what `randomBytes(24).toString("base64url")` makes. */
const SECRET = /^[A-Za-z0-9_-]{32}$/;

const status = (code: number, body: unknown = null) =>
    body === null ? new Response(null, { status: code }) : Response.json(body, { status: code });

/** The body as text, or null past the limit. */
async function capped(request: Request): Promise<string | null> {
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_HOOK_BODY) return null;
    const text = await request.text();
    return new TextEncoder().encode(text).byteLength > MAX_HOOK_BODY ? null : text;
}

export async function POST(
    request: Request,
    context: { params: Promise<{ secret: string }> }
): Promise<Response> {
    const ip = (await host.requestContext.clientIp()) ?? "unknown";
    const { secret } = await context.params;
    const callers = await host.rateLimitService.rateLimit(`crm.hook:${ip}`, PER_CALLER, 60_000);
    if (!callers.ok) return new Response(null, { status: 429, headers: { "retry-after": "60" } });
    if (!SECRET.test(secret)) return status(404);
    const hooks = await host.rateLimitService.rateLimit(
        `crm.hook-address:${hookHash(secret)}`,
        PER_HOOK,
        60_000
    );
    if (!hooks.ok) return new Response(null, { status: 429, headers: { "retry-after": "60" } });
    const text = await capped(request);
    if (text === null) return status(413);
    try {
        const answer = await runHook(secret, text);
        if (answer === "unknown") return status(404);
        if (answer === "badBody") return status(400);
        return answer.error === null
            ? status(200, { ok: true })
            : status(200, { ok: false, error: answer.error });
    } catch (caught) {
        console.error("crm: a webhook call could not be answered", caught);
        return status(500, { error: "unavailable" });
    }
}
