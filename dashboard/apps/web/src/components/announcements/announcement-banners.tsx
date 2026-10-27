/**
 * The shell's announcement slot: what is showing for this reader now, read with
 * the page so the stack is there on the first paint instead of pushing the
 * screen down a moment later. One indexed read when nothing is up, which is
 * nearly always. A failure draws nothing rather than failing the frame.
 *
 * Always mounts the list, even empty, because the list is what listens for an
 * announcement published while the tab is open.
 */

import { getLocale } from "@/lib/i18n/request";
import type { SessionUser } from "@/lib/session";
import { Messages } from "@/components/i18n/messages";
import { bannerStateFor, type BannerState } from "@/lib/announcements/service";
import { AnnouncementBannerList } from "./announcement-banner-list";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";

export async function AnnouncementBanners({ user }: { user: SessionUser }) {
    const locale = await getLocale();
    const state = await resolveDisplayPreferencesFor(user.id, locale)
        .then((prefs) => bannerStateFor(user.id, { locale, timeZone: prefs.timeZone }))
        .catch((): BannerState => ({ banners: [], nextChangeInMs: null }));
    return (
        <Messages namespaces={["announcements"]}>
            <AnnouncementBannerList initial={state} locale={locale} />
        </Messages>
    );
}
