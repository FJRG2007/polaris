/**
 * The two rules that separate a meeting from a conversation's call.
 *
 * **A meeting is not over when it is empty.** A call belongs to the people
 * talking, so the last one out turns the lights off. A meeting belongs to
 * whoever created it: the host who arrives early and steps out for a coffee
 * would otherwise take the room with them, and the address they sent last week
 * would stop opening anything. Both halves are asserted, because the fix would
 * be worthless if it also stopped ordinary calls from ending.
 *
 * **Being shown out means something.** Removing somebody marks their seat
 * refused rather than merely emptied, and a rejoin under the same account has to
 * be turned away - otherwise the button does nothing that lasts longer than it
 * takes to press Join again. The lobby is asserted beside it: somebody who was
 * never invited to a meeting that approves people arrives at the door rather
 * than in the room.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface ParticipantRow {
    id: string;
    meetingId: string;
    userId: string | null;
    admission: string;
    leftAt: Date | null;
}

interface MeetingRow {
    id: string;
    channelId: string | null;
    hostId: string;
    endedAt: Date | null;
    approveGuests: boolean;
    invited: string[];
}

let participants: ParticipantRow[] = [];
let meeting: MeetingRow;
let closed: string[] = [];
let created: { userId: string | null; admission: string }[] = [];

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/blocks", () => ({ blockersOf: async () => new Set<string>() }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => null,
    getIntegrationSecret: async () => null
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/meeting-events", () => ({ publishMeetingEvent: () => undefined }));
vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("@/lib/chat/access");
    return { ...actual, requireChannel: async () => undefined };
});

vi.mock("@polaris/db", () => ({
    prisma: {
        meeting: {
            findUnique: async ({ select }: { select?: Record<string, unknown> }) => ({
                id: meeting.id,
                channelId: meeting.channelId,
                hostId: meeting.hostId,
                endedAt: meeting.endedAt,
                approveGuests: meeting.approveGuests,
                requireAccount: false,
                ...(select && "invites" in select
                    ? {
                          invites: meeting.invited.map((userId) => ({ id: `i-${userId}`, userId }))
                      }
                    : {})
            }),
            findFirst: async () => (meeting.endedAt === null ? { id: meeting.id } : null),
            updateMany: async () => {
                closed.push(meeting.id);
                meeting.endedAt = new Date();
                return { count: 1 };
            },
            update: async () => meeting
        },
        meetingParticipant: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                participants.find((row) => {
                    if (where.meetingId && row.meetingId !== where.meetingId) return false;
                    if (where.userId !== undefined && row.userId !== where.userId) return false;
                    if (where.admission && row.admission !== where.admission) return false;
                    if (where.leftAt === null && row.leftAt !== null) return false;
                    return true;
                }) ?? null,
            count: async () =>
                participants.filter((row) => row.leftAt === null && row.admission === "admitted")
                    .length,
            create: async ({ data }: { data: { userId: string | null; admission: string } }) => {
                created.push({ userId: data.userId, admission: data.admission });
                const row = {
                    id: `p${participants.length + 1}`,
                    meetingId: meeting.id,
                    userId: data.userId,
                    admission: data.admission,
                    leftAt: null
                };
                participants.push(row);
                return row;
            },
            update: async () => participants[0],
            updateMany: async ({ where }: { where: { id?: string } }) => {
                for (const row of participants) {
                    if (where.id && row.id !== where.id) continue;
                    row.leftAt = new Date();
                }
                return { count: 1 };
            },
            deleteMany: async () => ({ count: 0 })
        },
        $transaction: async (work: unknown) => {
            closed.push(meeting.id);
            meeting.endedAt = new Date();
            return Array.isArray(work) ? [] : undefined;
        }
    }
}));

const meetings = await import("@/lib/chat/meetings");

beforeEach(() => {
    closed = [];
    created = [];
    participants = [];
    meeting = {
        id: "m1",
        channelId: null,
        hostId: "ada",
        endedAt: null,
        approveGuests: true,
        invited: []
    };
});

describe("the last person out", () => {
    it("leaves a meeting of its own standing", async () => {
        participants = [
            { id: "p1", meetingId: "m1", userId: "ada", admission: "admitted", leftAt: null }
        ];

        await meetings.leave({ meetingId: "m1", participantId: "p1" });

        expect(closed).toEqual([]);
        expect(meeting.endedAt).toBeNull();
    });

    it("still ends a conversation's call", async () => {
        meeting.channelId = "c1";
        participants = [
            { id: "p1", meetingId: "m1", userId: "ada", admission: "admitted", leftAt: null }
        ];

        await meetings.leave({ meetingId: "m1", participantId: "p1" });

        expect(closed).toContain("m1");
    });
});

describe("joining a meeting", () => {
    it("turns away somebody who was removed from it", async () => {
        participants = [
            { id: "p1", meetingId: "m1", userId: "grace", admission: "denied", leftAt: new Date() }
        ];

        await expect(meetings.joinMeeting({ id: "grace", name: "Grace" }, "m1")).rejects.toThrow(
            /removed/i
        );
        expect(created).toEqual([]);
    });

    it("puts somebody who was never invited at the door", async () => {
        const seat = await meetings.joinMeeting({ id: "grace", name: "Grace" }, "m1");

        expect(seat.admission).toBe("waiting");
        expect(created).toEqual([{ userId: "grace", admission: "waiting" }]);
    });

    it("walks the host and anybody convened straight in", async () => {
        meeting.invited = ["grace"];

        const seat = await meetings.joinMeeting({ id: "grace", name: "Grace" }, "m1");

        expect(seat.admission).toBe("admitted");
    });

    it("lets anybody in when the host is not approving people", async () => {
        meeting.approveGuests = false;

        const seat = await meetings.joinMeeting({ id: "grace", name: "Grace" }, "m1");

        expect(seat.admission).toBe("admitted");
    });
});
