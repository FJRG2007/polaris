"use server";

/**
 * Somebody opened a screen a badge points at. Silent both ways: it is a side
 * effect of arriving somewhere, and there is nowhere on the screen a failure
 * would belong - the badge simply stays until the next visit.
 */

import { z } from "zod";
import { backgroundUser } from "@/lib/session";
import { isBadgeScreen } from "@/lib/badge-seen";
import { markScreenSeen } from "@/lib/admin-waiting";

export async function markBadgeSeenAction(screen: unknown): Promise<void> {
    const user = await backgroundUser();
    // Only Management's screens carry such a badge, and only an administrator
    // has one to clear.
    if (!user?.isAdmin) return;
    const parsed = z.string().refine(isBadgeScreen).safeParse(screen);
    if (!parsed.success || !isBadgeScreen(parsed.data)) return;
    await markScreenSeen(user.id, parsed.data).catch(() => undefined);
}
