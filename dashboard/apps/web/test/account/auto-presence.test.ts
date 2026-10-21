/**
 * Automatic status: "In a call" and "In a meeting", and do not disturb with
 * them when asked for.
 *
 * The rules that matter are the ones that would quietly stop holding: a status
 * somebody chose always wins, nothing automatic outlives the call or the
 * meeting, an all-day event is not a meeting unless asked, and nobody but the
 * account itself is told what the meeting is.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-10-21T12:00:00Z");
const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);

let person: {
    id: string;
    presence: string;
    presenceUntil: Date | null;
    presenceSetAt: Date | null;
    displayPrefs: string | null;
    deviceTimeZone: string | null;
    autoPresence: string;
    statusText: string;
    statusUntil: Date | null;
};
let lastSeenAt: Date;
/** Live call seats; the query itself drops ones whose heartbeat stopped. */
let seats: { userId: string; meeting: { channelId: string | null } }[];
let events: core.BusyEvent[];
let calendarAsks: number;

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findMany: async () => [person],
            findUnique: async () => person,
            update: async () => person
        },
        sessionState: {
            groupBy: async () => [{ userId: person.id, _max: { lastSeenAt } }]
        },
        meetingParticipant: {
            findMany: async ({ where }: { where: { lastSeenAt: { gt: Date } } }) => {
                // The heartbeat cut-off is part of the query, so a seat is only
                // "on a call" while it is being refreshed.
                expect(where.lastSeenAt.gt.getTime()).toBe(Date.now() - 60_000);
                return seats;
            }
        }
    }
}));
vi.mock("@/lib/privacy-service", () => ({
    allowedBy: async (_viewer: unknown, _field: string, userIds: readonly string[]) =>
        new Set(userIds)
}));
vi.mock("@/lib/chat/access", () => ({ reachableChannelIds: async () => new Set<string>() }));
vi.mock("@/lib/presence-activity/service", () => ({ activitiesFor: async () => new Map() }));
vi.mock("@/lib/chat/meetings", () => ({ PARTICIPANT_TTL_MS: 60_000 }));
vi.mock("@/lib/presence-schedule-service", () => ({
    activeSchedulesFor: async () => new Map(),
    schedulesOf: async () => [],
    scheduleZoneOf: async () => "auto"
}));
vi.mock("@/lib/display-prefs-service", () => ({ getPlatformDisplayPreferences: async () => ({}) }));
vi.mock("@/lib/app-extensions/registry", () => ({
    presenceBusyFor: async (asks: readonly { userId: string }[]) => {
        calendarAsks++;
        return new Map(asks.map((ask) => [ask.userId, events]));
    }
}));

const other = { id: "grace", isAdmin: false };
const self = { id: "ada", isAdmin: false };

function settings(patch: { call?: Partial<core.AutoPresence["call"]>; meeting?: Partial<core.AutoPresence["meeting"]> }) {
    return JSON.stringify({
        call: { ...core.DEFAULT_AUTO_PRESENCE.call, ...patch.call },
        meeting: { ...core.DEFAULT_AUTO_PRESENCE.meeting, ...patch.meeting }
    });
}

beforeEach(async () => {
    vi.setSystemTime(NOW);
    (await import("@/lib/presence-auto-service")).forgetMeetings();
    lastSeenAt = new Date(NOW.getTime() - 30_000);
    seats = [];
    events = [];
    calendarAsks = 0;
    person = {
        id: "ada",
        presence: "auto",
        presenceUntil: null,
        presenceSetAt: null,
        displayPrefs: null,
        deviceTimeZone: "UTC",
        autoPresence: "",
        statusText: "",
        statusUntil: null
    };
});

