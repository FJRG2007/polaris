/**
 * The shell's announcement slot: what is showing for this reader now, read with
 * the page so the stack is there on the first paint instead of pushing the
 * screen down a moment later. One indexed read when nothing is up, which is
 * nearly always. A failure draws nothing rather than failing the frame.
 */

import { getLocale } from "@/lib/i18n/request";
import type { SessionUser } from "@/lib/session";
import { Messages } from "@/components/i18n/messages";
import { bannersFor } from "@/lib/announcements/service";
import { AnnouncementBannerList } from "./announcement-banner-list";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";

export async function AnnouncementBanners({ user }: { user: SessionUser }) {
    const locale = await getLocale();
    const banners = await resolveDisplayPreferencesFor(user.id, locale)
        .then((prefs) => bannersFor(user.id, { locale, timeZone: prefs.timeZone }))
        .catch(() => []);
    if (banners.length === 0) return null;
    return (
        <Messages namespaces={["announcements"]}>
            <AnnouncementBannerList banners={banners} locale={locale} />
        </Messages>
    );
}
