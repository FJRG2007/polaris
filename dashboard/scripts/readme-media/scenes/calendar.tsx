/** Calendar: a working week, the app's own screen. */

import { PAGE_BLEED } from "@polaris/ui";
import { Chrome } from "../runtime/chrome";
import { defineScene } from "../runtime/scene";
import { calendarPreferences, calendars, rangeView } from "../fixtures/calendar";
import { CalendarScreen } from "../../../apps/calendar/src/screens/calendar-screen";
import { SignedInContactLinks } from "../../../apps/calendar/src/screens/contact-links";

export const calendar = defineScene({
    id: "calendar",
    path: "/calendar",
    actions: (ctx) => ({
        listBookingPagesAction: () => ({ ok: true, pages: [] }),
        linkBaseAction: () => ({ ok: true, base: "https://polaris.example.com" }),
        listProposalsAction: () => ({ ok: true, proposals: [] }),
        unscheduledTasksAction: () => ({ ok: true, tasks: [] }),
        loadPreferencesAction: () => ({ ok: true, preferences: calendarPreferences() }),
        listCalendarsAction: () => ({ ok: true, calendars: calendars(ctx) }),
        refreshOpenSourcesAction: () => ({ ok: true, pulled: 0 }),
        mailComposeAction: () => ({ ok: true, compose: true })
    }),
    api: (ctx) => ({
        "GET /api/calendar/range": ({ url }) =>
            rangeView(ctx, url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "")
    }),
    // The page `/calendar/[[...path]]` draws, its fallback aside: the screen
    // below replaces it as soon as it is ready, which is before the picture.
    render: () => (
        <Chrome>
            <div className={PAGE_BLEED}>
                <SignedInContactLinks>
                    <CalendarScreen path={[]} />
                </SignedInContactLinks>
            </div>
        </Chrome>
    )
});
