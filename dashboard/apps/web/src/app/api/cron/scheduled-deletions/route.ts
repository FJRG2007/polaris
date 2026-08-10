/**
 * Run every due scheduled deletion across all connections, on demand.
 *
 * Deletions also run lazily as connections are browsed, and Polaris now runs this
 * pass on its own schedule as well (see `lib/cron/scheduler`), so one scheduled
 * for a day nobody opens Drive still happens on that day. The route stays for an
 * operator who would rather drive the timing themselves.
 *
 * Disabled unless POLARIS_CRON_SECRET is set; when set, callers must present it as
 * a bearer token (or x-cron-key header). Node runtime for Prisma and the drivers.
 */

import { authorizeCron } from "@/lib/cron/authorize";
import { runScheduledJob } from "@/lib/cron/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const refused = authorizeCron(request);
    if (refused) return refused;

    const processed = await runScheduledJob("scheduled-deletions");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
