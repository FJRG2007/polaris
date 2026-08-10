/**
 * Keep every game server's firewall true, on demand: the addresses the Polaris
 * firewall blocks, and the player list each server is closed by.
 *
 * The firewall guards HTTP and a game server is not HTTP, so nothing joins the two
 * by itself; a ban added while a server is running would otherwise only reach it
 * the next time somebody pressed the button on its page. The player list is the
 * same problem from the other side - a rule that says a name may only connect from
 * one address means nothing until somebody checks the players who are already on.
 *
 * The same walk is what lifts a timeout when it runs out, and Polaris now runs it
 * on its own schedule (see `lib/cron/scheduler`), so a ten-minute cool-off ends
 * after ten minutes whether or not anything calls this. The route stays for an
 * operator who would rather drive the timing themselves.
 *
 * Disabled unless POLARIS_CRON_SECRET is set, and callers present it as a bearer
 * token (or an x-cron-key header). Node runtime for Prisma.
 */

import { authorizeCron } from "@/lib/cron/authorize";
import { runScheduledJob } from "@/lib/cron/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const refused = authorizeCron(request);
    if (refused) return refused;

    const synced = await runScheduledJob("game-firewall");
    return Response.json(synced ?? { skipped: "already running" });
}
