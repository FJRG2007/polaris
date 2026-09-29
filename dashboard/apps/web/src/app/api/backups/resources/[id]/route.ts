/**
 * One protected thing: its copies, where each landed, and what has run against
 * it. Admin-only. Node runtime for Prisma.
 */

import { getResourceDetail } from "@/lib/backups/manage";
import { apiAdmin } from "@/lib/api-session";
import { readerWords } from "@/lib/i18n/reader-words";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    _request: Request,
    context: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    const { id } = await context.params;
    const detail = await getResourceDetail(user.id, id);
    if (!detail) return Response.json({ error: (await readerWords("backups"))("errors.notFound") }, { status: 404 });
    return Response.json(detail);
}
