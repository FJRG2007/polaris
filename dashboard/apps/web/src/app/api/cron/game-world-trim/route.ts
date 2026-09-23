/**
 * Take the chunks nobody has ever been in out of the worlds that are due for it.
 *
 * Only ever touches a server that is already stopped: the optimizer rewrites
 * region files, which is safe exactly while nothing else has them open, and a
 * background pass does not get to stop somebody's server to give itself the
 * chance. So this usually finds nothing to do, which is the intended shape.
 *
 * Polaris runs it on its own schedule (see `lib/cron/scheduler`). The route stays
 * for an operator who would rather drive the timing themselves.
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

    const swept = await runScheduledJob("game-world-trim");
    return Response.json(swept ?? { skipped: "already running" });
}
