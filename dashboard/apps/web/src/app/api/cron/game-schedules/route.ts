/**
 * Cron endpoint that applies every game server's schedule: starting the ones a
 * window says should be up, and stopping the ones that have sat empty long enough
 * to be let go.
 *
 * The Game servers page sweeps too, so a schedule works without this - but only
 * while somebody has the page open, which is nobody at four in the morning. This
 * is what makes "stopped overnight" true on a night when nobody looked.
 *
 * Same contract as the other cron routes: disabled unless POLARIS_CRON_SECRET is
 * set, and callers present it as a bearer token (or an x-cron-key header). Node
 * runtime for Prisma.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { sweepGameSchedules } from "@/lib/apps/minecraft/schedule-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function presentedToken(request: Request): string {
    const auth = request.headers.get("authorization") ?? "";
    if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
    return request.headers.get("x-cron-key")?.trim() ?? "";
}

export async function POST(request: Request): Promise<Response> {
    const secret = loadEnv().POLARIS_CRON_SECRET;
    if (!secret) return Response.json({ error: "Cron is not configured." }, { status: 503 });
    if (presentedToken(request) !== secret) return Response.json({ error: "Not authorized." }, { status: 401 });

    // Every owner who has an installed app, since a schedule belongs to a server
    // and this runs on nobody's behalf in particular.
    const owners = await prisma.installedApp.findMany({
        where: { status: { not: "removed" } },
        select: { ownerId: true },
        distinct: ["ownerId"]
    });
    let started = 0;
    let stopped = 0;
    for (const owner of owners) {
        const swept = await sweepGameSchedules(owner.ownerId).catch(() => null);
        if (!swept) continue;
        started += swept.started;
        stopped += swept.stopped;
    }
    return Response.json({ started, stopped });
}
