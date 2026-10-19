/**
 * Taking a closed seat back, as the service does it.
 *
 * The browser stays on the media server under its seat's id, so the seat it
 * takes back must be that same row: a new one leaves a moderator's mute or
 * disconnect aimed at an id nobody is connected as. And a seat a moderator
 * showed out, or a host removed, stays closed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Row {
    id: string;
    meetingId: string;
    userId: string;
    admission: string;
    leftAt: Date | null;
    joinedAt: Date;
    shownOut: boolean;
}

const state = vi.hoisted(() => ({
    rows: [] as Row[],
    meeting: { channelId: "c1" as string | null, endedAt: null as Date | null },
    room: [] as { meetingId: string; kind: string }[],
    created: 0
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/blocks", () => ({ blockersOf: async () => new Set<string>() }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => null,
    getIntegrationSecret: async () => null
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/meeting-events", () => ({
    publishMeetingEvent: (event: (typeof state.room)[number]) => void state.room.push(event)
}));
vi.mock("@/lib/chat/access", async (original) => ({
    ...(await original<typeof import("@/lib/chat/access")>()),
    requireChannel: async () => ({ mayModerate: false })
}));

type Where = Partial<{
    id: string;
    meetingId: string;
    userId: string;
    admission: string;
    shownOut: boolean;
    leftAt: null | { not: null };
    meeting: { endedAt: null };
}>;

function matches(row: Row, where: Where): boolean {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.meetingId !== undefined && row.meetingId !== where.meetingId) return false;
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.admission !== undefined && row.admission !== where.admission) return false;
    if (where.shownOut !== undefined && row.shownOut !== where.shownOut) return false;
    if (where.leftAt === null && row.leftAt !== null) return false;
    if (where.leftAt && row.leftAt === null) return false;
    if (where.meeting && state.meeting.endedAt) return false;
    return true;
}

function latest(where: Where): Row | null {
    const found = state.rows.filter((row) => matches(row, where));
    found.sort((a, b) => b.joinedAt.getTime() - a.joinedAt.getTime());
    return found[0] ?? null;
}

vi.mock("@polaris/db", () => ({
    prisma: {
        meeting: {
            findUnique: async () => ({ ...state.meeting, channel: { kind: "text", userLimit: 0 } })
        },
        meetingParticipant: {
            findFirst: async ({ where }: { where: Where }) => latest(where),
            updateMany: async ({ where, data }: { where: Where; data: Partial<Row> }) => {
                if (!where.id) return { count: 0 };
                const found = state.rows.filter((row) => matches(row, where));
                for (const row of found) Object.assign(row, data);
                return { count: found.length };
            },
            count: async ({ where }: { where: Where }) =>
                state.rows.filter((row) => matches(row, where)).length,
            create: async () => {
                state.created += 1;
                return { id: "new" };
            }
        }
    }
}));

const { retakeSeat } = await import("@/lib/chat/meetings");

const MEETING = "m1";
const ACTOR = { id: "u1", name: "Fixture Person" };

function closed(overrides: Partial<Row> = {}): Row {
    return {
        id: "seat-1",
        meetingId: MEETING,
        userId: ACTOR.id,
        admission: "admitted",
        leftAt: new Date(Date.now() - 1000),
        joinedAt: new Date(Date.now() - 60_000),
        shownOut: false,
        ...overrides
    };
}

beforeEach(() => {
    state.rows = [];
    state.meeting = { channelId: "c1", endedAt: null };
    state.room = [];
    state.created = 0;
});

describe("taking a closed seat back", () => {
    it("reopens the same row, so the media identity still matches", async () => {
        state.rows = [closed()];
        const seat = await retakeSeat(ACTOR, MEETING);
        expect(seat).toEqual({
            meetingId: MEETING,
            participantId: "seat-1",
            admission: "admitted"
        });
        expect(state.rows[0]?.leftAt).toBeNull();
        expect(state.created).toBe(0);
        expect(state.room).toContainEqual({ meetingId: MEETING, kind: "roster" });
    });

    it("does the same for a meeting of its own", async () => {
        state.meeting.channelId = null;
        state.rows = [closed()];
        const seat = await retakeSeat(ACTOR, MEETING);
        expect(seat?.participantId).toBe("seat-1");
    });

    it("never takes back a seat a moderator showed out", async () => {
        state.rows = [closed({ shownOut: true })];
        expect(await retakeSeat(ACTOR, MEETING)).toBeNull();
        expect(state.rows[0]?.leftAt).not.toBeNull();
    });

    it("never takes back a seat a host removed", async () => {
        state.meeting.channelId = null;
        state.rows = [closed({ admission: "denied" })];
        expect(await retakeSeat(ACTOR, MEETING)).toBeNull();
        expect(state.rows[0]?.leftAt).not.toBeNull();
    });

    it("does not reopen anything in a call that ended", async () => {
        state.meeting.endedAt = new Date();
        state.rows = [closed()];
        expect(await retakeSeat(ACTOR, MEETING)).toBeNull();
        expect(state.rows[0]?.leftAt).not.toBeNull();
    });

    it("returns the seat already open instead of reopening an older one", async () => {
        state.rows = [closed(), closed({ id: "seat-2", leftAt: null, joinedAt: new Date() })];
        const seat = await retakeSeat(ACTOR, MEETING);
        expect(seat?.participantId).toBe("seat-2");
        expect(state.rows[0]?.leftAt).not.toBeNull();
    });

    it("has nothing to take back for somebody never seated", async () => {
        expect(await retakeSeat(ACTOR, MEETING)).toBeNull();
        expect(state.created).toBe(0);
    });
});
