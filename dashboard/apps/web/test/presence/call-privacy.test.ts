/**
 * Who can tell somebody is on a call.
 *
 * The mark beside a face that says "in a call" names the conversation the call
 * is in, so it is shown only to a reader who could walk into that conversation
 * too. Somebody outside a group, or outside a private room of a server, must not
 * be able to tell from anybody's face that a call is going on in there - nor that
 * somebody is in a call at all, which is the same answer: they are told nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-10-14T12:00:00Z");

/** The seats taken, each in the conversation of its meeting. */
let seats: { userId: string; meeting: { channelId: string | null } }[];
/** The conversations the reader can open. */
let reachable: Set<string>;

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findMany: async () => [
                {
                    id: "ada",
                    presence: "auto",
                    presenceUntil: null,
                    presenceSetAt: null,
                    displayPrefs: null,
                    deviceTimeZone: null,
                    statusText: "",
                    statusUntil: null
                }
            ]
        },
        sessionState: {
            groupBy: async () => [
                { userId: "ada", _max: { lastSeenAt: new Date(NOW.getTime() - 30_000) } }
            ]
        },
        meetingParticipant: { findMany: async () => seats }
    }
}));

vi.mock("@/lib/privacy-service", () => ({
    allowedBy: async (_viewer: unknown, _field: string, userIds: readonly string[]) =>
        new Set(userIds)
}));
vi.mock("@/lib/chat/access", () => ({ reachableChannelIds: async () => reachable }));
vi.mock("@/lib/chat/meetings", () => ({ PARTICIPANT_TTL_MS: 60_000 }));
vi.mock("@/lib/presence-schedule-service", () => ({
    activeSchedulesFor: async () => new Map(),
    schedulesOf: async () => [],
    scheduleZoneOf: async () => "auto"
}));
vi.mock("@/lib/display-prefs-service", () => ({ getPlatformDisplayPreferences: async () => ({}) }));
vi.mock("@/lib/presence-activity/service", () => ({ activitiesFor: async () => new Map() }));

const { presenceFor } = await import("@/lib/presence-service");
const reader = { id: "grace", isAdmin: false };

beforeEach(() => {
    vi.setSystemTime(NOW);
    seats = [];
    reachable = new Set();
});

describe("being on a call, as somebody else sees it", () => {
    it("is shown to a reader who can open the conversation the call is in", async () => {
        seats = [{ userId: "ada", meeting: { channelId: "group-1" } }];
        reachable = new Set(["group-1"]);
        expect((await presenceFor(reader, ["ada"])).get("ada")?.inCall).toBe("group-1");
    });

    it("is not shown to a reader outside that group or room", async () => {
        seats = [{ userId: "ada", meeting: { channelId: "private-room" } }];
        reachable = new Set(["some-other-room"]);
        expect((await presenceFor(reader, ["ada"])).get("ada")?.inCall).toBeNull();
    });

    it("is not shown for a call that belongs to no conversation", async () => {
        seats = [{ userId: "ada", meeting: { channelId: null } }];
        reachable = new Set(["group-1"]);
        expect((await presenceFor(reader, ["ada"])).get("ada")?.inCall).toBeNull();
    });
});
