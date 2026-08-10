/**
 * Apply every game server's schedule on demand: starting the ones a window says
 * should be up, and stopping the ones that have sat empty long enough to be let
 * go.
 *
 * The Game servers page sweeps too, but only while somebody has it open, which is
 * nobody at four in the morning. Polaris now runs this on its own schedule (see
 * `lib/cron/scheduler`), which is what makes "stopped overnight" true on a night
 * when nobody looked. The route stays for an operator who would rather drive the
 * timing themselves.
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

    const swept = await runScheduledJob("game-schedules");
    return Response.json(swept ?? { skipped: "already running" });
}
