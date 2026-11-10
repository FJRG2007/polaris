/**
 * Delete the quick sends that are over, on demand.
 *
 * Polaris runs this on its own schedule too (see `lib/cron/scheduler`). A link
 * that expired or ran out of downloads keeps nothing anybody can reach, so its
 * files go soon after rather than at the end of the day.
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

    const processed = await runScheduledJob("drive-quick-send");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
