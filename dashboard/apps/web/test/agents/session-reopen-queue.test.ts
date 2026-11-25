/**
 * A prompt sent to a stopped session starts that same session again, as in a
 * chat: the same record (so the same thread, branch and conversation id), on a
 * new machine, or in the queue when the account is full. These pin that a
 * double send starts one machine, that the sweep and this path never both
 * start it, and that a reopened session waits behind the starts that were
 * already queued instead of jumping them on its old creation date.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    sessionCapacity: vi.fn(),
    reopenSessionRecord: vi.fn(),
    addSessionMessage: vi.fn(),
    reissueSessionToken: vi.fn(),
    sessionViewById: vi.fn(),
    startSession: vi.fn(),
    stopSession: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            findMany: mocks.findMany,
            findUnique: mocks.findUnique,
            updateMany: mocks.updateMany,
            count: mocks.count
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
        reopenSessionRecord: mocks.reopenSessionRecord,
        addSessionMessage: mocks.addSessionMessage,
        reissueSessionToken: mocks.reissueSessionToken,
        sessionViewById: mocks.sessionViewById
    };
});
vi.mock("@/lib/agents/session-runtime", () => ({
    startSession: mocks.startSession,
    stopSession: mocks.stopSession,
    deliverFirstPrompt: vi.fn()
}));

const { reopenSession, queueKey, queuePosition, queuePositions } = await import("@/lib/agents/session-queue");

const roomy = { mine: 1, perAccount: 3, total: 1, totalCeiling: 12 };
const full = { mine: 3, perAccount: 3, total: 3, totalCeiling: 12 };
const view = { id: "old-session", state: "starting" };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.reopenSessionRecord.mockResolvedValue(true);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.reissueSessionToken.mockResolvedValue({ session: view, token: "fresh" });
    mocks.sessionViewById.mockResolvedValue({ id: "old-session", state: "queued" });
    // Nothing idle to retire.
    mocks.findMany.mockResolvedValue([]);
    mocks.count.mockResolvedValue(0);
});

describe("reopenSession", () => {
    it("starts the same session again with the prompt as its next message", async () => {
        mocks.sessionCapacity.mockResolvedValue(roomy);
        const admitted = await reopenSession("old-session", "user-1", "and now the tests");
        expect(mocks.reopenSessionRecord).toHaveBeenCalledExactlyOnceWith("old-session");
        expect(mocks.addSessionMessage).toHaveBeenCalledExactlyOnceWith(
            "old-session",
            "user",
            "and now the tests",
            "user-1"
        );
        // Claimed from the queue the way the sweep claims, so it is started once.
        expect(mocks.updateMany).toHaveBeenCalledWith({
            where: { id: "old-session", state: "queued" },
            data: { state: "starting" }
        });
        expect(mocks.startSession).toHaveBeenCalledExactlyOnceWith(view, "fresh");
        expect(admitted).toEqual({ session: view, queuedAt: null });
    });

    it("waits in the queue when the account is full, and starts nothing", async () => {
        mocks.sessionCapacity.mockResolvedValue(full);
        mocks.findUnique.mockResolvedValue({
            state: "queued",
            startedById: "user-1",
            startedAt: new Date(5000),
            createdAt: new Date(0)
        });
        mocks.count.mockResolvedValue(2);
        const admitted = await reopenSession("old-session", "user-1", "again");
        expect(admitted?.queuedAt).toBe(3);
        expect(mocks.startSession).not.toHaveBeenCalled();
    });

    it("starts nothing a second time when another tab reopened it first", async () => {
        mocks.sessionCapacity.mockResolvedValue(roomy);
        mocks.reopenSessionRecord.mockResolvedValue(false);
        expect(await reopenSession("old-session", "user-1", "again")).toBeNull();
        expect(mocks.addSessionMessage).not.toHaveBeenCalled();
        expect(mocks.startSession).not.toHaveBeenCalled();
    });

    it("leaves it to the sweep when the sweep claimed it first", async () => {
        mocks.sessionCapacity.mockResolvedValue(roomy);
        mocks.updateMany.mockResolvedValue({ count: 0 });
        expect(await reopenSession("old-session", "user-1", "again")).toBeNull();
        expect(mocks.startSession).not.toHaveBeenCalled();
    });

    it("hands back a start that failed instead of throwing", async () => {
        mocks.sessionCapacity.mockResolvedValue(roomy);
        const failure = new Error("no machine");
        mocks.startSession.mockRejectedValue(failure);
        const admitted = await reopenSession("old-session", "user-1", "again");
        expect(admitted).toEqual({ session: view, queuedAt: null, startError: failure });
    });
});

describe("queue order for a reopened session", () => {
    it("is when it was asked to start again, not when it was made", () => {
        expect(queueKey({ startedAt: null, createdAt: new Date(100) }).getTime()).toBe(100);
        expect(queueKey({ startedAt: new Date(900), createdAt: new Date(100) }).getTime()).toBe(900);
    });

    it("counts the starts queued before it as ahead, by their own key", async () => {
        mocks.findUnique.mockResolvedValue({
            state: "queued",
            startedById: "user-1",
            startedAt: new Date(900),
            createdAt: new Date(100)
        });
        mocks.count.mockResolvedValue(1);
        expect(await queuePosition("old-session")).toBe(2);
        expect(mocks.count).toHaveBeenCalledWith({
            where: {
                state: "queued",
                startedById: "user-1",
                OR: [{ startedAt: { lt: new Date(900) } }, { startedAt: null, createdAt: { lt: new Date(900) } }]
            }
        });
    });

    it("ranks a reopened session behind a start queued after it was made but before it was reopened", async () => {
        mocks.findMany
            .mockResolvedValueOnce([{ startedById: "user-1" }, { startedById: "user-1" }])
            .mockResolvedValueOnce([
                // Made first, reopened last.
                { id: "reopened", startedById: "user-1", startedAt: new Date(900), createdAt: new Date(100) },
                { id: "fresh", startedById: "user-1", startedAt: null, createdAt: new Date(500) }
            ]);
        const positions = await queuePositions([
            { id: "reopened", state: "queued" },
            { id: "fresh", state: "queued" }
        ]);
        expect(positions).toEqual({ fresh: 1, reopened: 2 });
    });
});
