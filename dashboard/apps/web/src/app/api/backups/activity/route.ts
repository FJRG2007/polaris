/**
 * What has run: backups, restores and prunes, newest first, successes included.
 *
 * Successes are kept because the question this is opened for is usually "is it
 * still running" rather than "what broke", and a failures-only log cannot answer
 * the first one. Admin-only. Node runtime for Prisma.
 */

import { listActivity } from "@/lib/backups/manage";
import { apiAdmin } from "@/lib/api-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    const raw = Number(new URL(request.url).searchParams.get("limit"));
    const limit = Number.isFinite(raw) ? Math.min(500, Math.max(1, raw)) : 100;
    return Response.json({ jobs: await listActivity(user.id, limit) });
}
