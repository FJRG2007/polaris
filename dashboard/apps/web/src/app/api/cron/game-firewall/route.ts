/**
 * Cron endpoint that hands every game server the addresses the firewall blocks.
 *
 * The firewall guards HTTP and a game server is not HTTP, so nothing joins the
 * two by itself; a ban added while a server is running would otherwise only reach
 * it the next time somebody pressed the button on its page. Same contract as the
 * other cron routes: disabled unless POLARIS_CRON_SECRET is set, and callers
 * present it as a bearer token (or an x-cron-key header). Node runtime for Prisma.
 */

import { prisma } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { syncFirewallBans } from "@/lib/apps/games-service";

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

    // Every owner who has a game server, since a blocklist is instance-wide and
    // this runs on nobody's behalf in particular.
    const owners = await prisma.installedApp.findMany({
        where: { status: { not: "removed" } },
        select: { ownerId: true },
        distinct: ["ownerId"]
    });
    let servers = 0;
    let banned = 0;
    for (const owner of owners) {
        const result = await syncFirewallBans(owner.ownerId).catch(() => null);
        if (!result) continue;
        servers += result.servers;
        banned += result.banned;
    }
    return Response.json({ servers, banned });
}
