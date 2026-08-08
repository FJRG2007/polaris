/**
 * Cron endpoint that takes the world backups that are due and prunes the ones
 * that have fallen out of retention.
 *
 * Unlike the schedule sweep, this one has no lazy counterpart on a page: an
 * archive of a large world takes real seconds inside the container, and hanging
 * that off somebody opening a screen would make the screen slow and the backup
 * dependent on being watched. So the cron is the mechanism rather than a
 * guarantee of timeliness on top of one - which is exactly why the World screen
 * says out loud when nothing is configured to run it.
 *
 * Same contract as the other cron routes: disabled unless POLARIS_CRON_SECRET is
 * set, and callers present it as a bearer token (or an x-cron-key header). Node
 * runtime for Prisma.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { sweepWorldBackups } from "@/lib/apps/minecraft/world-service";

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

    const owners = await prisma.installedApp.findMany({
        where: { status: { not: "removed" } },
        select: { ownerId: true },
        distinct: ["ownerId"]
    });
    let taken = 0;
    let pruned = 0;
    let failed = 0;
    for (const owner of owners) {
        const swept = await sweepWorldBackups(owner.ownerId).catch(() => []);
        for (const entry of swept) {
            if (entry.name) taken += 1;
            pruned += entry.pruned.length;
            if (entry.error) failed += 1;
        }
    }
    return Response.json({ taken, pruned, failed });
}
