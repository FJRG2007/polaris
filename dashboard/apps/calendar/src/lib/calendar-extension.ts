/**
 * The Calendar app as the dashboard sees it: the work it runs on a schedule.
 *
 * Every job imports its service when it runs, not when this module loads: the
 * extension is loaded with the registry, and a static import chain from here
 * reaches the session and the database before anybody asked for a calendar.
 */

import type { AppHostTypes } from "@polaris/app-host";

type AppExtension = AppHostTypes["AppExtension"];

const MINUTE = 60 * 1000;

export const calendarExtension: AppExtension = {
    id: "calendar",

    jobs: () => [
        {
            key: "calendar-sync",
            // A minute between passes; each pass only pulls the sources whose
            // own refresh interval has come round, and pushes the local changes
            // a provider did not take the first time.
            everyMs: MINUTE,
            // Leased: two passes would each pull the same account and push the
            // same pending change twice, which is a duplicated meeting in
            // somebody's Google calendar.
            leaseMs: 10 * MINUTE,
            run: async () => (await import("./sync-engine")).syncDueSources()
        },
        {
            key: "calendar-reminders",
            everyMs: MINUTE,
            // Leased: two passes would each send the same reminder.
            leaseMs: 5 * MINUTE,
            run: async () => (await import("./reminders")).fireDueReminders()
        },
        {
            key: "calendar-housekeeping",
            // Hourly: the trash and the booking pages age by days, not minutes.
            everyMs: 60 * MINUTE,
            // Leased: two passes would each purge the same trash and the loser
            // would fail on rows the other already removed.
            leaseMs: 2 * 60 * MINUTE,
            run: async () => (await import("./housekeeping")).sweepCalendarHousekeeping()
        }
    ],

    upcomingEvents: async (userId, limit) => (await import("./upcoming")).upcomingEvents(userId, limit),

    eventTitles: async (userId, ids) => (await import("./event-titles")).eventTitles(userId, ids)
};
