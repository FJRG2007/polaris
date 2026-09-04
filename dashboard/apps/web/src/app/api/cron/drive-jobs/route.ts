/**
 * Pick up the long Drive jobs nobody is working on, on demand.
 *
 * Polaris runs this on its own schedule too (see `lib/cron/scheduler`), and a new
 * job is kicked the moment it is created - this is the backstop for the one whose
 * worker died mid-batch, or that was queued by a process which then restarted.
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

    const processed = await runScheduledJob("drive-jobs");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
