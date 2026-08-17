/**
 * Drop the footage that is past its keeping, on demand.
 *
 * Polaris runs this on its own schedule too (see `lib/cron/scheduler`). The route
 * is for an operator who would rather drive the timing themselves - footage is
 * the only part of the house that grows whether or not anybody uses it, so this
 * is the pass that decides whether a disk fills.
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

    const processed = await runScheduledJob("home-retention");
    return Response.json(processed === null ? { skipped: "already running" } : { processed });
}
