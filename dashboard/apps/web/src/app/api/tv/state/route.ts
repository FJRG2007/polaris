/**
 * GET /api/tv/state - what a connected TV shows: whose it is, and how much is
 * waiting for them. Counts only; a title on a shared screen is not this key's to read.
 */

import { prisma } from "@polaris/db";
import { tvCaller } from "@/lib/tv/auth";
import { requestOrigin } from "@/lib/domain-service";
import { withKeyUsage } from "@/lib/api-usage/recorder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withKeyUsage(async (request: Request): Promise<Response> => {
    const caller = await tvCaller(request);
    if (caller instanceof Response) return caller;
    const unreadWhere = { userId: caller.userId, readAt: null };
    const [user, unread, alerts] = await Promise.all([
        prisma.user.findUnique({ where: { id: caller.userId }, select: { name: true } }),
        prisma.notification.count({ where: unreadWhere }),
        prisma.notification.count({
            where: { ...unreadWhere, OR: [{ actionRequired: true }, { level: "danger" }] }
        })
    ]);
    if (!user) return new Response(null, { status: 401 });
    return Response.json(
        {
            instance: { name: new URL(requestOrigin(request)).host },
            account: { name: user.name },
            unread,
            alerts
        },
        { headers: { "cache-control": "no-store" } }
    );
});
