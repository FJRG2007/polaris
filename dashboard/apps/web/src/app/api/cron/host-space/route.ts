/**
 * Hand back the room the container store is holding for nothing, on demand.
 *
 * Polaris runs this on its own schedule too (see `lib/cron/scheduler`). The route
 * is for an operator who would rather drive the timing themselves, and for the
 * one case worth forcing: a disk that has just gone tight and a deploy waiting
 * on it, where the next scheduled pass is hours away.
 *
 * Volumes are never touched, here or anywhere else - see `host-housekeeping`.
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

    const processed = await runScheduledJob("host-space");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
