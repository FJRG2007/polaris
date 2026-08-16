/**
 * Let back in every account whose suspension has run out, on demand.
 *
 * It also runs on Polaris's own schedule (see `lib/cron/scheduler`), which is what
 * makes a suspension end by itself. The route stays for an operator who would
 * rather drive the timing themselves.
 *
 * Disabled unless POLARIS_CRON_SECRET is set; when set, callers must present it as
 * a bearer token (or x-cron-key header). Node runtime for Prisma.
 */

import { authorizeCron } from "@/lib/cron/authorize";
import { runScheduledJob } from "@/lib/cron/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const refused = authorizeCron(request);
    if (refused) return refused;

    const lifted = await runScheduledJob("suspensions");
    return Response.json(lifted === null ? { skipped: "already running" } : { lifted });
}
