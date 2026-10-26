"use server";

/** Closing an announcement banner, for the reader who closed it. */

import { requireUser } from "@/lib/session";
import { dismissBanner } from "@/lib/announcements/service";
import { announcementIdSchema } from "@/lib/announcements/schema";

export async function dismissAnnouncementAction(id: string): Promise<{ ok: boolean }> {
    const user = await requireUser();
    // Somebody viewing as another account does not close that account's banners.
    if (user.viewingAs) return { ok: false };
    if (!announcementIdSchema.safeParse(id).success) return { ok: false };
    return { ok: await dismissBanner(user.id, id) };
}
