/**
 * The desktop app saying which game is running on this computer, or that none is.
 *
 * Sent by the Polaris page inside the desktop app, on the session it is already
 * signed in with - the app itself holds no credential for this. A browser cannot
 * see what else is running on a computer, so nothing else ever calls it.
 *
 * Reported when the game changes and once a minute while it runs, which is what
 * keeps the card alive (see `GAME_REPORT_TTL_MS`). Rate limited per account well
 * above that, so a desktop app stuck in a loop costs a refusal rather than a
 * write and a frame to every room its owner is in.
 */

import * as core from "@polaris/core";
import { apiUser } from "@/lib/api-session";
import { rateLimit } from "@/lib/rate-limit-service";
import { reportGame } from "@/lib/presence-activity/service";
import { activitySettingsOf } from "@/lib/presence-activity/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Reports one account may send in a window: a change every few seconds for a
 *  minute is already far past anybody switching games. */
const REPORT_LIMIT = 20;
const REPORT_WINDOW_MS = 60_000;

/**
 * The programs this account said are games, for the desktop app to look for.
 * Only the account's own list, and only its own account's.
 */
export async function GET(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const { settings } = await activitySettingsOf(user.id);
    return Response.json(
        { customGames: settings.customGames },
        { headers: { "Cache-Control": "private, no-store" } }
    );
}

export async function POST(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;

    const throttle = await rateLimit(`activity-game:${user.id}`, REPORT_LIMIT, REPORT_WINDOW_MS);
    if (!throttle.ok) {
        return Response.json(
            { error: "Too many reports, try again in a moment" },
            {
                status: 429,
                headers: { "Retry-After": String(Math.ceil(throttle.retryAfterMs / 1000)) }
            }
        );
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "That could not be read" }, { status: 400 });
    }
    const report = core.gameReportSchema.safeParse(body);
    if (!report.success) return Response.json({ error: "That could not be read" }, { status: 400 });

    const outcome = await reportGame(user.id, report.data);
    return Response.json(outcome, { headers: { "Cache-Control": "private, no-store" } });
}
