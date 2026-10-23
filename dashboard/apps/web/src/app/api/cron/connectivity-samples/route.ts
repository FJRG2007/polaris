/**
 * Take one connectivity sample now: latency, loss, DNS, and (on its turn) the
 * public address, the same pass Polaris runs every minute on its own schedule
 * (see `lib/cron/scheduler`). It stays for the operator who would rather drive
 * the timing themselves, through the same job runner so both paths behave
 * identically.
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

    const sampled = await runScheduledJob("connectivity-samples");
    // Null means another runner holds this minute's lease, which is an answer
    // rather than a failure: the sample is being taken, just not here.
    return Response.json(sampled === null ? { skipped: "already running" } : { sampled });
}
