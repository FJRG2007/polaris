/**
 * Run the announcements clock now, rather than on the next pass: send what is
 * due and move maintenance windows to the phase their times put them in.
 *
 * Polaris runs this on its own schedule (see `lib/cron/scheduler`). The route is
 * for an operator who would rather drive the timing themselves. The scheduler
 * holds a lease either way, so a caller and the internal pass cannot both send
 * the same announcement.
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

    const processed = await runScheduledJob("announcements");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
