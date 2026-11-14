/**
 * A new session starts at once when the account's slots are held by idle ones.
 *
 * On a live deployment a person with three sessions idle since the day before
 * (the per-account ceiling) opened a fourth in Polar Code: it was created
 * `queued`, and since nothing ever ends an idle session and the queue only moves
 * when one ends, it showed "Queued" forever and never answered. These pin that
 * the person's own idle sessions give their slot up - oldest first - and that a
 * session working or waiting on an answer never does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    sessionCapacity: vi.fn(),
    createSession: vi.fn(),
    addSessionMessage: vi.fn(),
    startSession: vi.fn(),
    stopSession: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        $transaction: vi.fn(async () => []),
        agentSession: {
            findMany: mocks.findMany,
            updateMany: mocks.updateMany,
            count: mocks.count,
            groupBy: mocks.groupBy,
            findUnique: vi.fn(async () => ({
                state: "queued",
                startedById: "user-1",
                createdAt: new Date(0)
            }))
        }
    }
}));
vi.mock("@/lib/agents/session-capacity", async () => {
    const actual = await vi.importActual<typeof import("@/lib/agents/session-capacity")>(
        "@/lib/agents/session-capacity"
    );
    return { ...actual, sessionCapacity: mocks.sessionCapacity };
});
vi.mock("@/lib/agents/session-spares", () => ({ takeSpare: vi.fn(async () => null) }));
vi.mock("@/lib/agents/session-service", () => {
    class SessionRefusal extends Error {}
    return {
        SessionRefusal,
        createSession: mocks.createSession,
        addSessionMessage: mocks.addSessionMessage,
        reissueSessionToken: vi.fn()
    };
});
vi.mock("@/lib/agents/session-runtime", () => ({
    startSession: mocks.startSession,
    stopSession: mocks.stopSession,
    deliverFirstPrompt: vi.fn()
}));

const { admitSession, idleToRetire, makeRoom, sweepSessionQueue, IDLE_RETIRE_AFTER_MS } = await import(
    "@/lib/agents/session-queue"
);

const NOW = Date.UTC(2026, 10, 14, 13, 57);
const capacityOf = (mine: number) => ({ mine, perAccount: 3, total: mine, totalCeiling: 12 });
const input = {
    repoId: "repo",
    startedById: "user-1",
    title: "Que hay en el repo?",
    cli: "claude",
    command: "claude",
    place: "local",
    sharedHome: false,
    unattended: null,
    accountId: null,
    useMachineLogin: false,
    hostId: null,
    baseRef: "main",
    taskId: null,
    enigma: null
} as unknown as Parameters<typeof admitSession>[0];

beforeEach(() => {
    vi.clearAllMocks();
    mocks.stopSession.mockResolvedValue(null);
    mocks.createSession.mockImplementation(async (value: { queued?: boolean }) => ({
        session: { id: "new", state: value.queued ? "queued" : "starting" },
        token: "token"
    }));
    mocks.count.mockResolvedValue(0);
    mocks.updateMany.mockResolvedValue({ count: 1 });
});

describe("idleToRetire", () => {
    it("stops nothing while there is room", () => {
        expect(idleToRetire(2, 3, 1, 2)).toBe(0);
    });

    it("stops as many as the account is over, never more than are idle", () => {
        expect(idleToRetire(3, 3, 1, 3)).toBe(1);
        expect(idleToRetire(3, 3, 2, 3)).toBe(2);
        expect(idleToRetire(3, 3, 2, 1)).toBe(1);
        expect(idleToRetire(3, 3, 9, 3)).toBe(3);
    });
});

describe("makeRoom", () => {
    it("stops the oldest idle session, and only one that has sat idle a while", async () => {
        mocks.sessionCapacity.mockResolvedValue(capacityOf(3));
        mocks.findMany.mockResolvedValue([{ id: "oldest" }, { id: "older" }, { id: "old" }]);
        expect(await makeRoom("user-1", 1, NOW)).toBe(1);
        expect(mocks.stopSession).toHaveBeenCalledExactlyOnceWith("oldest");
        const cutoff = new Date(NOW - IDLE_RETIRE_AFTER_MS);
        const where = {
            startedById: "user-1",
            state: "idle",
            updatedAt: { lt: cutoff },
            messages: { none: { role: "user", createdAt: { gte: cutoff } } }
        };
        const query = mocks.findMany.mock.calls[0]![0];
        expect(query.where).toEqual(where);
        expect(query.orderBy).toEqual([{ updatedAt: "asc" }, { id: "asc" }]);
        // The stop is claimed on the same conditions, so what changed since the
        // read is not stopped.
        expect(mocks.updateMany).toHaveBeenCalledExactlyOnceWith({
            where: { ...where, id: "oldest" },
            data: { state: "stopped", finishedAt: new Date(NOW), tokenHash: null }
        });
    });

    it("skips a session somebody else claimed or that got busy, and takes the next", async () => {
        // Two admissions at once read the same oldest session; the other won it.
        mocks.sessionCapacity.mockResolvedValue(capacityOf(3));
        mocks.findMany.mockResolvedValue([{ id: "taken" }, { id: "next" }, { id: "spare" }]);
        mocks.updateMany.mockResolvedValueOnce({ count: 0 });
        expect(await makeRoom("user-1", 1, NOW)).toBe(1);
        expect(mocks.stopSession).toHaveBeenCalledExactlyOnceWith("next");
        expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    });

    it("stops as many as are needed for what is wanted, never more", async () => {
        mocks.sessionCapacity.mockResolvedValue(capacityOf(3));
        mocks.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
        expect(await makeRoom("user-1", 2, NOW)).toBe(2);
        expect(mocks.stopSession.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    });

    it("does nothing without an account", async () => {
        expect(await makeRoom(null, 1, NOW)).toBe(0);
        expect(mocks.sessionCapacity).not.toHaveBeenCalled();
    });

    it("leaves sessions alone when the account has room", async () => {
        mocks.sessionCapacity.mockResolvedValue(capacityOf(1));
        expect(await makeRoom("user-1", 1, NOW)).toBe(0);
        expect(mocks.findMany).not.toHaveBeenCalled();
        expect(mocks.stopSession).not.toHaveBeenCalled();
    });

    it("stops nothing when every session is working or waiting on an answer", async () => {
        mocks.sessionCapacity.mockResolvedValue(capacityOf(3));
        mocks.findMany.mockResolvedValue([]);
        expect(await makeRoom("user-1", 1, NOW)).toBe(0);
        expect(mocks.stopSession).not.toHaveBeenCalled();
    });

    it("keeps the slot it freed when the machine could not be taken down", async () => {
        // The row is already stopped, so the slot is free; the teardown failure
        // is the one Stop itself swallows, and is logged rather than thrown.
        mocks.sessionCapacity.mockResolvedValue(capacityOf(3));
        mocks.findMany.mockResolvedValue([{ id: "stuck" }]);
        mocks.stopSession.mockRejectedValueOnce(new Error("daemon away"));
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await makeRoom("user-1", 1, NOW)).toBe(1);
        expect(log).toHaveBeenCalledOnce();
        log.mockRestore();
    });
});

describe("admitSession", () => {
    it("starts a fourth session at once when three idle ones hold the slots", async () => {
        // Three idle sessions; once the oldest is stopped there is room.
        mocks.sessionCapacity
            .mockResolvedValueOnce(capacityOf(3))
            .mockResolvedValueOnce(capacityOf(2));
        mocks.findMany.mockResolvedValue([{ id: "yesterday" }]);
        const admitted = await admitSession(input, "Que hay en el repo?");
        expect(mocks.stopSession).toHaveBeenCalledExactlyOnceWith("yesterday");
        expect(admitted.queuedAt).toBeNull();
        expect(mocks.createSession).toHaveBeenCalledWith(expect.not.objectContaining({ queued: true }));
        expect(mocks.startSession).toHaveBeenCalledOnce();
    });

    it("still queues when the account's sessions are all busy", async () => {
        mocks.sessionCapacity.mockResolvedValue(capacityOf(3));
        mocks.findMany.mockResolvedValue([]);
        const admitted = await admitSession(input, "Que hay en el repo?");
        expect(admitted.queuedAt).not.toBeNull();
        expect(mocks.startSession).not.toHaveBeenCalled();
    });
});

describe("sweepSessionQueue", () => {
    it("makes room for each account with sessions waiting, for as many as wait", async () => {
        mocks.groupBy.mockResolvedValue([{ startedById: "user-1", _count: { _all: 2 } }]);
        mocks.sessionCapacity.mockResolvedValue(capacityOf(3));
        mocks.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }, { id: "c" }]);
        await sweepSessionQueue();
        expect(mocks.stopSession.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    });
});
