/**
 * Ask the cameras whether they are still there, on demand.
 *
 * Polaris runs this on its own schedule too (see `lib/cron/scheduler`). The route
 * is for an operator who would rather drive the timing themselves, and for the
 * one case where it is genuinely useful to force: somebody who has just put the
 * power back on and wants the house to stop saying the cameras are dark without
 * waiting for the next pass.
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

    const processed = await runScheduledJob("home-availability");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
