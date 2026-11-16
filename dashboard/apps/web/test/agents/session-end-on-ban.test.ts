/**
 * Banning somebody ends the agent sessions working for them.
 *
 * A running session holds a reporting token that acts on `/api/mcp` as its
 * person. The ban has to reach it at once: every live session they started or
 * that works in one of their repositories loses its token in one statement,
 * before any machine is touched, and is then ended the ordinary way.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findMany: vi.fn(),
    updateMany: vi.fn(),
    stopSession: vi.fn()
}));

vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@polaris/db", () => ({
    prisma: { agentSession: { findMany: mocks.findMany, updateMany: mocks.updateMany } }
}));
vi.mock("@/lib/agents/session-service", () => ({}));
vi.mock("@/lib/agents/session-capacity", () => ({}));
vi.mock("@/lib/agents/session-spares", () => ({ takeSpare: async () => null }));
vi.mock("@/lib/agents/session-runtime", () => ({ stopSession: mocks.stopSession }));

const { endSessionsOf } = await import("@/lib/agents/session-queue");

beforeEach(() => {
    mocks.findMany.mockReset();
    mocks.updateMany.mockReset();
    mocks.stopSession.mockReset();
    mocks.stopSession.mockResolvedValue(null);
});

describe("endSessionsOf", () => {
    it("revokes every live session's token at once, then ends each one", async () => {
        mocks.findMany.mockResolvedValue([{ id: "s-queued" }, { id: "s-running" }]);
        // The token revocation; then the queue's own cancel, which only takes a
        // session that is still queued.
        mocks.updateMany.mockImplementation(async ({ where }: { where: { id: unknown } }) =>
            where.id === "s-queued" ? { count: 1 } : { count: where.id === "s-running" ? 0 : 2 }
        );

        expect(await endSessionsOf("ada")).toBe(2);

        const query = mocks.findMany.mock.calls[0]![0] as { where: unknown };
        expect(query.where).toEqual({
            state: { notIn: ["stopped", "failed"] },
            OR: [{ startedById: "ada" }, { repo: { ownerId: "ada" } }]
        });
        expect(mocks.updateMany.mock.calls[0]![0]).toEqual({
            where: { id: { in: ["s-queued", "s-running"] } },
            data: { tokenHash: null }
        });

        await vi.waitFor(() => expect(mocks.stopSession).toHaveBeenCalledTimes(1));
        expect(mocks.stopSession).toHaveBeenCalledWith("s-running");
    });

    it("touches nothing for somebody with no live session", async () => {
        mocks.findMany.mockResolvedValue([]);
        expect(await endSessionsOf("ada")).toBe(0);
        expect(mocks.updateMany).not.toHaveBeenCalled();
        expect(mocks.stopSession).not.toHaveBeenCalled();
    });
});
