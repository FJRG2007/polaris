/**
 * Probe every domain now, rather than on the next pass.
 *
 * Polaris runs this on its own schedule (see `lib/cron/scheduler`). The route is
 * for an operator who would rather drive the timing themselves, and for the case
 * worth forcing: a domain that has just been pointed somewhere new, where waiting
 * a minute to find out whether it answers is a minute of not knowing.
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

    const processed = await runScheduledJob("domain-health");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
