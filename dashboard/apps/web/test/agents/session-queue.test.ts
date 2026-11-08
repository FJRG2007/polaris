/**
 * Sessions over the ceiling wait instead of being refused, and every way in
 * goes through the same admission.
 *
 * The MCP start used to call createSession and startSession directly, so a
 * model holding an API key could start past the three-per-account and the
 * twelve-in-total that a person on the screen is held to. These pin that it now
 * queues exactly where the screen does, and that the queue hands slots out
 * first-in-first-out within an account and in turns between accounts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    sessionCapacity: vi.fn(),
    createSession: vi.fn(),
    addSessionMessage: vi.fn(),
    startSession: vi.fn(),
    deliverFirstPrompt: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn()
}));

vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@polaris/db", () => ({
    prisma: {
        agentRepo: { findFirst: mocks.findFirst },
        agentSession: { count: mocks.count, findUnique: mocks.findUnique }
    }
}));
vi.mock("@/lib/agents/session-capacity", async () => {
    const actual = await vi.importActual<typeof import("@/lib/agents/session-capacity")>(
        "@/lib/agents/session-capacity"
    );
    return { ...actual, sessionCapacity: mocks.sessionCapacity };
});
vi.mock("@/lib/agents/session-service", () => {
    class SessionRefusal extends Error {}
    return {
        SessionRefusal,
        createSession: mocks.createSession,
        addSessionMessage: mocks.addSessionMessage,
        readableFailure: () => "failed",
        reissueSessionToken: vi.fn(),
        getSession: vi.fn(),
        listSessions: vi.fn()
    };
});
vi.mock("@/lib/agents/session-runtime", () => ({
    startSession: mocks.startSession,
    deliverFirstPrompt: mocks.deliverFirstPrompt,
    promptSession: vi.fn()
}));

const { planQueue } = await import("@/lib/agents/session-queue");
const { SESSION_TOOLS } = await import("@/lib/mcp/tools/sessions");

const at = (minute: number) => new Date(Date.UTC(2026, 10, 9, 10, minute));
const entry = (id: string, accountId: string, minute: number) => ({
    id,
    accountId,
    queuedAt: at(minute)
});

describe("planQueue", () => {
    it("starts nothing when there is no room", () => {
        expect(planQueue([entry("a1", "a", 0)], new Map(), 3, 0)).toEqual([]);
    });

    it("keeps one account's order first in, first out", () => {
        const queue = [entry("a2", "a", 2), entry("a1", "a", 1), entry("a3", "a", 3)];
        expect(planQueue(queue, new Map(), 3, 2)).toEqual(["a1", "a2"]);
    });

    it("takes turns between accounts instead of draining the first one", () => {
        const queue = [
            entry("a1", "a", 0),
            entry("a2", "a", 1),
            entry("a3", "a", 2),
            entry("b1", "b", 5)
        ];
        expect(planQueue(queue, new Map(), 3, 2)).toEqual(["a1", "b1"]);
    });

    it("never takes an account past its own ceiling", () => {
        const queue = [entry("a1", "a", 0), entry("a2", "a", 1), entry("b1", "b", 2)];
        expect(planQueue(queue, new Map([["a", 2]]), 3, 5)).toEqual(["a1", "b1"]);
    });
});

const startTool = SESSION_TOOLS.find((tool) => tool.name === "agent_session_start")!;
const caller = { userId: "user-1", isAdmin: false, scopes: ["agents.manage"], keyId: "k" };
const input = { repo: "acme/app", title: "Fix", prompt: "Fix it", agent: "claude", baseRef: "" };
const created = { id: "s-1", branch: "polaris/fix", state: "starting" };

describe("agent_session_start over MCP", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.findFirst.mockResolvedValue({ id: "repo-1" });
        mocks.createSession.mockResolvedValue({ session: created, token: "t" });
        mocks.findUnique.mockResolvedValue({
            state: "queued",
            startedById: "user-1",
            createdAt: at(0)
        });
    });

    it("starts the session when there is room", async () => {
        mocks.sessionCapacity.mockResolvedValue({ mine: 0, perAccount: 3, total: 0, totalCeiling: 12 });
        const result = await startTool.run(input as never, caller as never);
        expect(mocks.startSession).toHaveBeenCalledOnce();
        expect(mocks.createSession.mock.calls[0][0].queued).toBeUndefined();
        expect((result as { structured: { queuedAt: unknown } }).structured.queuedAt).toBeNull();
    });

    it("queues instead of starting past the account's ceiling", async () => {
        mocks.sessionCapacity.mockResolvedValue({ mine: 3, perAccount: 3, total: 3, totalCeiling: 12 });
        mocks.count.mockResolvedValue(0);
        const result = await startTool.run(input as never, caller as never);
        expect(mocks.startSession).not.toHaveBeenCalled();
        expect(mocks.createSession.mock.calls[0][0].queued).toBe(true);
        expect(mocks.addSessionMessage).toHaveBeenCalledWith("s-1", "user", "Fix it", "user-1");
        expect((result as { text: string }).text).toContain("Queued");
    });

    it("queues past the deployment's ceiling too", async () => {
        mocks.sessionCapacity.mockResolvedValue({ mine: 0, perAccount: 3, total: 12, totalCeiling: 12 });
        mocks.count.mockResolvedValue(0);
        await startTool.run(input as never, caller as never);
        expect(mocks.startSession).not.toHaveBeenCalled();
    });

    it("refuses once the account's queue is full", async () => {
        mocks.sessionCapacity.mockResolvedValue({ mine: 3, perAccount: 3, total: 3, totalCeiling: 12 });
        mocks.count.mockResolvedValue(20);
        await expect(startTool.run(input as never, caller as never)).rejects.toThrow(
            /waiting to start/
        );
        expect(mocks.createSession).not.toHaveBeenCalled();
    });
});
