/**
 * One account, one seat, one device on the line.
 *
 * A second device rejoining reuses the same participant row, because a person is
 * one person in a room. That was already true and it left both browsers holding
 * a microphone with nothing anywhere saying which was live - so signing in on a
 * phone mid-call did nothing visible and taking the call over did nothing
 * visible either.
 *
 * What is asserted here is the question the phone asks on the way in. The
 * freshness test is the one that matters: a seat is left behind by any browser
 * closed rather than hung up, and offering to move a call that ended an hour ago
 * is worse than offering nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface ParticipantRow {
    id: string;
    meetingId: string;
    userId: string | null;
    admission: string;
    leftAt: Date | null;
    lastSeenAt: Date;
}

let participants: ParticipantRow[] = [];
let meetingEnded: Date | null = null;
let channel: { kind: string; name: string; spaceId: string | null; members: { name: string }[] } = {
    kind: "dm",
    name: "",
    spaceId: null,
    members: [{ name: "Grace" }]
};
const published: unknown[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        meetingParticipant: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) => {
                const fresh = (where.lastSeenAt as { gte: Date } | undefined)?.gte;
                const row = participants.find(
                    (entry) =>
                        entry.userId === where.userId &&
                        entry.admission === "admitted" &&
                        entry.leftAt === null &&
                        (!fresh || entry.lastSeenAt >= fresh) &&
                        meetingEnded === null
                );
                if (!row) return null;
                return {
                    id: row.id,
                    meetingId: row.meetingId,
                    meeting: {
                        channelId: "c1",
                        channel: {
                            kind: channel.kind,
                            name: channel.name,
                            spaceId: channel.spaceId,
                            members: channel.members.map((member) => ({
                                user: { name: member.name }
                            }))
                        }
                    }
                };
            },
            updateMany: async () => ({ count: 0 }),
            findMany: async () => [],
            count: async () => 0
        },
        meeting: { findUnique: async () => null, update: async () => ({}) },
        chatChannel: { findUnique: async () => null }
    }
}));

vi.mock("@/lib/chat/access", () => ({
    requireChannel: async () => ({ id: "c1", kind: "dm" }),
    ChatAccessError: class extends Error {},
    ChatRuleError: class extends Error {}
}));

vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));

vi.mock("@/lib/chat/meeting-events", () => ({
    publishMeetingEvent: (event: unknown) => {
        published.push(event);
    },
    holdSignal: () => undefined,
    takeHeldSignals: () => [],
    subscribeMeetingEvents: () => () => undefined,
    subscribeSignals: () => () => undefined,
    publishSignal: () => undefined,
    MAX_SIGNAL_BYTES: 65_536
}));

const meetings = await import("../../src/lib/chat/meetings");

/** A seat that checked in this long ago. */
function seat(agoMs: number): void {
    participants = [
        {
            id: "p-desk",
            meetingId: "m1",
            userId: "ada",
            admission: "admitted",
            leftAt: null,
            lastSeenAt: new Date(Date.now() - agoMs)
        }
    ];
}

beforeEach(() => {
    participants = [];
    meetingEnded = null;
    published.length = 0;
    channel = { kind: "dm", name: "", spaceId: null, members: [{ name: "Grace" }] };
});

describe("a call this account is in somewhere else", () => {
    it("is found while the other device is still checking in", async () => {
        seat(5_000);
        const found = await meetings.callElsewhere("ada");

        expect(found?.meetingId).toBe("m1");
        expect(found?.channelId).toBe("c1");
        expect(found?.participantId).toBe("p-desk");
    });

    it("is not offered once the other device has stopped answering", async () => {
        // A browser closed rather than hung up leaves this behind. Offering to
        // move a call nobody is in is worse than offering nothing.
        seat(meetings.PARTICIPANT_TTL_MS + 1_000);

        expect(await meetings.callElsewhere("ada")).toBeNull();
    });

    it("is not offered for somebody else's seat", async () => {
        seat(5_000);

        expect(await meetings.callElsewhere("grace")).toBeNull();
    });

    it("is not offered once the call has ended", async () => {
        seat(5_000);
        meetingEnded = new Date();

        expect(await meetings.callElsewhere("ada")).toBeNull();
    });

    it("is named after the other person in a one-to-one", async () => {
        seat(5_000);

        // A direct message has no name of its own, and the card is drawn on a
        // device with no conversation on screen to read one off.
        expect((await meetings.callElsewhere("ada"))?.title).toBe("Grace");
    });

    it("is named after the channel in a space", async () => {
        seat(5_000);
        channel = { kind: "text", name: "standup", spaceId: "s1", members: [] };

        expect((await meetings.callElsewhere("ada"))?.title).toBe("#standup");
    });
});

describe("taking the call over", () => {
    it("says which seat was claimed as well as which browser has it", () => {
        meetings.claimCall("m1", "p-desk", "device-phone");

        // The seat is what makes the claim deliverable to the browsers it is
        // about. Without it the stream had no way to tell "another of your
        // devices took your seat" from "somebody else joined the call", and it
        // told everybody the second thing was the first.
        expect(published).toEqual([
            { meetingId: "m1", kind: "claimed", participantId: "p-desk", deviceId: "device-phone" }
        ]);
    });
});