describe("the stored setting", () => {
    it("reads as the defaults when empty or unreadable", () => {
        expect(core.parseAutoPresence("")).toEqual(core.DEFAULT_AUTO_PRESENCE);
        expect(core.parseAutoPresence("{not json")).toEqual(core.DEFAULT_AUTO_PRESENCE);
        expect(core.parseAutoPresence(null)).toEqual(core.DEFAULT_AUTO_PRESENCE);
    });

    it("keeps what reads and defaults the part that does not", () => {
        const read = core.parseAutoPresence(
            JSON.stringify({ call: { effect: "busy" }, meeting: { beforeMinutes: 999 } })
        );
        expect(read.call).toEqual({ enabled: true, effect: "busy" });
        expect(read.meeting).toEqual(core.DEFAULT_AUTO_PRESENCE.meeting);
    });

    it("defaults to saying 'In a call' without silencing anything, and leaves the calendar off", () => {
        expect(core.DEFAULT_AUTO_PRESENCE.call).toEqual({ enabled: true, effect: "status" });
        expect(core.DEFAULT_AUTO_PRESENCE.meeting.enabled).toBe(false);
        expect(core.DEFAULT_AUTO_PRESENCE.meeting.allDay).toBe(false);
    });
});

describe("which wins", () => {
    const on = core.parseAutoPresence(settings({ call: { effect: "busy" }, meeting: { enabled: true } }));
    const meeting = { endsAt: minutes(30), title: "Weekly sync" };

    it("a chosen status, always", () => {
        for (const chosen of ["busy", "away", "invisible"]) {
            expect(core.autoPresenceOf(chosen, on, { onCall: true, meeting })).toBeNull();
        }
    });

    it("a call over a meeting, since it is the more immediate", () => {
        expect(core.autoPresenceOf("auto", on, { onCall: true, meeting })).toEqual({
            reason: "call",
            busy: true,
            until: null
        });
    });

    it("the meeting, with when it ends and what it is, once the call is over", () => {
        expect(core.autoPresenceOf("auto", on, { onCall: false, meeting })).toEqual({
            reason: "meeting",
            // Do not disturb is the meeting's default effect once switched on.
            busy: true,
            until: minutes(30).toISOString(),
            title: "Weekly sync"
        });
    });

    it("nothing when switched off", () => {
        const off = core.parseAutoPresence(settings({ call: { enabled: false } }));
        expect(core.autoPresenceOf("auto", off, { onCall: true, meeting })).toBeNull();
    });
});

describe("a busy window", () => {
    const base = { ...core.DEFAULT_AUTO_PRESENCE.meeting, enabled: true };
    const event = (from: number, to: number, title = "Weekly sync", allDay = false) => ({
        start: minutes(from),
        end: minutes(to),
        allDay,
        title
    });

    it("opens at the start and closes at the end, end exclusive", () => {
        expect(core.meetingAt([event(1, 30)], base, NOW).current).toBeNull();
        expect(core.meetingAt([event(1, 30)], base, NOW).nextStartAt).toEqual(minutes(1));
        expect(core.meetingAt([event(0, 30)], base, NOW).current).toEqual({
            endsAt: minutes(30),
            title: "Weekly sync"
        });
        expect(core.meetingAt([event(-30, 0)], base, NOW).current).toBeNull();
    });

    it("widens by the minutes before and after", () => {
        const wide = { ...base, beforeMinutes: 5, afterMinutes: 10 };
        expect(core.meetingAt([event(5, 30)], wide, NOW).current?.endsAt).toEqual(minutes(40));
        expect(core.meetingAt([event(-30, -10)], wide, NOW).current).toBeNull();
        expect(core.meetingAt([event(-30, -9)], wide, NOW).current?.endsAt).toEqual(minutes(1));
        expect(core.meetingAt([event(6, 30)], wide, NOW).nextStartAt).toEqual(minutes(1));
    });

    it("reads back-to-back meetings as one", () => {
        const found = core.meetingAt([event(30, 60, "Second"), event(-10, 30, "First")], base, NOW);
        expect(found.current).toEqual({ endsAt: minutes(60), title: "First" });
    });

    it("leaves all-day events out unless asked", () => {
        const holiday = [event(-720, 720, "Holiday", true)];
        expect(core.meetingAt(holiday, base, NOW).current).toBeNull();
        expect(core.meetingAt(holiday, { ...base, allDay: true }, NOW).current?.title).toBe("Holiday");
    });
});

