/**
 * A session's life as the server records it: opened with its card on the
 * first play, one game per call, players joining and leaving, and ended by
 * the last one out - waking the card's message at every step.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const MEETING = "0192f6a0-0000-7000-8000-0000000000aa";
const CHANNEL = "0192f6a0-0000-7000-8000-0000000000cc";

interface Session {
    id: string;
    meetingId: string;
    channelId: string;
    game: string;
    startedById: string;
    messageId: string | null;
    createdAt: Date;
    endedAt: Date | null;
}
interface Player {
    sessionId: string;
    userId: string;
    seenAt: Date;
    leftAt: Date | null;
}

const db = vi.hoisted(() => ({
    sessions: [] as Session[],
    players: [] as Player[],
    messages: [] as { id: string; body: string }[],
    woken: [] as string[],
    callEnded: false
}));

const playersOf = (id: string) => db.players.filter((row) => row.sessionId === id);

vi.mock("@/lib/chat/live", () => ({
    publishChatChange: (change: { messageIds?: string[] }) => {
        db.woken.push(...(change.messageIds ?? ["new"]));
    }
}));
vi.mock("@polaris/db", () => {
    let turn: Promise<unknown> = Promise.resolve();
    const prisma = {
        // One transaction at a time, as the advisory lock makes it per call.
        $transaction: <T>(work: (tx: typeof prisma) => Promise<T>) => {
            const run = turn.then(() => work(prisma));
            turn = run.catch(() => undefined);
            return run;
        },
        $executeRaw: async () => 0,
        meeting: {
            findUnique: async () => ({
                channelId: CHANNEL,
                endedAt: db.callEnded ? new Date() : null
            })
        },
        chatMessage: {
            create: async ({ data }: { data: { body: string } }) => {
                const row = { id: `message-${db.messages.length + 1}`, body: data.body };
                db.messages.push(row);
                return { id: row.id };
            }
        },
        arcadeSession: {
            findMany: async ({ where }: { where: { meetingId: string; players?: unknown } }) =>
                db.sessions
                    .filter((row) => row.meetingId === where.meetingId && !row.endedAt)
                    .map((row) => ({ ...row, players: playersOf(row.id) })),
            create: async ({ data }: { data: Omit<Session, "id" | "createdAt" | "endedAt" | "messageId"> }) => {
                const row: Session = {
                    ...data,
                    id: `session-${db.sessions.length + 1}`,
                    messageId: null,
                    createdAt: new Date(),
                    endedAt: null
                };
                db.sessions.push(row);
                return row;
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<Session> }) => {
                const row = db.sessions.find((session) => session.id === where.id)!;
                Object.assign(row, data);
                return row;
            }
        },
        arcadeSessionPlayer: {
            upsert: async ({
                where,
                create,
                update
            }: {
                where: { sessionId_userId: { sessionId: string; userId: string } };
                create: Player;
                update: Partial<Player>;
            }) => {
                const { sessionId, userId } = where.sessionId_userId;
                const row = db.players.find((p) => p.sessionId === sessionId && p.userId === userId);
                if (row) Object.assign(row, update);
                else db.players.push({ ...create, leftAt: null });
            },
            update: async ({
                where,
                data
            }: {
                where: { sessionId_userId: { sessionId: string; userId: string } };
                data: Partial<Player>;
            }) => {
                const { sessionId, userId } = where.sessionId_userId;
                Object.assign(
                    db.players.find((p) => p.sessionId === sessionId && p.userId === userId)!,
                    data
                );
            },
            findMany: async ({ where }: { where: { sessionId: string } }) => playersOf(where.sessionId)
        }
    };
    return { prisma };
});

const sessions = await import("@/lib/chat/activity-sessions");

beforeEach(() => {
    db.sessions = [];
    db.players = [];
    db.messages = [];
    db.woken = [];
    db.callEnded = false;
});

describe("a session's life", () => {
    it("opens with its card on the first play and reuses it for the next player", async () => {
        await sessions.recordPlay(MEETING, "fixture-user-a", "new-york");
        await sessions.recordPlay(MEETING, "fixture-user-b", "new-york");
        expect(db.sessions).toHaveLength(1);
        expect(db.messages).toHaveLength(1);
        expect(db.messages[0]!.body).toBe(`polaris-activity:${db.sessions[0]!.id}`);
        expect(db.sessions[0]!.messageId).toBe("message-1");
        expect(playersOf("session-1").map((row) => row.userId)).toEqual([
            "fixture-user-a",
            "fixture-user-b"
        ]);
        expect(db.woken).toContain("message-1");
    });

    it("posts one card when two people start the call's game at once", async () => {
        await Promise.all([
            sessions.recordPlay(MEETING, "fixture-user-a", "new-york"),
            sessions.recordPlay(MEETING, "fixture-user-b", "new-york")
        ]);
        expect(db.sessions).toHaveLength(1);
        expect(db.messages).toHaveLength(1);
        expect(playersOf("session-1")).toHaveLength(2);
    });

    it("closes a session of another game: one game per call", async () => {
        await sessions.recordPlay(MEETING, "fixture-user-a", "new-york");
        await sessions.recordPlay(MEETING, "fixture-user-b", "other-game");
        expect(db.sessions.map((row) => [row.game, row.endedAt !== null])).toEqual([
            ["new-york", true],
            ["other-game", false]
        ]);
    });

    it("ends when the last player leaves, not before", async () => {
        await sessions.recordPlay(MEETING, "fixture-user-a", "new-york");
        await sessions.recordPlay(MEETING, "fixture-user-b", "new-york");
        await sessions.leavePlay(MEETING, "fixture-user-a");
        expect(db.sessions[0]!.endedAt).toBeNull();
        await sessions.leavePlay(MEETING, "fixture-user-b");
        expect(db.sessions[0]!.endedAt).not.toBeNull();
    });

    it("records nothing for a call that is over", async () => {
        db.callEnded = true;
        await sessions.recordPlay(MEETING, "fixture-user-a", "new-york");
        expect(db.sessions).toHaveLength(0);
        expect(db.messages).toHaveLength(0);
    });
});
