/**
 * Cron endpoint that takes the backups that are due and prunes what has fallen
 * out of retention.
 *
 * Cron is the mechanism rather than a guarantee on top of one: archiving a real
 * world or dumping a real database takes seconds inside a container, and hanging
 * that off somebody opening a screen would make the screen slow and the backup
 * dependent on being watched. So there is no lazy counterpart - which is exactly
 * why the console says out loud when nothing is configured to call this.
 *
 * Same contract as the other cron routes: disabled unless POLARIS_CRON_SECRET is
 * set, and callers present it as a bearer token (or an x-cron-key header). Node
 * runtime for Prisma.
 */

import { loadEnv } from "@polaris/config";
import { sweepDueBackups } from "@/lib/backups/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function presentedToken(request: Request): string {
    const auth = request.headers.get("authorization") ?? "";
    if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
    return request.headers.get("x-cron-key")?.trim() ?? "";
}

export async function POST(request: Request): Promise<Response> {
    const secret = loadEnv().POLARIS_CRON_SECRET;
    if (!secret) return Response.json({ error: "Cron is not configured." }, { status: 503 });
    if (presentedToken(request) !== secret) return Response.json({ error: "Not authorized." }, { status: 401 });

    const swept = await sweepDueBackups();
    return Response.json(swept);
}
