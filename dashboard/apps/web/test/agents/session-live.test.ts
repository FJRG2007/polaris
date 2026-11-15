/**
 * Session wakes across processes: a notice from another replica wakes the
 * pages open here, the echo of a local write folds into one wake, and a
 * reconnect wakes exactly the watched sessions that changed while away.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listened: { channel: string; handlers: { onNotice: (p: string) => void; onResync?: (d: Date) => unknown } }[] = [];

vi.mock("@/lib/live/pg-listener", () => ({
    pgListener: () => ({
        listen: (channel: string, handlers: (typeof listened)[number]["handlers"]) => {
            listened.push({ channel, handlers });
            return () => undefined;
        }
    })
}));

const db = vi.hoisted(() => ({
    sessions: [] as { id: string; updatedAt: Date }[],
    events: [] as { sessionId: string; createdAt: Date }[],
    messages: [] as { sessionId: string; createdAt: Date }[],
    asks: [] as { sessionId: string; createdAt: Date; answeredAt: Date | null }[],
    calls: 0
}));

type Where = { sessionId: { in: string[] }; createdAt?: { gte: Date } };

function grouped(rows: { sessionId: string; createdAt: Date }[], where: Where) {
    const ids = new Set(
        rows
            .filter((row) => where.sessionId.in.includes(row.sessionId))
            .filter((row) => !where.createdAt || row.createdAt >= where.createdAt.gte)
            .map((row) => row.sessionId)
    );
    return [...ids].map((sessionId) => ({ sessionId }));
}

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
                db.calls += 1;
                return db.sessions.filter((row) => where.id.in.includes(row.id));
            }
        },
        agentSessionEvent: { groupBy: async ({ where }: { where: Where }) => grouped(db.events, where) },
        agentSessionMessage: { groupBy: async ({ where }: { where: Where }) => grouped(db.messages, where) },
        agentPermissionRequest: {
            groupBy: async ({ where }: { where: { sessionId: { in: string[] }; OR: { createdAt?: { gte: Date }; answeredAt?: { gte: Date } }[] } }) => {
                const since = where.OR[0].createdAt!.gte;
                return grouped(
                    db.asks
                        .filter((row) => row.createdAt >= since || (row.answeredAt && row.answeredAt >= since))
                        .map((row) => ({ sessionId: row.sessionId, createdAt: row.createdAt })),
                    { sessionId: where.sessionId }
                );
            }
        }
    }
}));

const live = await import("@/lib/agents/session-live");

const A = "0192a000-0000-7000-8000-00000000000a";
const B = "0192a000-0000-7000-8000-00000000000b";
const C = "0192a000-0000-7000-8000-00000000000c";
const D = "0192a000-0000-7000-8000-00000000000d";

function notice(sessionId: string, kind = "event"): string {
    return JSON.stringify({ s: sessionId, k: kind });
}

describe("session wakes across processes", () => {
    const leave: (() => void)[] = [];

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        for (const off of leave.splice(0)) off();
        vi.useRealTimers();
    });

    it("listens on the session channel once, however many pages subscribe", () => {
        leave.push(live.subscribeSession(A, () => undefined));
        leave.push(live.subscribeSession(B, () => undefined));
        expect(listened.map((entry) => entry.channel)).toEqual([live.SESSION_CHANNEL]);
    });

    it("wakes the pages of a session another process changed, once per burst", async () => {
        const wakes: string[] = [];
        leave.push(live.subscribeSession(A, () => wakes.push("a1")));
        leave.push(live.subscribeSession(A, () => wakes.push("a2")));
        leave.push(live.subscribeSession(B, () => wakes.push("b")));

        live.receiveNotice(notice(A, "event"));
        live.receiveNotice(notice(A, "session"));
        live.receiveNotice(notice(A, "message"));
        expect(wakes).toEqual([]);
        await vi.advanceTimersByTimeAsync(live.MERGE_MS);
        expect(wakes).toEqual(["a1", "a2"]);

        // A later notice is a new wake.
        live.receiveNotice(notice(A));
        await vi.advanceTimersByTimeAsync(live.MERGE_MS);
        expect(wakes).toEqual(["a1", "a2", "a1", "a2"]);
    });

    it("folds the echo of a local write into the wake a coalescing stream already holds", async () => {
        // The stream route's shape: the first wake schedules one frame, later
        // ones inside the window do nothing.
        let frames = 0;
        let pending: ReturnType<typeof setTimeout> | null = null;
        leave.push(
            live.subscribeSession(A, () => {
                if (pending) return;
                pending = setTimeout(() => {
                    pending = null;
                    frames += 1;
                }, 400);
            })
        );
        live.touchSession(A);
        await vi.advanceTimersByTimeAsync(5);
        live.receiveNotice(notice(A));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(frames).toBe(1);
    });

    it("ignores a notice nobody here is watching, and one that is not a notice", async () => {
        const wakes: string[] = [];
        leave.push(live.subscribeSession(A, () => wakes.push("a")));
        live.receiveNotice(notice(C));
        live.receiveNotice("not json");
        live.receiveNotice(JSON.stringify({ s: "not-a-uuid", k: "event" }));
        live.receiveNotice(JSON.stringify({ s: A, k: "something else" }));
        await vi.advanceTimersByTimeAsync(live.MERGE_MS * 2);
        expect(wakes).toEqual([]);
    });

    it("after a reconnect, wakes exactly the watched sessions that changed while away", async () => {
        const since = new Date("2027-01-01T00:00:00.000Z");
        const before = new Date("2026-12-31T23:59:00.000Z");
        const after = new Date("2027-01-01T00:00:05.000Z");
        db.sessions = [
            { id: A, updatedAt: before },
            { id: B, updatedAt: before },
            { id: C, updatedAt: after }
        ];
        db.events = [{ sessionId: A, createdAt: after }];
        db.messages = [{ sessionId: B, createdAt: before }];
        db.asks = [{ sessionId: B, createdAt: before, answeredAt: before }];
        // D was deleted while the connection was down.

        const wakes = new Set<string>();
        for (const id of [A, B, C, D]) leave.push(live.subscribeSession(id, () => wakes.add(id)));

        await live.catchUp(since);
        expect([...wakes].sort()).toEqual([A, C, D].sort());

        // B's question answered while away wakes it too.
        wakes.clear();
        db.asks = [{ sessionId: B, createdAt: before, answeredAt: after }];
        await live.catchUp(since);
        expect(wakes.has(B)).toBe(true);
    });

    it("is the catch-up the listener calls on reconnect", () => {
        leave.push(live.subscribeSession(A, () => undefined));
        expect(listened[0].handlers.onResync).toBe(live.catchUp);
        expect(listened[0].handlers.onNotice).toBe(live.receiveNotice);
    });

    it("reads nothing on a reconnect with no page open", async () => {
        db.calls = 0;
        await live.catchUp(new Date());
        expect(db.calls).toBe(0);
    });
});
