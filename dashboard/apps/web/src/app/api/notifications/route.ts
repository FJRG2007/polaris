/**
 * Notifications feed for the bell. Returns the current user's recent
 * notifications and their unread count; the bell polls it. Node runtime for
 * Prisma. Always scoped to the session user.
 */

import { requireUser } from "@/lib/session";
import { countUnread, listNotifications } from "@/lib/notification-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await requireUser();
    const [items, unread] = await Promise.all([listNotifications(user.id, 20), countUnread(user.id)]);
    return Response.json({ unread, items });
}
