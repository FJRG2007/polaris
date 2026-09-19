/**
 * A voice channel's user limit.
 *
 * Refused on the server twice: where the seat is taken, and again where the
 * media server's ticket is signed - the ticket is the only thing that server
 * believes, and two people pressing join in the same instant both pass a count
 * taken before either seat existed. A moderator of the room walks past it, the
 * way every voice client lets them. Zero is no limit, which is every channel
 * that has never been given one.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    userId: string | null;
    joinedAt: Date;
    leftAt: Date | null;
    admission: string;
}

let limit = 0;
let kind = "voice";
let rows: Row[] = [];
let created = 0;
let mayModerate = false;

/** Enough of the `where` the limit asks to answer it. */
function counted(where: Record<string, unknown>): number {
    const not = (where.id as { not?: string } | undefined)?.not;
    const either = where.OR as
        | [{ joinedAt: { lt: Date } }, { joinedAt: Date; id: { lt: string } }]
        | undefined;
    return rows.filter((row) => {
        if (row.leftAt !== null || row.admission !== "admitted") return false;
        if (not && row.id === not) return false;
        if (!either) return true;
        return (
            row.joinedAt < either[0].joinedAt.lt ||
            (row.joinedAt.getTime() === either[1].joinedAt.getTime() && row.id < either[1].id.lt)
        );
    }).length;
}

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));

vi.mock("@/lib/chat/access", async (original) => ({
    ...(await original<typeof import("@/lib/chat/access")>()),
    requireChannel: async () => ({ mayModerate, kind }),
    channelAccess: async () => ({ mayModerate })
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        meeting: {
            findUnique: async () => ({
                channelId: "c1",
                endedAt: null,
                channel: { kind, userLimit: limit, spaceId: "s1" }
            })
        },
        meetingParticipant: {
            count: async ({ where }: { where: Record<string, unknown> }) => counted(where),
            findFirst: async ({ where }: { where: { id?: string; userId?: string } }) => {
                if (where.id) {
                    const row = rows.find((entry) => entry.id === where.id && !entry.leftAt);
                    return row ? { ...row, meeting: { channelId: "c1" } } : null;
                }
                // No seat of their own yet, and nothing carried from an earlier
                // one.
                return null;
            },
            create: async () => {
                created += 1;
                return { id: `new-${created}` };
            },
            updateMany: async () => ({ count: 0 })
        }
    }
}));

const meetings = await import("../../src/lib/chat/meetings");

/** Somebody already sitting in the room, arrived `minute` minutes in. */
function seated(id: string, minute: number): Row {
    return {
        id,
        userId: `user-${id}`,
        joinedAt: new Date(Date.UTC(2026, 0, 1, 12, minute)),
        leftAt: null,
        admission: "admitted"
    };
}

beforeEach(() => {
    limit = 0;
    kind = "voice";
    rows = [];
    created = 0;
    mayModerate = false;
});

describe("the rule, as the rail and the server both read it", () => {
    it("is no limit at zero, and full once the room holds as many as it allows", () => {
        expect(core.voiceRoomFull({ limit: 0, present: 50 })).toBe(false);
        expect(core.voiceRoomFull({ limit: 3, present: 2 })).toBe(false);
        expect(core.voiceRoomFull({ limit: 3, present: 3 })).toBe(true);
        expect(core.voiceRoomFull({ limit: Number.NaN, present: 3 })).toBe(false);
    });

    it("is written as present over total, and not at all without a limit", () => {
        expect(core.voiceOccupancy({ limit: 5, present: 2 })).toBe("2/5");
        expect(core.voiceOccupancy({ limit: 0, present: 2 })).toBeNull();
    });

    it("accepts a whole number of people from none up to the ceiling", () => {
        const schema = core.chatVoiceUserLimitSchema;
        expect(schema.safeParse(0).success).toBe(true);
        expect(schema.safeParse(core.MAX_VOICE_USER_LIMIT).success).toBe(true);
        expect(schema.safeParse(core.MAX_VOICE_USER_LIMIT + 1).success).toBe(false);
        expect(schema.safeParse(-1).success).toBe(false);
        expect(schema.safeParse(2.5).success).toBe(false);
        expect(
            core.chatChannelUpdateSchema.safeParse({
                channelId: "018f2b6e-0000-7000-8000-000000000001",
                userLimit: 4
            }).success
        ).toBe(true);
    });
});

describe("walking into a limited voice channel", () => {
    it("is refused once the room is full, with a sentence that says so", async () => {
        limit = 2;
        rows = [seated("a", 1), seated("b", 2)];

        await expect(meetings.join({ id: "late", name: "Late" }, "m1")).rejects.toThrow(
            /This voice channel is full\. It holds 2 people at a time\./
        );
        expect(created).toBe(0);
    });

    it("lets somebody in while there is room", async () => {
        limit = 3;
        rows = [seated("a", 1), seated("b", 2)];

        const seat = await meetings.join({ id: "late", name: "Late" }, "m1");
        expect(seat.admission).toBe("admitted");
        expect(created).toBe(1);
    });

    it("lets a moderator of the room walk past it", async () => {
        limit = 1;
        rows = [seated("a", 1)];
        mayModerate = true;

        await meetings.join({ id: "mod", name: "Mod" }, "m1");
        expect(created).toBe(1);
    });

    it("never limits a channel that has no limit, nor a call that is not in a voice channel", async () => {
        rows = [seated("a", 1), seated("b", 2), seated("c", 3)];
        await meetings.join({ id: "late", name: "Late" }, "m1");

        limit = 1;
        kind = "text";
        await meetings.join({ id: "later", name: "Later" }, "m1");
        expect(created).toBe(2);
    });
});

describe("the ticket for a seat in a limited voice channel", () => {
    it("is refused to a seat past the limit, counted by when each sat down", async () => {
        limit = 2;
        rows = [seated("a", 1), seated("b", 2), seated("c", 3)];

        await expect(
            meetings.requireWithinLimit({ meetingId: "m1", participantId: "a" })
        ).resolves.toBeUndefined();
        await expect(
            meetings.requireWithinLimit({ meetingId: "m1", participantId: "b" })
        ).resolves.toBeUndefined();
        // Two people raced in at once and both got a seat. The later one is the
        // one over the limit, and it is the one refused its ticket.
        await expect(
            meetings.requireWithinLimit({ meetingId: "m1", participantId: "c" })
        ).rejects.toThrow(/full/);
    });

    it("is given to a moderator past the limit", async () => {
        limit = 1;
        rows = [seated("a", 1), seated("b", 2)];
        mayModerate = true;

        await expect(
            meetings.requireWithinLimit({ meetingId: "m1", participantId: "b" })
        ).resolves.toBeUndefined();
    });

    it("is given to everybody when the channel has no limit", async () => {
        rows = [seated("a", 1), seated("b", 2), seated("c", 3)];
        await expect(
            meetings.requireWithinLimit({ meetingId: "m1", participantId: "c" })
        ).resolves.toBeUndefined();
    });
});
