/**
 * Mark the current user's notifications read. With `{ ids: [...] }` only those are
 * marked; with an empty/absent body every unread one is. Scoped to the session so
 * it can never touch another user's notifications. Node runtime for Prisma.
 */

import { requireUser } from "@/lib/session";
import { markNotificationsRead } from "@/lib/notification-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    const user = await requireUser();
    let ids: string[] | undefined;
    try {
        const body = (await request.json()) as { ids?: unknown };
        if (Array.isArray(body.ids)) {
            ids = body.ids.filter((value): value is string => typeof value === "string");
        }
    } catch {
        // No/invalid body: mark everything read.
    }
    await markNotificationsRead(user.id, ids);
    return Response.json({ ok: true });
}
