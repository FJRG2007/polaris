"use server";

/** The announcement banners, for the reader who sees them. */

import { requireUser } from "@/lib/session";
import { getLocale } from "@/lib/i18n/request";
import { announcementIdSchema } from "@/lib/announcements/schema";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";
import { bannerStateFor, dismissBanner, type BannerState } from "@/lib/announcements/service";

export async function dismissAnnouncementAction(id: string): Promise<{ ok: boolean }> {
    const user = await requireUser();
    // Somebody viewing as another account does not close that account's banners.
    if (user.viewingAs) return { ok: false };
    if (!announcementIdSchema.safeParse(id).success) return { ok: false };
    return { ok: await dismissBanner(user.id, id) };
}

/** What the banner stack shows now, read again when the live channel says it changed. */
export async function announcementBannersAction(): Promise<BannerState> {
    const user = await requireUser();
    const locale = await getLocale();
    const prefs = await resolveDisplayPreferencesFor(user.id, locale);
    return bannerStateFor(user.id, { locale, timeZone: prefs.timeZone });
}
