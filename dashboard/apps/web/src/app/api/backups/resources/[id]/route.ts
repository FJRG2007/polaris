/**
 * One protected thing: its copies, where each landed, and what has run against
 * it. Admin-only. Node runtime for Prisma.
 */

import { requireAdmin } from "@/lib/session";
import { getResourceDetail } from "@/lib/backups/manage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    _request: Request,
    context: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await requireAdmin();
    const { id } = await context.params;
    const detail = await getResourceDetail(user.id, id);
    if (!detail) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(detail);
}
