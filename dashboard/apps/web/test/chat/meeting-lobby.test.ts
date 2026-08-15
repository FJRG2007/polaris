/**
 * The lobby, which is the last check left on a link that can be forwarded.
 *
 * Two things are asserted here and both are about the same seat: somebody
 * waiting at the door cannot open it for themselves, and nothing of the call
 * reaches them while they wait. A participant row alone proves neither - it is
 * what a guest gets the moment they ask to join - so every check that says "you
 * are in this call" has to mean admitted, not merely present.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface ParticipantRow {
    id: string;
    meetingId: string;
    userId: string | null;
    name: string;
    admission: string;
    joinedAt: Date;
    leftAt: Date | null;
    lastSeenAt: Date;
}

let participants: ParticipantRow[] = [];

const meeting = {
    id: "m1",
    channelId: "c1",
    hostId: "host",
    title: "Standup",
    startedAt: new Date("2026-08-16T09:00:00.000Z"),
    endedAt: null,
    guestToken: "forwarded-token",
    approveGuests: true
};

/** Enough of Prisma's `where` to answer what this module actually asks. */
function matches(row: ParticipantRow, where: Record<string, unknown>): boolean {
    for (const [field, wanted] of Object.entries(where)) {
        const value = row[field as keyof ParticipantRow];
        if (wanted === null) {
            if (value !== null) return false;
            continue;
        }
        if (wanted !== null && typeof wanted === "object") {
            const clause = wanted as { not?: unknown; lt?: Date };
            if ("not" in clause && value === clause.not) return false;
            if (clause.lt && !((value as Date) < clause.lt)) return false;
            continue;
        }
        if (value !== wanted) return false;
    }
    return true;
}

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_STUN_URLS: "" }) }));

vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));

vi.mock("@polaris/db", () => ({
    prisma: {
        meeting: {
            findUnique: async ({
                where,
                select
            }: {
                where: { id?: string };
                select: Record<string, unknown>;
            }) => {
                if (where.id !== meeting.id) return null;
                if (!select.participants) return meeting;
                const nested = select.participants as { where: Record<string, unknown> };
                return {
                    ...meeting,
                    participants: participants
                        .filter((row) => matches(row, nested.where))
                        .sort((left, right) => left.joinedAt.getTime() - right.joinedAt.getTime())
                };
            },
            updateMany: async () => ({ count: 0 })
        },
        meetingParticipant: {
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                participants.find((row) => matches(row, where)) ?? null,
            count: async ({ where }: { where: Record<string, unknown> }) =>
                participants.filter((row) => matches(row, where)).length,
            updateMany: async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Record<string, unknown>;
            }) => {
                let count = 0;
                for (const row of participants) {
                    if (!matches(row, where)) continue;
                    Object.assign(row, data);
                    count += 1;
                }
                return { count };
            }
        },
        $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations)
    }
}));

const meetings = await import("../../src/lib/chat/meetings");
const { ChatAccessError } = await import("../../src/lib/chat/access");

const seatOf = (row: ParticipantRow) => ({ meetingId: row.meetingId, participantId: row.id });
const find = (id: string) => participants.find((row) => row.id === id)!;

beforeEach(() => {
    // Recent enough not to be swept, old enough that a refreshed heartbeat is a
    // measurably later instant.
    const seen = new Date(Date.now() - 5_000);
    participants = [
        {
            id: "p-host",
            meetingId: "m1",
            userId: "host",
            name: "The host",
            admission: "admitted",
            joinedAt: new Date(Date.now() - 60_000),
            leftAt: null,
            lastSeenAt: seen
        },
        {
            id: "p-guest",
            meetingId: "m1",
            userId: null,
            name: "Somebody on a link",
            admission: "waiting",
            joinedAt: new Date(Date.now() - 10_000),
            leftAt: null,
            lastSeenAt: seen
        }
    ];
});

describe("who may open the door", () => {
    it("refuses somebody still waiting, including for their own seat", async () => {
        await expect(
            meetings.decideAdmission(seatOf(find("p-guest")), "p-guest", true)
        ).rejects.toThrow(ChatAccessError);
        expect(find("p-guest").admission).toBe("waiting");
    });

    it("refuses somebody who was already turned away", async () => {
        find("p-guest").admission = "denied";

        await expect(
            meetings.decideAdmission(seatOf(find("p-guest")), "p-guest", true)
        ).rejects.toThrow(ChatAccessError);
        expect(find("p-guest").admission).toBe("denied");
    });

    it("lets anybody already in the call decide", async () => {
        await meetings.decideAdmission(seatOf(find("p-host")), "p-guest", true);
        expect(find("p-guest").admission).toBe("admitted");
    });
});

describe("what a seat in the lobby can read", () => {
    it("gets its own admission and nothing about the call", async () => {
        const view = await meetings.readMeeting(seatOf(find("p-guest")));

        expect(view).not.toBeNull();
        expect(view!.guestToken).toBeNull();
        expect(view!.channelId).toBeNull();
        expect(view!.hostId).toBe("");
        expect(view!.participants).toHaveLength(1);
        expect(view!.participants[0]!.id).toBe("p-guest");
        expect(view!.participants[0]!.admission).toBe("waiting");
    });

    it("says so once they have been turned away, rather than going quiet", async () => {
        find("p-guest").admission = "denied";

        const view = await meetings.readMeeting(seatOf(find("p-guest")));

        expect(view!.participants[0]!.admission).toBe("denied");
    });

    it("keeps the seat alive, so waiting is not the same as being swept out", async () => {
        const before = find("p-guest").lastSeenAt;

        await meetings.readMeeting(seatOf(find("p-guest")));

        expect(find("p-guest").leftAt).toBeNull();
        expect(find("p-guest").lastSeenAt.getTime()).toBeGreaterThan(before.getTime());
    });

    it("hands the whole call to somebody who is in it", async () => {
        const view = await meetings.readMeeting(seatOf(find("p-host")));

        expect(view!.guestToken).toBe("forwarded-token");
        expect(view!.hostId).toBe("host");
        expect(view!.participants).toHaveLength(2);
    });
});
