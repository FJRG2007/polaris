/**
 * This deployment's season calendar, for a client whose icon is shared with
 * other Polaris hosts and that has no page of this host open to report it: the
 * browser extension's toolbar button.
 *
 * The same report a page hands the desktop and phone apps (`appIconReport`):
 * the calendar the frame decides by, or null when the operator turned seasons
 * off. The client settles every host's answer by `appIconSeason` in core.
 *
 * Public and unauthenticated, like the season icons themselves: the dates are
 * the decoration every visitor of the sign-in page already sees. Open to every
 * origin with no credentials, and cacheable for an hour - a season changes on a
 * date, and the client asks a few times a day. Rate-limited per address so it is
 * not a free echo to hammer.
 *
 * Installs that predate this route answer 404, and the client then leaves that
 * host out, which is what the rule does for a host too old to say.
 */

import { NextResponse } from "next/server";
import { clientIp } from "@/lib/request-context";
import { rateLimit } from "@/lib/rate-limit-service";
import { seasonCalendar, seasonsAllowed } from "@/lib/seasonal-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LIMIT = 60;
const WINDOW_MS = 60_000;
const CACHE_SECONDS = 3_600;

const OPEN = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "accept"
} as const;

export function OPTIONS(): Response {
    return new Response(null, { status: 204, headers: { ...OPEN, "access-control-max-age": "86400" } });
}

export async function GET(): Promise<Response> {
    const limited = await rateLimit(`season:${(await clientIp()) ?? "unknown"}`, LIMIT, WINDOW_MS);
    if (!limited.ok) {
        return NextResponse.json(
            { error: "Too many requests. Try again in a minute." },
            {
                status: 429,
                headers: {
                    ...OPEN,
                    "cache-control": "no-store",
                    "retry-after": String(Math.ceil(limited.retryAfterMs / 1000))
                }
            }
        );
    }
    const calendar = (await seasonsAllowed()) ? await seasonCalendar() : null;
    return NextResponse.json(
        { calendar },
        { headers: { ...OPEN, "cache-control": `public, max-age=${CACHE_SECONDS}` } }
    );
}
