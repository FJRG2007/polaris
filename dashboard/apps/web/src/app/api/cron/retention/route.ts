/**
 * Take one bite out of the records that are past their period, on demand.
 *
 * Polaris runs this on its own schedule (see `lib/cron/scheduler`), so nothing
 * has to call this route for a deployment to stay bounded. It stays for the
 * operator who would rather drive the timing themselves - and it goes through the
 * same job runner rather than calling the sweep directly, so both paths behave
 * identically whatever else is added to the job later.
 *
 * A pass is bounded, so a scheduler pointed at this on an instance with years of
 * history takes a bite per call rather than the lot. That is the same thing the
 * internal schedule does, and it is why calling this more often is safe.
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

    const swept = await runScheduledJob("retention");
    // Null means somebody else is already inside this one, which is an answer
    // rather than a failure: the work is happening, just not here.
    return Response.json(swept ?? { skipped: "already running" });
}
