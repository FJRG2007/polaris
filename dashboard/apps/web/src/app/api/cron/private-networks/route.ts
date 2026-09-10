/**
 * Settle this machine's private networks on demand: reattach Polaris's own
 * containers to every network still wanted, and remove the ones nothing is on.
 *
 * Polaris runs this on its own schedule too (see `lib/cron/scheduler`). The route
 * is for an operator who would rather drive the timing themselves.
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

    const processed = await runScheduledJob("private-networks");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
