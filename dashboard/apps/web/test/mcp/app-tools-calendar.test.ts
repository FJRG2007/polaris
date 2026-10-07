/**
 * Calendar's MCP tools, called the way an MCP client calls them.
 *
 * Calendar's own services are tested on their own (test/calendar); what is
 * pinned here is the boundary. A connection approved under the old
 * `calendar.use` scope keeps its upcoming events; reading does not open
 * changing; a change is made as the person, through the editor's own save,
 * with the times read the way the editor reads them; and a calendar shared
 * read-only stays read-only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    actingUser: vi.fn(),
    readerView: vi.fn(),
    upcomingEvents: vi.fn(),
    listCalendars: vi.fn(),
    saveEvent: vi.fn(),
    deleteEvent: vi.fn(),
    occurrencesIn: vi.fn(),
    eventDetail: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/mcp/acting-user", () => ({ actingUser: mocks.actingUser }));
vi.mock("@/lib/i18n/request", () => ({ getLocale: async () => "en-US" }));
vi.mock("@polaris-app/calendar/src/lib/upcoming", () => ({
    readerView: mocks.readerView,
    upcomingEvents: mocks.upcomingEvents
}));
vi.mock("@polaris-app/calendar/src/lib/calendars", () => ({ listCalendars: mocks.listCalendars }));
vi.mock("@polaris-app/calendar/src/lib/objects", () => ({
    saveEvent: mocks.saveEvent,
    deleteEvent: mocks.deleteEvent
}));
vi.mock("@polaris-app/calendar/src/lib/occurrences", () => ({
    addressesOf: async () => ["ada@example.test"],
    occurrencesIn: mocks.occurrencesIn
}));
vi.mock("@polaris-app/calendar/src/lib/event-detail", () => ({ eventDetail: mocks.eventDetail }));

const { calendarExtension } = await import("@polaris-app/calendar/src/lib/calendar-extension");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

const TOOLS = [...(await calendarExtension.mcpTools!())];
const SERVER = { name: "polaris", version: "1", instructions: "" };
const CALENDAR = "11111111-1111-4111-8111-111111111111";
const EVENT = "22222222-2222-4222-8222-222222222222";
const ADA = { id: "user-1", email: "ada@example.test", name: "Ada", isAdmin: false, sessionId: "" };

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

async function call(name: string, args: Record<string, unknown>, scopes: string[]) {
    const reply = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        TOOLS,
        { userId: "user-1", isAdmin: false, scopes: scopes as never, grantId: "grant-1" },
        SERVER
    );
    return (reply?.result ?? reply?.error) as ToolResult & { message?: string };
}

function calendar(writable: boolean) {
    return {
        id: CALENDAR,
        name: "Home",
        writable,
        hidden: false,
        timezone: "Europe/Madrid",
        owner: null,
        defaultAlarms: { timed: [-15], allDay: [] }
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.actingUser.mockResolvedValue(ADA);
    mocks.readerView.mockResolvedValue({
        user: ADA,
        zone: "Europe/Madrid",
        shown: [{ id: CALENDAR, color: "#fff" }],
        preferences: { defaultAlarms: { timed: [-10], allDay: [-900] } }
    });
    mocks.listCalendars.mockResolvedValue([calendar(true)]);
    mocks.saveEvent.mockResolvedValue({ objectId: EVENT });
});

describe("the calendar tools", () => {
    it("answer upcoming events to a connection approved under calendar.use", async () => {
        mocks.upcomingEvents.mockResolvedValue([
            {
                id: EVENT,
                title: "Standup",
                start: "2026-10-05T09:00:00.000Z",
                allDay: false,
                color: "#fff",
                href: "/calendar/e"
            }
        ]);
        for (const scopes of [["calendar.use"], ["calendar.read"]]) {
            const result = await call("calendar_upcoming", { limit: 5 }, scopes);
            expect(result.structuredContent).toEqual({
                events: [
                    {
                        id: EVENT,
                        title: "Standup",
                        start: "2026-10-05T09:00:00.000Z",
                        allDay: false
                    }
                ]
            });
        }
        expect(mocks.upcomingEvents).toHaveBeenCalledWith("user-1", 5);
    });

    it("never let the old scope, or reading, change anything", async () => {
        const args = {
            calendarId: CALENDAR,
            title: "Dentist",
            start: "2026-10-07T10:00",
            end: "2026-10-07T11:00"
        };
        for (const scopes of [["calendar.use"], ["calendar.read"]]) {
            const result = await call("calendar_create", args, scopes);
            expect(result.isError).toBe(true);
            expect(result.content[0]?.text).toContain("calendar.manage");
        }
        expect(
            (
                await call("calendar_events", { from: "2026-10-01", to: "2026-10-02" }, [
                    "calendar.use"
                ])
            ).isError
        ).toBe(true);
        expect(mocks.saveEvent).not.toHaveBeenCalled();
    });

    it("create a timed event through the editor's save, as the person, with the calendar's reminders", async () => {
        const result = await call(
            "calendar_create",
            {
                calendarId: CALENDAR,
                title: "Dentist",
                start: "2026-10-07T10:00",
                end: "2026-10-07T11:00",
                location: "Main St"
            },
            ["calendar.manage"]
        );
        expect(result.isError).toBeUndefined();
        expect(mocks.saveEvent).toHaveBeenCalledTimes(1);
        const [user, input] = mocks.saveEvent.mock.calls[0]!;
        expect(user).toBe(ADA);
        expect(input).toMatchObject({
            objectId: null,
            scope: "all",
            floatingZone: "Europe/Madrid"
        });
        expect(input.event).toMatchObject({
            calendarId: CALENDAR,
            summary: "Dentist",
            location: "Main St",
            allDay: false,
            start: { dateTime: "2026-10-07T10:00:00", tzid: "Europe/Madrid" },
            end: { dateTime: "2026-10-07T11:00:00", tzid: "Europe/Madrid" },
            alarms: [
                expect.objectContaining({ trigger: expect.objectContaining({ minutes: -15 }) })
            ]
        });
    });

    it("create an all-day event whose end is the last day it covers", async () => {
        await call(
            "calendar_create",
            { calendarId: CALENDAR, title: "Trip", start: "2026-10-10", end: "2026-10-12" },
            ["calendar.manage"]
        );
        const [, input] = mocks.saveEvent.mock.calls[0]!;
        expect(input.event).toMatchObject({
            allDay: true,
            start: { date: "2026-10-10" },
            end: { date: "2026-10-13" }
        });
    });

    it("set the reminders asked for, in minutes before, in place of the calendar's", async () => {
        const args = {
            calendarId: CALENDAR,
            title: "Flight",
            start: "2026-10-07T10:00",
            end: "2026-10-07T12:00"
        };
        await call("calendar_create", { ...args, reminders: [60, 10] }, ["calendar.manage"]);
        await call("calendar_create", { ...args, reminders: [] }, ["calendar.manage"]);
        const [asked, none] = mocks.saveEvent.mock.calls.map(([, input]) => input.event.alarms);
        expect(asked.map((alarm: any) => alarm.trigger.minutes)).toEqual([-60, -10]);
        expect(none).toEqual([]);
        const tooFar = await call("calendar_create", { ...args, reminders: [60 * 24 * 40] }, [
            "calendar.manage"
        ]);
        expect(tooFar.message ?? tooFar.content?.[0]?.text).toContain("reminders");
    });

    it("refuse a calendar the person may only read, and an end before the start", async () => {
        mocks.listCalendars.mockResolvedValue([calendar(false)]);
        const shared = await call(
            "calendar_create",
            {
                calendarId: CALENDAR,
                title: "X",
                start: "2026-10-07T10:00",
                end: "2026-10-07T11:00"
            },
            ["calendar.manage"]
        );
        expect(shared.content[0]?.text).toBe("This account cannot add events to that calendar.");

        mocks.listCalendars.mockResolvedValue([calendar(true)]);
        const backwards = await call(
            "calendar_create",
            {
                calendarId: CALENDAR,
                title: "X",
                start: "2026-10-07T11:00",
                end: "2026-10-07T10:00"
            },
            ["calendar.manage"]
        );
        expect(backwards.isError).toBe(true);
        const mixed = await call(
            "calendar_create",
            { calendarId: CALENDAR, title: "X", start: "2026-10-07", end: "2026-10-07T10:00" },
            ["calendar.manage"]
        );
        expect(mixed.content[0]?.text).toContain("same way");
        expect(mocks.saveEvent).not.toHaveBeenCalled();
    });

    it("read a range of the calendars the person shows, and refuse a range too wide", async () => {
        mocks.occurrencesIn.mockResolvedValue({
            occurrences: [
                {
                    objectId: EVENT,
                    recurrenceKey: "20261007T080000Z",
                    recurring: true,
                    calendarId: CALENDAR,
                    summary: "Standup",
                    busyOnly: false,
                    start: "2026-10-07T08:00:00.000Z",
                    end: "2026-10-07T08:15:00.000Z",
                    allDay: false,
                    startDate: null,
                    endDate: null,
                    location: "",
                    status: null,
                    editable: true
                }
            ],
            truncated: false
        });
        const result = await call("calendar_events", { from: "2026-10-05", to: "2026-10-11" }, [
            "calendar.read"
        ]);
        expect(mocks.occurrencesIn).toHaveBeenCalledWith(
            ADA,
            {
                from: new Date("2026-10-04T22:00:00.000Z"),
                to: new Date("2026-10-11T22:00:00.000Z")
            },
            expect.objectContaining({ calendarIds: [CALENDAR], floatingZone: "Europe/Madrid" })
        );
        expect(result.structuredContent.events[0]).toMatchObject({
            objectId: EVENT,
            recurrenceKey: "20261007T080000Z",
            title: "Standup"
        });
        const wide = await call("calendar_events", { from: "2026-01-01", to: "2026-06-01" }, [
            "calendar.read"
        ]);
        expect(wide.content[0]?.text).toContain("at most 62 days");
    });

    it("refuse to change an event the person may not edit", async () => {
        mocks.eventDetail.mockResolvedValue({ writable: false });
        const result = await call("calendar_update", { objectId: EVENT, title: "New" }, [
            "calendar.manage"
        ]);
        expect(result.content[0]?.text).toBe("This account cannot change that event.");
        expect(mocks.saveEvent).not.toHaveBeenCalled();
    });

    it("delete the whole event, or the one occurrence it was told", async () => {
        await call("calendar_delete", { objectId: EVENT }, ["calendar.manage"]);
        await call("calendar_delete", { objectId: EVENT, recurrenceKey: "20261007T080000Z" }, [
            "calendar.manage"
        ]);
        expect(
            mocks.deleteEvent.mock.calls.map(([, input]) => [input.recurrenceKey, input.scope])
        ).toEqual([
            [null, "all"],
            ["20261007T080000Z", "this"]
        ]);
        expect(mocks.deleteEvent.mock.calls[0]![0]).toBe(ADA);
    });

    it("act for nobody when the account cannot be acted for", async () => {
        mocks.actingUser.mockResolvedValue(null);
        const result = await call("calendar_calendars", {}, ["calendar.read"]);
        expect(result.content[0]?.text).toBe("This account cannot use the Calendar.");
        expect(mocks.listCalendars).not.toHaveBeenCalled();
    });
});
