/**
 * The current user's notifications for the header bell: the most recent items and
 * the unread count. Session-scoped, so a user only ever sees their own. Node
 * runtime for Prisma.
 */

import { requireUser } from "@/lib/session";
import { listNotifications } from "@/lib/notification-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await requireUser();
    const { notifications, unread } = await listNotifications(user.id);
    return Response.json({ notifications, unread });
}
