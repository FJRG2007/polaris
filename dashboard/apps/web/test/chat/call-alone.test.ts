/**
 * A one-to-one call nobody else is in ends itself.
 *
 * Left alone it runs until the tab closes, holding a camera light on, a
 * connection open and a guest link live - which is the case somebody walking
 * away from a call they started actually creates.
 *
 * Three things are asserted, and the last two are why this has a test rather
 * than a comment. It waits out the whole window - read from the module rather
 * than written down here, so shortening it is one change. It does not touch a
 * call in a
 * channel, where the first person to arrive is early rather than abandoned. And
 * it never fires while two people are in the room, however long ago the second
 * one arrived.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const MINUTE = 60_000;

interface ParticipantRow {
    id: string;
    meetingId: string;
    admission: string;
    leftAt: Date | null;
    lastSeenAt: Date;
}

let participants: ParticipantRow[] = [];
let kind = "dm";
let startedAt = new Date();
let endedAt: Date | null = null;

/** Enough of Prisma's `where` to answer what this module asks of it. */
function matches(row: ParticipantRow, where: Record<string, unknown>): boolean {
    for (const [field, wanted] of Object.entries(where)) {
        if (field === "meetingId" && row.meetingId !== wanted) return false;
        if (field === "admission" && row.admission !== wanted) return false;
        if (field === "id" && row.id !== wanted) return false;
        if (field === "leftAt") {
            if (wanted === null && row.leftAt !== null) return false;
            if (typeof wanted === "object" && wanted !== null) {
                const clause = wanted as { not?: unknown };
                if ("not" in clause && row.leftAt === null) return false;
            }
        }
        if (field === "lastSeenAt" && typeof wanted === "object" && wanted !== null) {
            const clause = wanted as { lt?: Date };
            if (clause.lt && !(row.lastSeenAt < clause.lt)) return false;
        }
    }
    return true;
}

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));

vi.mock("@polaris/db", () => ({
    prisma: {
        meeting: {
            findUnique: async () => ({
                id: "m1",
                endedAt,
                startedAt,
                channel: { kind }
            }),
            // Asked before the call is closed, so that ending it announces
            // itself to the conversation once rather than once per route that
            // can end a call.
            findFirst: async () => (endedAt === null ? { id: "m1" } : null),
            updateMany: async ({ data }: { data: { endedAt?: Date } }) => {
                if (data.endedAt) endedAt = data.endedAt;
                return { count: 1 };
            }
        },
        meetingParticipant: {
            count: async ({ where }: { where: Record<string, unknown> }) =>
                participants.filter((row) => matches(row, where)).length,
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                participants
                    .filter((row) => matches(row, where))
                    .sort((left, right) => (right.leftAt?.getTime() ?? 0) - (left.leftAt?.getTime() ?? 0))
                    .at(0) ?? null,
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

const seat = { meetingId: "m1", participantId: "p-alone" };

/** One person in the room, and one who left `ago` milliseconds back. */
function alone(ago: number): void {
    participants = [
        {
            id: "p-alone",
            meetingId: "m1",
            admission: "admitted",
            leftAt: null,
            lastSeenAt: new Date()
        },
        {
            id: "p-gone",
            meetingId: "m1",
            admission: "admitted",
            leftAt: new Date(Date.now() - ago),
            lastSeenAt: new Date(Date.now() - ago)
        }
    ];
}

beforeEach(() => {
    kind = "dm";
    endedAt = null;
    startedAt = new Date();
    participants = [];
});

describe("a call somebody is sitting in on their own", () => {
    it("ends once they have been alone long enough", async () => {
        alone(meetings.ALONE_TTL_MS + MINUTE);
        await meetings.keepSeat(seat);
        expect(endedAt).not.toBeNull();
    });

    it("is left alone before then", async () => {
        alone(meetings.ALONE_TTL_MS - 10_000);
        await meetings.keepSeat(seat);
        expect(endedAt).toBeNull();
    });

    it("counts from when the call started when nobody ever answered", async () => {
        startedAt = new Date(Date.now() - 5 * MINUTE);
        participants = [
            {
                id: "p-alone",
                meetingId: "m1",
                admission: "admitted",
                leftAt: null,
                lastSeenAt: new Date()
            }
        ];
        await meetings.keepSeat(seat);
        expect(endedAt).not.toBeNull();
    });
});

describe("what it never touches", () => {
    it("a call in a channel, where being first is being early", async () => {
        kind = "text";
        alone(10 * MINUTE);
        await meetings.keepSeat(seat);
        expect(endedAt).toBeNull();
    });

    it("a call with two people in it, however long it has run", async () => {
        startedAt = new Date(Date.now() - 60 * MINUTE);
        participants = [
            {
                id: "p-alone",
                meetingId: "m1",
                admission: "admitted",
                leftAt: null,
                lastSeenAt: new Date()
            },
            {
                id: "p-other",
                meetingId: "m1",
                admission: "admitted",
                leftAt: null,
                lastSeenAt: new Date()
            }
        ];
        await meetings.keepSeat(seat);
        expect(endedAt).toBeNull();
    });

    it("a call that has already ended", async () => {
        const before = new Date(Date.now() - 10 * MINUTE);
        endedAt = before;
        alone(10 * MINUTE);
        await meetings.keepSeat(seat);
        expect(endedAt).toBe(before);
    });
});