describe("on a call", () => {
    it("says so to others, and turns on do not disturb when asked", async () => {
        const { presenceFor } = await import("@/lib/presence-service");
        person.autoPresence = settings({ call: { effect: "busy" } });
        seats = [{ userId: "ada", meeting: { channelId: "room" } }];
        const found = (await presenceFor(other, ["ada"])).get("ada");
        expect(found?.status).toBe("busy");
        expect(found?.auto).toEqual({ reason: "call", busy: true, until: null });
        // Not a call this reader can reach, so which one is not said.
        expect(found?.inCall).toBeNull();
    });

    it("only says why by default, leaving the dot alone", async () => {
        const { presenceFor } = await import("@/lib/presence-service");
        seats = [{ userId: "ada", meeting: { channelId: "room" } }];
        const found = (await presenceFor(other, ["ada"])).get("ada");
        expect(found?.status).toBe("online");
        expect(found?.auto?.reason).toBe("call");
    });

    it("clears the moment the seat is gone - left, or its heartbeat stopped", async () => {
        const { presenceFor } = await import("@/lib/presence-service");
        person.autoPresence = settings({ call: { effect: "busy" } });
        seats = [];
        const found = (await presenceFor(other, ["ada"])).get("ada");
        expect(found?.status).toBe("online");
        expect(found?.auto).toBeNull();
    });

    it("never outranks a status somebody chose", async () => {
        const { presenceFor } = await import("@/lib/presence-service");
        person.presence = "away";
        person.autoPresence = settings({ call: { effect: "busy" } });
        seats = [{ userId: "ada", meeting: { channelId: "room" } }];
        const found = (await presenceFor(other, ["ada"])).get("ada");
        expect(found?.status).toBe("idle");
        expect(found?.auto).toBeNull();
    });
});

describe("in a meeting", () => {
    beforeEach(() => {
        person.autoPresence = settings({ meeting: { enabled: true } });
        events = [{ start: minutes(-15), end: minutes(30), allDay: false, title: "Weekly sync" }];
    });

    it("tells others only that it is a meeting", async () => {
        const { presenceFor } = await import("@/lib/presence-service");
        const found = (await presenceFor(other, ["ada"])).get("ada");
        expect(found?.status).toBe("busy");
        expect(found?.auto).toEqual({ reason: "meeting", busy: true, until: null });
        expect(JSON.stringify(found)).not.toContain("Weekly sync");
    });

    it("tells the account itself what and until when", async () => {
        const { presenceFor } = await import("@/lib/presence-service");
        const found = (await presenceFor(self, ["ada"])).get("ada");
        expect(found?.auto).toEqual({
            reason: "meeting",
            busy: true,
            until: minutes(30).toISOString(),
            title: "Weekly sync"
        });
    });

    it("ends with the meeting", async () => {
        const { presenceFor } = await import("@/lib/presence-service");
        await presenceFor(other, ["ada"]);
        vi.setSystemTime(minutes(30));
        lastSeenAt = new Date(minutes(30).getTime() - 30_000);
        const found = (await presenceFor(other, ["ada"])).get("ada");
        expect(found?.status).toBe("online");
        expect(found?.auto).toBeNull();
    });

    it("asks the calendar once per half minute, not on every refresh", async () => {
        const { presenceFor } = await import("@/lib/presence-service");
        await presenceFor(other, ["ada"]);
        await presenceFor(other, ["ada"]);
        expect(calendarAsks).toBe(1);
    });

    it("says nothing for somebody who is not here", async () => {
        const { presenceFor } = await import("@/lib/presence-service");
        lastSeenAt = new Date(NOW.getTime() - 3_600_000);
        const found = (await presenceFor(other, ["ada"])).get("ada");
        expect(found?.status).toBe("offline");
        expect(found?.auto).toBeNull();
        expect(calendarAsks).toBe(0);
    });

    it("does not ask the calendar for an account that left it off", async () => {
        const { presenceFor } = await import("@/lib/presence-service");
        person.autoPresence = "";
        await presenceFor(other, ["ada"]);
        expect(calendarAsks).toBe(0);
    });
});
