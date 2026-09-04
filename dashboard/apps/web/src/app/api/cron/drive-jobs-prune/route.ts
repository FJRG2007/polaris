/**
 * Forget the long Drive jobs that are over, on demand.
 *
 * Polaris runs this on its own schedule too (see `lib/cron/scheduler`). A
 * finished job is worth keeping only long enough for the screen that started it
 * to show that it finished; after that it is a row nobody will read.
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

    const processed = await runScheduledJob("drive-jobs-prune");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
