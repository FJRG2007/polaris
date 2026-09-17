/**
 * The lines a direct message or a group gets when a call starts and ends.
 *
 * One line when the call is created (not when somebody joins it), one when it
 * ends saying how long it lasted - worked out from the meeting row - and, for a
 * call nobody answered, a line under the start instead of a second "called".
 * A call that began before these lines existed keeps the old missed-call line.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    announcesCalls,
    callEndedBody,
    callLength,
    noticeBody,
    renderNotice
} from "@/lib/chat/notice-text";

const MINUTE = 60_000;

interface Seat {
    id: string;
    userId: string | null;
    leftAt: Date | null;
}

const state = vi.hoisted(() => ({
    kind: "dm",
    running: null as { id: string } | null,
    seats: [] as { id: string; userId: string | null; leftAt: Date | null }[],
    startedAt: new Date(),
    endedAt: null as Date | null,
    startLine: false,
    notices: [] as { kind: string; subjectId: string }[],
    bodies: [] as string[]
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/blocks", () => ({ blockersOf: async () => new Set() }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => undefined }));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/meeting-events", () => ({ publishMeetingEvent: () => undefined }));
vi.mock("@/lib/chat/meeting-files", () => ({ discardMeetingChat: async () => undefined }));
vi.mock("@/lib/chat/notices", () => ({
    postNotice: async (_channelId: string, kind: string, cast: { subjectId: string }) => {
        state.notices.push({ kind, subjectId: cast.subjectId });
    },
    postNoticeBody: async (_channelId: string, body: string) => {
        state.bodies.push(body);
    }
}));
vi.mock("@/lib/chat/access", () => ({
    ChatAccessError: class extends Error {},
    requireChannel: async () => ({ channelId: "c1", kind: state.kind })
}));

const open = (seat: Seat) => seat.leftAt === null;

vi.mock("@polaris/db", () => ({
    prisma: {
        meeting: {
            findFirst: async ({ where }: { where: { endedAt?: null; id?: string } }) =>
                where.id ? (state.endedAt === null ? { id: "m1" } : null) : state.running,
            create: async () => {
                state.running = { id: "m1" };
                state.endedAt = null;
                state.startedAt = new Date();
                return { id: "m1" };
            },
            findUnique: async () => ({
                id: "m1",
                channelId: "c1",
                hostId: "ana",
                scheduledAt: null,
                startedAt: state.startedAt,
                endedAt: state.endedAt,
                channel: {
                    kind: state.kind,
                    members: [{ userId: "ana" }, { userId: "ben" }]
                }
            }),
            updateMany: async ({ data }: { data: { endedAt?: Date } }) => {
                if (data.endedAt) {
                    state.endedAt = data.endedAt;
                    state.running = null;
                }
                return { count: 1 };
            }
        },
        meetingParticipant: {
            count: async () => state.seats.filter(open).length,
            findFirst: async () => null,
            findMany: async () => state.seats.map((seat) => ({ userId: seat.userId })),
            create: async ({ data }: { data: { userId: string } }) => {
                const seat = { id: `p-${data.userId}`, userId: data.userId, leftAt: null };
                state.seats.push(seat);
                return { id: seat.id };
            },
            updateMany: async () => {
                for (const seat of state.seats) seat.leftAt ??= new Date();
                return { count: 1 };
            }
        },
        chatMessage: {
            findFirst: async () => (state.startLine ? { id: "line" } : null)
        },
        $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations)
    }
}));

const meetings = await import("@/lib/chat/meetings");

const ana = { id: "ana", name: "Ana", isAdmin: false } as never;
const ben = { id: "ben", name: "Ben", isAdmin: false } as never;

beforeEach(() => {
    state.kind = "dm";
    state.running = null;
    state.seats = [];
    state.startedAt = new Date();
    state.endedAt = null;
    state.startLine = false;
    state.notices = [];
    state.bodies = [];
});

describe("the wording", () => {
    it("says how long a call lasted", () => {
        expect(callLength(20_000)).toBe("a few seconds");
        expect(callLength(MINUTE)).toBe("1 minute");
        expect(callLength(12 * MINUTE + 30_000)).toBe("12 minutes");
        expect(callLength(60 * MINUTE)).toBe("1 hour");
        expect(callLength(125 * MINUTE)).toBe("2 hours 5 minutes");
        expect(callEndedBody(3 * MINUTE)).toBe("The call ended after 3 minutes");
    });

    it("names who started it, and the reader as you", () => {
        const body = noticeBody("callStarted", { id: "ana", name: "Ana" });
        expect(renderNotice(body, new Map([["ana", "Ana"]]), "ben")).toBe("Ana started a call");
        expect(renderNotice(body, new Map([["ana", "Ana"]]), "ana")).toBe("You started a call");
    });

    it("is written in direct messages and groups only", () => {
        expect(announcesCalls("dm")).toBe(true);
        expect(announcesCalls("group")).toBe(true);
        expect(announcesCalls("text")).toBe(false);
        expect(announcesCalls("voice")).toBe(false);
    });
});

describe("a call in a direct message", () => {
    it("writes one start line, for whoever created the call", async () => {
        await meetings.startOrJoin(ana, "c1");
        await meetings.startOrJoin(ben, "c1");
        expect(state.notices).toEqual([{ kind: "callStarted", subjectId: "ana" }]);
    });

    it("says how long an answered call lasted when it ends", async () => {
        await meetings.startOrJoin(ana, "c1");
        await meetings.startOrJoin(ben, "c1");
        state.startedAt = new Date(Date.now() - 7 * MINUTE);
        await meetings.end(ana, "m1");
        expect(state.bodies).toEqual(["The call ended after 7 minutes"]);
        expect(state.notices.map((notice) => notice.kind)).toEqual(["callStarted"]);
    });

    it("says nobody answered under the start line", async () => {
        await meetings.startOrJoin(ana, "c1");
        state.startLine = true;
        await meetings.end(ana, "m1");
        expect(state.notices.map((notice) => notice.kind)).toEqual([
            "callStarted",
            "callUnanswered"
        ]);
        expect(state.bodies).toEqual([]);
    });

    it("keeps the old missed-call line for a call with no start line", async () => {
        state.running = { id: "m1" };
        await meetings.end(ana, "m1");
        expect(state.notices.map((notice) => notice.kind)).toEqual(["missedCall"]);
    });

    it("starts a fresh call, with its own start line, over one nobody is in", async () => {
        state.running = { id: "m1" };
        state.startedAt = new Date(Date.now() - 90 * MINUTE);
        state.seats = [{ id: "p-ana", userId: "ana", leftAt: new Date() }];
        await meetings.startOrJoin(ana, "c1");
        expect(state.running).toEqual({ id: "m1" });
        expect(state.endedAt).toBeNull();
        expect(state.notices.map((notice) => notice.kind)).toEqual(["missedCall", "callStarted"]);
    });
});

describe("a call in a channel", () => {
    it("writes no start or end line", async () => {
        state.kind = "text";
        await meetings.startOrJoin(ana, "c1");
        await meetings.startOrJoin(ben, "c1");
        await meetings.end(ana, "m1");
        expect(state.notices).toEqual([]);
        expect(state.bodies).toEqual([]);
    });
});
