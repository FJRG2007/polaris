/**
 * Take away the machines an agent left behind, on demand.
 *
 * Polaris runs this on its own schedule too (see `lib/cron/scheduler`). The route
 * is for an operator who would rather drive the timing, and for the one case
 * worth forcing: somebody who abandoned a sign-in and is now being told one is
 * already open, with the next scheduled pass minutes away.
 *
 * Two sweeps behind it - sessions whose machine stopped reporting, and sign-in
 * containers nobody finished. Both are safe to run at any time and neither
 * touches anything a person is still using.
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

    const processed = await runScheduledJob("agent-housekeeping");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
