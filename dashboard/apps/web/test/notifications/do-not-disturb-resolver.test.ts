/**
 * Whether an account is in do not disturb, as the server works it out for the
 * paths that sound: a chosen status, a schedule or automatic status, through
 * the same resolver that draws the account's dot.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let row: {
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
let seats: { userId: string; meeting: { channelId: string } }[];

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findMany: async () => [row],
            findUnique: async () => row,
            update: async () => row
        },
        sessionState: {
            groupBy: async () => [{ userId: row.id, _max: { lastSeenAt: new Date() } }]
        },
        meetingParticipant: { findMany: async () => seats }
    }
}));
vi.mock("@/lib/privacy-service", () => ({ allowedBy: async () => new Set<string>() }));
vi.mock("@/lib/chat/access", () => ({ reachableChannelIds: async () => new Set<string>() }));
vi.mock("@/lib/presence-activity/service", () => ({ activitiesFor: async () => new Map() }));
vi.mock("@/lib/chat/meetings", () => ({ PARTICIPANT_TTL_MS: 60_000 }));
vi.mock("@/lib/presence-schedule-service", () => ({
    activeSchedulesFor: async () => new Map(),
    schedulesOf: async () => [],
    scheduleZoneOf: async () => "auto"
}));
vi.mock("@/lib/display-prefs-service", () => ({ getPlatformDisplayPreferences: async () => ({}) }));

beforeEach(() => {
    seats = [];
    row = {
        id: "ada",
        presence: "auto",
        presenceUntil: null,
        presenceSetAt: null,
        displayPrefs: null,
        deviceTimeZone: null,
        autoPresence: "",
        statusText: "",
        statusUntil: null
    };
});

describe("do not disturb, worked out on the server", () => {
    it("is off for somebody whose dot is not busy", async () => {
        const { doNotDisturbOf } = await import("@/lib/presence-service");
        expect(await doNotDisturbOf("ada")).toEqual({ on: false, reason: null, until: null });
    });

    it("is on by hand, with when it ends", async () => {
        const { doNotDisturbOf } = await import("@/lib/presence-service");
        const until = new Date(Date.now() + 3_600_000);
        row.presence = "busy";
        row.presenceUntil = until;
        expect(await doNotDisturbOf("ada")).toEqual({
            on: true,
            reason: "chosen",
            until: until.toISOString()
        });
    });

    it("is on because of a call that turns it on, and off once the seat is gone", async () => {
        const { doNotDisturbOf } = await import("@/lib/presence-service");
        row.autoPresence = JSON.stringify({ call: { enabled: true, effect: "busy" } });
        seats = [{ userId: "ada", meeting: { channelId: "room" } }];
        expect(await doNotDisturbOf("ada")).toEqual({ on: true, reason: "call", until: null });
        seats = [];
        expect((await doNotDisturbOf("ada")).on).toBe(false);
    });

    it("is not on for a call that only shows the reason", async () => {
        const { doNotDisturbOf } = await import("@/lib/presence-service");
        seats = [{ userId: "ada", meeting: { channelId: "room" } }];
        expect((await doNotDisturbOf("ada")).on).toBe(false);
    });
});
