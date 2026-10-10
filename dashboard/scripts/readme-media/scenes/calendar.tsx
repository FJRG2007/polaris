/** Calendar: a working week, the app's own screen. */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button, PAGE_BLEED, PageHeader } from "@polaris/ui";
import { Chrome } from "../runtime/chrome";
import { defineScene } from "../runtime/scene";
import { calendarPreferences, calendars, clockSnapshot, rangeView } from "../fixtures/calendar";
import { useCalendarT } from "../../../apps/calendar/src/screens/i18n";
import { TimeView } from "../../../apps/calendar/src/screens/clock/time-view";
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

/** The page `/calendar/time` draws: its header is the server's, in the same words. */
function TimePage() {
    const t = useCalendarT();
    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-2">
            <PageHeader
                title={t("time.title")}
                description={t("time.description")}
                actions={
                    <Button asChild size="sm" variant="ghost">
                        <Link href="/calendar">
                            <ArrowLeft />
                            {t("screen.backToCalendar")}
                        </Link>
                    </Button>
                }
            />
            <TimeView />
        </div>
    );
}

/** Calendar's Time area, on the world clock: where the rest of the team is. */
export const calendarTime = defineScene({
    id: "calendar-time",
    path: "/calendar/time?tab=world",
    actions: () => ({
        loadPreferencesAction: () => ({ ok: true, preferences: calendarPreferences() })
    }),
    api: (ctx) => ({ "GET /api/calendar/time": () => clockSnapshot(ctx) }),
    render: () => (
        <Chrome>
            <TimePage />
        </Chrome>
    )
});
