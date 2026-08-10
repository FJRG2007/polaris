/**
 * The old world-backup cron path, kept so an installer that already calls it
 * keeps working.
 *
 * It runs the same job as /api/cron/backups rather than a second sweep of its
 * own. Two sweeps over the same worlds would each see the other's archive as the
 * newest and take one anyway, which is how a nightly schedule quietly becomes two
 * backups a night.
 *
 * New installs need call neither: Polaris keeps the schedule itself now. This one
 * is here for the ones that were set up before it did.
 */

import { authorizeCron } from "@/lib/cron/authorize";
import { runScheduledJob } from "@/lib/cron/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const refused = authorizeCron(request);
    if (refused) return refused;

    const swept = await runScheduledJob("backups");
    return Response.json(swept ?? { skipped: "already running" });
}
