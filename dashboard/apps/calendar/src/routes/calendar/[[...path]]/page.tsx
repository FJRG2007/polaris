/**
 * The calendar: `/calendar`, `/calendar/<view>/<date>` and `/calendar/e/<id>`.
 *
 * The server hands over the frame and nothing else - no calendar, setting or
 * event is read here. The screen reads them in the browser, painting what it
 * kept from the last visit first, so the header and the grid's outline are on
 * screen before any request has left.
 */

import { PAGE_BLEED } from "@polaris/ui";
import { calendarT } from "../../../lib/i18n";
import { requireCalendarUser } from "../../../lib/access";
import { CalendarShell } from "../../../screens/shell";
import { CalendarScreen } from "../../../screens/calendar-screen";

export const dynamic = "force-dynamic";

export default async function CalendarPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    await requireCalendarUser();
    const t = await calendarT();
    const raw = (await params).path;
    const path = Array.isArray(raw) ? raw : raw ? [raw] : [];

    return (
        <div className={`${PAGE_BLEED} [&:has([data-cal-ready])>[data-cal-fallback]]:hidden`}>
            <div data-cal-fallback className="h-full">
                <CalendarShell
                    words={{
                        today: t("header.today"),
                        newEvent: t("header.newEvent"),
                        loading: t("grid.loading")
                    }}
                />
            </div>
            <CalendarScreen path={path} />
        </div>
    );
}
