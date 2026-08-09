/**
 * Cron endpoint that keeps a copy of what each player is carrying, and carries
 * out the decisions that were waiting for them.
 *
 * `data get entity` only answers about somebody who is standing on the server, so
 * without this the question "what was this player carrying" stops being answerable
 * the moment they log off - which is the moment it is usually asked. The same walk
 * applies whatever an operator queued while they were away, because both need the
 * same thing: the list of who is on right now.
 *
 * Same contract as the other cron routes: disabled unless POLARIS_CRON_SECRET is
 * set, and callers present it as a bearer token (or an x-cron-key header). Node
 * runtime for Prisma.
 *
 * The panel does both of these lazily as well, so an instance with no cron is not
 * without them - it just gets them while somebody is looking at the screen.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { isGameServerApp } from "@/lib/apps/games-service";
import { drainQueue } from "@/lib/apps/minecraft/queue-service";
import { getServerPlayers } from "@/lib/apps/minecraft/service";
import { sweepInventorySnapshots } from "@/lib/apps/minecraft/inventory-service";

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

    const installs = await prisma.installedApp.findMany({
        where: { status: { not: "removed" } },
        select: { id: true, ownerId: true, catalogId: true }
    });

    let servers = 0;
    let snapshots = 0;
    let applied = 0;
    for (const install of installs) {
        if (!isGameServerApp(install.catalogId)) continue;
        // Who is on, asked once and used twice. A server that is not answering has
        // nobody on it as far as this is concerned, and neither pass has anything
        // to do - which is the common case and costs one refused connection.
        const online = await getServerPlayers(install.ownerId, install.id)
            .then((status) => (status.answering ? status.players.players : []))
            .catch(() => [] as string[]);
        if (online.length === 0) continue;
        servers += 1;
        const report = await drainQueue(install.ownerId, install.id, online).catch(() => null);
        applied += report?.applied ?? 0;
        snapshots += await sweepInventorySnapshots(install.ownerId, install.id, online).catch(() => 0);
    }

    return Response.json({ servers, snapshots, applied });
}
