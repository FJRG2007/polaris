/**
 * End the file offers nobody answered in time, on demand.
 *
 * Polaris runs this on its own schedule too (see `lib/cron/scheduler`). What it
 * clears is an offer the recipient already stopped being shown: it still counts
 * against how many the sender may have waiting, and still sits in their own list
 * as something that has not been answered.
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

    const processed = await runScheduledJob("drive-transfers");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
