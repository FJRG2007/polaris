/**
 * Find the game servers that are restarting without ever starting, and stop them.
 *
 * A container Polaris means to keep up is one the engine restarts every time it
 * dies, which is right for a server that crashed once and wrong for one that
 * cannot start at all - the second case restarts forever, burning a core on
 * nothing, and looks from outside exactly like a first boot that is taking its
 * time. This pass is what tells them apart, stops the second, and says why.
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

    const swept = await runScheduledJob("game-health");
    return Response.json(swept ?? { skipped: "already running" });
}
