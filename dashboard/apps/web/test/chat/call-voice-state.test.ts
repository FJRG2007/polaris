/**
 * Who is muted or deafened, told to the people outside a call.
 *
 * They are never connected to the media server, so the seat is where they read
 * it. What is pinned: a change is written and announced to the conversation, a
 * beat that repeats the same answer is not announced again, and a beat without
 * the answer changes nothing about it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    meetingId: string;
    admission: string;
    leftAt: Date | null;
    lastSeenAt: Date;
    muted: boolean;
    deafened: boolean;
}

let rows: Row[] = [];
const published: unknown[] = [];

function matches(row: Row, where: Record<string, unknown>): boolean {
    for (const [field, wanted] of Object.entries(where)) {
        if (field === "NOT") {
            const not = wanted as Partial<Row>;
            if (Object.entries(not).every(([key, value]) => row[key as keyof Row] === value)) {
                return false;
            }
            continue;
        }
        if (field === "leftAt") {
            if (wanted === null && row.leftAt !== null) return false;
            continue;
        }
        if (typeof wanted === "object" && wanted !== null) continue;
        if (row[field as keyof Row] !== wanted) return false;
    }
    return true;
}

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/chat/live", () => ({
    publishChatChange: (change: unknown) => published.push(change)
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        meeting: {
            findUnique: async () => ({
                id: "m1",
                channelId: "c1",
                endedAt: null,
                startedAt: new Date(),
                channel: { kind: "text" }
            }),
            findFirst: async () => ({ id: "m1" }),
            updateMany: async () => ({ count: 0 })
        },
        meetingParticipant: {
            count: async ({ where }: { where: Record<string, unknown> }) =>
                rows.filter((row) => matches(row, where)).length,
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                rows.filter((row) => matches(row, where)),
            findFirst: async ({ where }: { where: Record<string, unknown> }) =>
                rows.find((row) => matches(row, where)) ?? null,
            updateMany: async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Partial<Row>;
            }) => {
                let count = 0;
                for (const row of rows) {
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

const seat = { meetingId: "m1", participantId: "p1" };

function seated(id: string): Row {
    return {
        id,
        meetingId: "m1",
        admission: "admitted",
        leftAt: null,
        lastSeenAt: new Date(),
        muted: false,
        deafened: false
    };
}

beforeEach(() => {
    rows = [seated("p1"), seated("p2")];
    published.length = 0;
});

const calls = () => published.filter((change) => (change as { kind: string }).kind === "call");

describe("a seat's microphone and headphones", () => {
    it("records a change and tells the conversation", async () => {
        await meetings.keepSeat(seat, { muted: true, deafened: true });
        expect(rows[0]).toMatchObject({ muted: true, deafened: true });
        expect(rows[1]).toMatchObject({ muted: false, deafened: false });
        expect(calls()).toEqual([
            expect.objectContaining({
                channelId: "c1",
                kind: "call",
                call: { meetingId: "m1", state: "moved", count: 2, voice: true }
            })
        ]);
    });

    it("does not announce a beat that repeats the same answer", async () => {
        await meetings.keepSeat(seat, { muted: true, deafened: false });
        await meetings.keepSeat(seat, { muted: true, deafened: false });
        expect(calls()).toHaveLength(1);
    });

    it("leaves it alone on a beat that does not say", async () => {
        rows[0]!.muted = true;
        await meetings.keepSeat(seat);
        expect(rows[0]!.muted).toBe(true);
        expect(calls()).toHaveLength(0);
    });

    it("hands the roster out with each person's state", async () => {
        rows[1]!.deafened = true;
        const live = await meetings.liveIn("c1");
        expect(live?.count).toBe(2);
        expect(live?.people.map((person) => [person.id, person.deafened])).toEqual([
            ["p1", false],
            ["p2", true]
        ]);
    });
});
