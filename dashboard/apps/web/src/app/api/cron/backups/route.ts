/**
 * Take the backups that are due and prune what has fallen out of retention, on
 * demand.
 *
 * Polaris runs this on its own schedule (see `lib/cron/scheduler`), so nothing has
 * to call this route for a plan to be kept. It stays for the operator who would
 * rather drive the timing themselves, and for the installers that already point a
 * cron at it - which is also why it goes through the same job runner rather than
 * calling the sweep directly: both paths then take the same lease, and an external
 * scheduler running alongside the internal one cannot turn a nightly schedule into
 * two backups a night.
 *
 * Disabled unless POLARIS_CRON_SECRET is set, and callers present it as a bearer
 * token (or an x-cron-key header). Node runtime for Prisma.
 */

import { authorizeCron } from "@/lib/cron/authorize";
import { runScheduledJob } from "@/lib/cron/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const refused = authorizeCron(request);
    if (refused) return refused;

    const swept = await runScheduledJob("backups");
    // Null means somebody else is already inside this one, which is an answer
    // rather than a failure: the work is happening, just not here.
    return Response.json(swept ?? { skipped: "already running" });
}
