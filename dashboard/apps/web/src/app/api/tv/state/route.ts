/**
 * GET /api/tv/state - what a connected TV shows: whose it is, and how much is
 * waiting for them. Counts only; a title on a shared screen is not this key's to read.
 *
 * Also how a TV learns it was asked to update (`updateRequest`), and where it says
 * what it runs: `?versionName=&versionCode=`, or failing those the version in its
 * user agent (`polaris-tv/<version>`). A malformed version is ignored, never refused.
 * Reporting `versionCode` is how a TV says it carries out `updateRequest`; one that
 * names only its version is never offered an update from /account/tv.
 *
 * `desired` is what the TV's owner asked of it from /account/tv
 * (`{ blocking, choice }`), or null when they never chose, so the TV keeps its
 * own setting. The TV acts once per `choice` and says what it did with
 * `?blocking=&blockingChoice=<choice>` (lib/tv/preferences); a malformed report
 * is ignored, never refused.
 */

import { prisma } from "@polaris/db";
import { tvCaller } from "@/lib/tv/auth";
import { requestOrigin } from "@/lib/domain-service";
import { withKeyUsage } from "@/lib/api-usage/recorder";
import * as updates from "@/lib/tv/update-requests";
import * as preferences from "@/lib/tv/preferences";
import * as picks from "@/lib/tv/catalog-picks";

/** What this TV says it runs, from the query or its user agent; null when neither reads. */
function reportedVersion(request: Request): updates.TvVersion | null {
    const query = new URL(request.url).searchParams;
    const versionCode = query.get("versionCode") ?? undefined;
    const candidates = [
        query.get("versionName"),
        updates.versionFromUserAgent(request.headers.get("user-agent"))
    ];
    for (const named of candidates) {
        if (!named) continue;
        const parsed = updates.tvVersionSchema.safeParse({ versionName: named, versionCode });
        if (parsed.success) return parsed.data;
        // A bad build number does not cost the version beside it.
        const nameOnly = updates.tvVersionSchema.safeParse({ versionName: named });
        if (nameOnly.success) return nameOnly.data;
    }
    return null;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withKeyUsage(async (request: Request): Promise<Response> => {
    const caller = await tvCaller(request);
    if (caller instanceof Response) return caller;
    const version = reportedVersion(request);
    if (version) await updates.noteTvVersion(caller.keyId, version);
    const blocking = preferences.reportedBlocking(request);
    if (blocking) await preferences.noteTvBlocking(caller.keyId, caller.userId, blocking);
    const catalog = picks.reportedCatalog(request);
    if (catalog) await picks.noteTvCatalog(caller.keyId, catalog);
    const unreadWhere = { userId: caller.userId, readAt: null };
    const [user, unread, alerts, updateRequest, desired] = await Promise.all([
        prisma.user.findUnique({ where: { id: caller.userId }, select: { name: true } }),
        prisma.notification.count({ where: unreadWhere }),
        prisma.notification.count({
            where: { ...unreadWhere, OR: [{ actionRequired: true }, { level: "danger" }] }
        }),
        updates.pendingTvUpdate(caller.keyId),
        preferences.desiredFor(caller.keyId)
    ]);
    if (!user) return new Response(null, { status: 401 });
    return Response.json(
        {
            instance: { name: new URL(requestOrigin(request)).host },
            account: { name: user.name },
            unread,
            alerts,
            updateRequest,
            desired
        },
        { headers: { "cache-control": "no-store" } }
    );
});
