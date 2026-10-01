/**
 * The reads the booking screens share, through the calendar's kept-answer
 * cache so coming back to a list paints it before the request leaves.
 */

import { useCalendarT } from "../i18n";
import { listCalendarsAction } from "../../actions/calendars";
import { loadInstanceSettingsAction } from "../../actions/instance";
import { cacheKey, dropCached, unwrap, useCachedRead } from "../cached-read";
import { linkBaseAction, listBookingPagesAction } from "../../actions/booking";

/** The configured address links are built on. It changes with the domain
 *  setting and nothing else, so it is kept for an hour. */
export function useLinkBase(): string | null {
    const t = useCalendarT();
    const read = useCachedRead(
        cacheKey("link-base"),
        async () => (await unwrap(() => linkBaseAction(), t("errors.generic"))).base,
        { freshMs: 3_600_000 }
    );
    return read.data;
}

export function useBookingPages() {
    const t = useCalendarT();
    return useCachedRead(
        cacheKey("booking-pages"),
        async () => (await unwrap(() => listBookingPagesAction(), t("errors.generic"))).pages
    );
}

export function useCalendarList() {
    const t = useCalendarT();
    return useCachedRead(
        cacheKey("booking-calendars"),
        async () => (await unwrap(() => listCalendarsAction(), t("errors.generic"))).calendars
    );
}

/** Whether the operator lets people run booking pages here, and whether this
 *  reader is the one who could switch it on. Null while it is being read. */
export function useBookingSwitch(): { allowed: boolean; canManage: boolean } | null {
    const t = useCalendarT();
    const read = useCachedRead(cacheKey("booking-switch"), async () => {
        const answer = await unwrap(() => loadInstanceSettingsAction(), t("errors.generic"));
        return { allowed: answer.settings.allowBooking, canManage: answer.canManage };
    });
    return read.data;
}

/** Forget the kept list after a change made somewhere else. */
export function forgetBookingPages(): void {
    dropCached("booking-pages");
}

/** A page's public address. */
export function bookingUrl(base: string, slug: string): string {
    return `${base.replace(/\/+$/, "")}/cal/book/${slug}`;
}
