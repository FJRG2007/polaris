/**
 * Clear the credential still held by marketplace installs that were removed, on
 * demand.
 *
 * Polaris runs this on its own schedule (see `lib/cron/scheduler`); an uninstall
 * clears its own row, so this only catches installs removed before it did.
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

    const cleared = await runScheduledJob("removed-install-secrets");
    return Response.json(cleared ?? { skipped: "already running" });
}
