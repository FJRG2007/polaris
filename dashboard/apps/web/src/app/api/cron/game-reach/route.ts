/**
 * Knock on the game ports that are not proven yet, and record the ones that answer.
 *
 * A game server's port is proven either by a player arriving on it from outside or
 * by Polaris reaching it through the public address, and both screens that show the
 * advice do the second while somebody is watching them. This is the pass for when
 * nobody is: a server left to generate its world, or a forward made hours after the
 * page was closed, is otherwise still described as unconfirmed long after it works.
 *
 * Polaris runs it on its own schedule (see `lib/cron/scheduler`). The route stays
 * for an operator who would rather drive the timing themselves.
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

    const swept = await runScheduledJob("game-reach");
    return Response.json(swept ?? { skipped: "already running" });
}
