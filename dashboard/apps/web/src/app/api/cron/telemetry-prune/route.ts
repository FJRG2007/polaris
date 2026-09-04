/**
 * Remove the crash reports a project no longer keeps, on demand.
 *
 * Polaris runs this on its own schedule (see `lib/cron/scheduler`), so nothing
 * has to call this route for a deployment to stay bounded. It stays for the
 * operator who would rather drive the timing themselves - and it goes through the
 * same job runner rather than calling the sweep directly, so both paths behave
 * identically whatever else is added to the job later.
 *
 * What it removes is each project's events past its retention. The daily counts
 * are left alone on purpose: the shape of a fault over months is worth keeping
 * long after the individual stack traces stop being worth the disk.
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

    const removed = await runScheduledJob("telemetry-prune");
    // Null means somebody else is already inside this one, which is an answer
    // rather than a failure: the work is happening, just not here.
    return Response.json(removed ?? { skipped: "already running" });
}
