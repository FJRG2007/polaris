/**
 * The Calendar app as the dashboard sees it: the work it runs on a schedule.
 *
 * Every job imports its service when it runs, not when this module loads: the
 * extension is loaded with the registry, and a static import chain from here
 * reaches the session and the database before anybody asked for a calendar.
 */

import type { AppHostTypes } from "@polaris/app-host";

type AppExtension = AppHostTypes["AppExtension"];

const SECOND = 1000;
const MINUTE = 60 * SECOND;

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
            key: "calendar-clock",
            // The Time area's alarms and timers ring through here when no tab
            // is open to ring them, so it runs on the scheduler's quick tick:
            // a timer heard a minute late is a timer that failed.
            everyMs: 15 * SECOND,
            // Not leased: each ring is claimed by a write conditional on the
            // instant it was due, so a second runner finds it already moved on
            // and says nothing - and a lease taken four times a minute would
            // cost more than the pass it guards.
            leaseMs: null,
            run: async () => (await import("./clock/service")).fireDueClocks()
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

    // The running timers and stopwatch beside the bell, and the ring of an
    // alarm or a timer in whatever screen is open. Drawn by the app's slot
    // component, which reads its own data.
    headerSlot: () => ({ app: "calendar", kind: "header-time", props: {} }),

    upcomingEvents: async (userId, limit) =>
        (await import("./upcoming")).upcomingEvents(userId, limit),

    eventTitles: async (userId, ids) => (await import("./event-titles")).eventTitles(userId, ids),

    // What a connected assistant may do with the calendar: read it, and - on
    // the scope that says so - change it, by the app's own rules.
    mcpTools: async () => (await import("./mcp-tools")).calendarMcpTools(),

    // What a person reads for each of those tools, in their language.
    mcpToolLabels: async (locale) =>
        (await import("../../messages")).calendarCatalogs.catalogs[locale].mcpTools,

    // How `polaris_search` finds its calendars and events, by the same rules.
    mcpSearch: async () => (await import("./mcp-tools")).calendarMcpSearch()
};
