/**
 * Who a TV is acting for. Only a key of kind "tv" - the one its own connection
 * minted - is accepted, and it counts against a throttle of its own.
 */

import { rateLimit } from "@/lib/rate-limit-service";
import { translatorFor } from "@/lib/i18n/translate";
import { authenticateApiKey } from "@/lib/api-key-auth";

const LIMIT = 30;
const WINDOW_MS = 60_000;

export interface TvCaller {
    readonly userId: string;
    readonly keyId: string;
}

export async function tvCaller(request: Request): Promise<TvCaller | Response> {
    const principal = await authenticateApiKey(request);
    if (!principal || principal.kind !== "tv") {
        const t = translatorFor("en-US", "api");
        return Response.json({ error: t("errors.unauthorized") }, { status: 401 });
    }
    const throttle = await rateLimit(`tv:${principal.keyId}`, LIMIT, WINDOW_MS);
    if (!throttle.ok) {
        return new Response(null, {
            status: 429,
            headers: { "retry-after": String(Math.ceil(throttle.retryAfterMs / 1000)) }
        });
    }
    return { userId: principal.userId, keyId: principal.keyId };
}
