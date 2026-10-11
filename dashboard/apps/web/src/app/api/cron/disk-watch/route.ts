/**
 * Read the disk of every machine Polaris deploys to, and free what can be freed
 * on one that is running out, on demand.
 *
 * Polaris runs this on its own schedule too (see `lib/cron/scheduler`). Volumes
 * are never touched - see `lib/deploy/disk-watch`.
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

    const processed = await runScheduledJob("disk-watch");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
