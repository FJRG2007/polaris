/**
 * Keep a copy of what each player is carrying, and carry out the decisions that
 * were waiting for them, on demand.
 *
 * `data get entity` only answers about somebody who is standing on the server, so
 * without this the question "what was this player carrying" stops being answerable
 * the moment they log off - which is the moment it is usually asked. The same walk
 * applies whatever an operator queued while they were away, because both need the
 * same thing: the list of who is on right now.
 *
 * The panel does both of these lazily, and Polaris now runs them on its own
 * schedule as well (see `lib/cron/scheduler`), so they no longer wait for somebody
 * to be looking at the screen. The route stays for an operator who would rather
 * drive the timing themselves.
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

    const swept = await runScheduledJob("game-inventories");
    return Response.json(swept ?? { skipped: "already running" });
}
