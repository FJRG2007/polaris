/**
 * Remove the volumes of apps deleted a week ago that nothing has used since, on
 * demand.
 *
 * Polaris runs this on its own schedule too (see `lib/cron/scheduler`), unless
 * the storage screen's switch is off - see `lib/deploy/leftover-volumes`.
 *
 * Disabled unless POLARIS_CRON_SECRET is set; when set, callers must present it
 * as a bearer token (or x-cron-key header). Node runtime for Prisma.
 */

import { authorizeCron } from "@/lib/cron/authorize";
import { runScheduledJob } from "@/lib/cron/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const refused = authorizeCron(request);
    if (refused) return refused;

    const processed = await runScheduledJob("leftover-volumes");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
