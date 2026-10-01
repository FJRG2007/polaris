/**
 * Fold connectivity outages older than a year into their month, on demand.
 *
 * Polaris runs this on its own schedule (see `lib/cron/scheduler`), so nothing
 * has to call this route for the history to stay bounded. It stays for the
 * operator who would rather drive the timing themselves, through the same job
 * runner so both paths behave identically.
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

    const folded = await runScheduledJob("connectivity-outages");
    // Null means somebody else is already inside this one, which is an answer
    // rather than a failure: the work is happening, just not here.
    return Response.json(folded === null ? { skipped: "already running" } : { folded });
}
