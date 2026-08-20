/**
 * Ask the accounts people have linked whether they still work, on demand.
 *
 * It also runs on Polaris's own schedule (see `lib/cron/scheduler`), which is what
 * makes an expired token announce itself rather than being discovered by a deploy
 * failing at the clone. The route stays for an operator who would rather drive the
 * timing themselves.
 *
 * Disabled unless POLARIS_CRON_SECRET is set; when set, callers must present it as
 * a bearer token (or x-cron-key header). Node runtime for Prisma.
 */

import { authorizeCron } from "@/lib/cron/authorize";
import { runScheduledJob } from "@/lib/cron/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const refused = authorizeCron(request);
    if (refused) return refused;

    const checked = await runScheduledJob("connection-health");
    return Response.json(checked === null ? { skipped: "already running" } : { checked });
}
