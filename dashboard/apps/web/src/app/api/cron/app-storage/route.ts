/**
 * Take every stopped service with a storage mode to where that mode keeps it, on
 * demand.
 *
 * Polaris runs this on its own schedule too (see `lib/cron/scheduler`). See
 * `lib/storage-moves/app-storage` for what it does.
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

    const processed = await runScheduledJob("app-storage");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
