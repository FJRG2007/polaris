/**
 * An update must not empty every room in the deployment.
 *
 * A seat is swept when its browser stops saying it is there, which is right: a
 * closed laptop should not sit in a call forever. But a browser goes quiet for
 * exactly two reasons, and only one of them is about the browser. When this
 * process is rolled over - an update, a reboot, a replaced container - every
 * browser in every call goes quiet for as long as the gap, because there is
 * nothing listening.
 *
 * Swept on the first request afterwards, that silence ends every live call at
 * once: the rooms are emptied, `endIfEmpty` closes the calls that were in them,
 * and what each person sees is their call dropping seconds after an update they
 * were told was seamless.
 *
 * So a freshly started process gives the rooms the same window it gives a
 * browser. What is asserted here is both halves: that it holds off while it is
 * new, and that it does eventually let go of somebody who really did leave -
 * a grace that never ended would be a roster full of people who are not there.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Swept {
    lastSeenBefore: Date;
}

let swept: Swept[] = [];

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/blocks", () => ({ blockersOf: async () => new Set<string>() }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => null,
    getIntegrationSecret: async () => null
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/meeting-events", () => ({ publishMeetingEvent: () => undefined }));

vi.mock("@polaris/db", () => ({
    prisma: {
        meeting: {
            findUnique: async () => ({
                id: "m1",
                channelId: "c1",
                endedAt: null,
                title: "",
                startedAt: new Date(),
                scheduledAt: null
            }),
            findFirst: async () => null,
            findMany: async () => [],
            updateMany: async () => ({ count: 0 })
        },
        meetingParticipant: {
            // The sweep, and the only call under test. A heartbeat writes
            // `lastSeenAt` through this same method and is told apart by having
            // no `lt` on it: one is a browser saying it is there, the other is
            // the room deciding somebody is not.
            updateMany: async ({ where }: { where: { lastSeenAt?: { lt?: Date } } }) => {
                if (where.lastSeenAt?.lt) swept.push({ lastSeenBefore: where.lastSeenAt.lt });
                return { count: 0 };
            },
            // The seat the request holds. Waiting rather than admitted, which
            // keeps the reply narrow: what is being tested is the sweep on the
            // way in, not what the room hands back afterwards.
            findFirst: async () => ({
                id: "p1",
                userId: "ada",
                name: "Ada",
                admission: "waiting",
                joinedAt: new Date()
            }),
            findMany: async () => [],
            count: async () => 1,
            create: async () => ({ id: "p1", admission: "admitted" }),
            update: async () => ({ id: "p1" })
        },
        $transaction: async () => undefined
    }
}));

/** The window a browser is given before its silence is believed, read from the
 *  module so shortening it stays one change. */
const { PARTICIPANT_TTL_MS, voicePresence, readMeeting } = await import("@/lib/chat/meetings");

/** What a browser does the moment it reaches the server again: read the call it
 *  believes it is in. It is the request that carries the sweep, and so the one
 *  an update's first moment back actually runs. */
const reconnect = () => readMeeting({ meetingId: "m1", participantId: "p1" });

beforeEach(() => {
    swept = [];
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
});

describe("a process that has just started", () => {
    it("does not sweep the rooms it was not there to hear", async () => {
        await reconnect();

        expect(swept).toEqual([]);
    });

    it("lets go of a seat once it has been listening long enough", async () => {
        // Past the window: this process has now had a fair chance to hear from
        // everybody who is still there, so silence means what it usually means.
        vi.advanceTimersByTime(PARTICIPANT_TTL_MS + 1000);
        await reconnect();

        expect(swept).toHaveLength(1);
    });

    it("still answers who is in a voice room while it is new", async () => {
        // The grace is about writing people out of rooms, not about reading
        // them: the rail must not go blank for half a minute after an update.
        const rooms = await voicePresence(["c1"]);

        expect(rooms).toBeInstanceOf(Map);
    });
});
