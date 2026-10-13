/**
 * A seat let go of for going quiet is announced, like one handed back.
 *
 * Hanging up tells the conversation and the call that somebody left. A browser
 * that went away without hanging up is only noticed by the sweep, and the sweep
 * told nobody: the rows changed and every screen that had drawn the person - the
 * call's own roster, the faces outside it, the rail under a voice room - went on
 * drawing them until it was reloaded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const told = vi.hoisted(() => ({
    chat: [] as { kind: string; call?: { state: string; count: number } }[],
    room: [] as { meetingId: string; kind: string }[],
    swept: 0,
    present: 1
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/blocks", () => ({ blockersOf: async () => new Set<string>() }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => null,
    getIntegrationSecret: async () => null
}));
vi.mock("@/lib/chat/live", () => ({
    publishChatChange: (change: (typeof told.chat)[number]) => void told.chat.push(change)
}));
vi.mock("@/lib/chat/meeting-events", () => ({
    publishMeetingEvent: (event: (typeof told.room)[number]) => void told.room.push(event)
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        meeting: {
            findUnique: async () => ({ channelId: "c1" }),
            findFirst: async () => ({ id: "m1" }),
            updateMany: async () => ({ count: 0 })
        },
        meetingParticipant: {
            // The sweep: a write with an `lt` on `lastSeenAt` is the room
            // deciding somebody is gone.
            updateMany: async ({ where }: { where: { lastSeenAt?: { lt?: Date } } }) => ({
                count: where.lastSeenAt?.lt ? told.swept : 0
            }),
            findMany: async () =>
                Array.from({ length: told.present }, (_, index) => ({
                    id: `seat-${index}`,
                    name: `Fixture Person ${index}`,
                    userId: `user-${index}`,
                    muted: false,
                    deafened: false,
                    streaming: false,
                    serverMuted: false,
                    serverDeafened: false
                })),
            count: async () => told.present
        }
    }
}));

const { PARTICIPANT_TTL_MS, liveIn } = await import("@/lib/chat/meetings");

beforeEach(() => {
    told.chat = [];
    told.room = [];
    told.swept = 0;
    told.present = 1;
    // Past the window a freshly started process holds off for.
    vi.useFakeTimers();
    vi.advanceTimersByTime(PARTICIPANT_TTL_MS + 1000);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("a seat swept for going quiet", () => {
    it("tells the conversation and the call", async () => {
        told.swept = 1;

        const live = await liveIn("c1");

        expect(live?.count).toBe(1);
        expect(told.room).toContainEqual({ meetingId: "m1", kind: "roster" });
        expect(told.chat).toContainEqual(
            expect.objectContaining({
                kind: "call",
                channelId: "c1",
                call: expect.objectContaining({ meetingId: "m1", state: "moved", count: 1 })
            })
        );
    });

    it("says nothing when nobody was swept", async () => {
        await liveIn("c1");

        expect(told.room).toEqual([]);
        expect(told.chat).toEqual([]);
    });
});
