/**
 * The service half of the coordinator's verbs: a spawn keyed by the caller is
 * made once however often it is retried, and a child is only a session
 * dispatched for this run and started for the run's own person.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    tasks: [] as Array<{ id: string; runId: string; clientKey: string | null; sessionId: string | null; depth: number }>,
    sessions: [] as Array<{ id: string; startedById: string }>
}));

const prisma = vi.hoisted(() => {
    const task = {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
            const found = db.tasks.find((row) =>
                Object.entries(where).every(([key, value]) => (row as Record<string, unknown>)[key] === value)
            );
            return found ? { id: found.id } : null;
        }),
        findMany: vi.fn(async () => db.tasks.map((row) => ({ id: row.id, depth: row.depth }))),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
            const found = db.tasks.find((row) => row.id === where.id);
            return found ? { sessionId: found.sessionId, status: "ready" } : null;
        }),
        create: vi.fn(async ({ data }: { data: { runId: string; clientKey: string | null } }) => {
            const id = `00000000-0000-4000-8000-00000000000${db.tasks.length + 1}`;
            db.tasks.push({ id, runId: data.runId, clientKey: data.clientKey, sessionId: null, depth: 0 });
            return { id };
        })
    };
    const client = {
        agentOrchestrationTask: task,
        agentOrchestrationRun: {
            findUnique: vi.fn(async () => ({ status: "active", maxTasks: 20, maxDepth: 4 }))
        },
        agentSession: {
            count: vi.fn(async ({ where }: { where: { id: string; startedById: string } }) =>
                db.sessions.filter((row) => row.id === where.id && row.startedById === where.startedById).length
            )
        },
        $executeRawUnsafe: vi.fn(async () => 0),
        $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client))
    };
    return client;
});

vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("@/lib/agents/session-queue", () => ({}));
vi.mock("@/lib/agents/session-runtime", () => ({}));
vi.mock("@/lib/agents/session-service", () => ({ SessionRefusal: class extends Error {} }));
vi.mock("@/lib/agents/session-api", () => ({ startModel: vi.fn() }));

const orchestration = await import("@/lib/agents/orchestration-service");

const RUN = { id: "11111111-1111-4111-8111-111111111111", ownerId: "u1" };

beforeEach(() => {
    db.tasks = [];
    db.sessions = [];
    // advanceRun reads the run again; an inactive one makes it a no-op here.
    prisma.agentOrchestrationRun.findUnique.mockImplementation(async () => ({
        status: "active",
        maxTasks: 20,
        maxDepth: 4
    }));
});

describe("coordinator service", () => {
    it("makes one task for one client key, however often it is retried", async () => {
        const input = {
            clientKey: "fix-1",
            title: "Fix",
            prompt: "Do it",
            role: "worker" as const,
            agent: null,
            model: null
        };
        // Each add reads the run under its lock, then advanceRun reads it
        // again; answering that second read with nothing stops it there.
        prisma.agentOrchestrationRun.findUnique
            .mockResolvedValueOnce({ status: "active", maxTasks: 20, maxDepth: 4 })
            .mockResolvedValueOnce(null as never)
            .mockResolvedValueOnce({ status: "active", maxTasks: 20, maxDepth: 4 })
            .mockResolvedValueOnce(null as never);
        const first = await orchestration.spawnWorker(RUN, input);
        const second = await orchestration.spawnWorker(RUN, input);
        expect(second.taskId).toBe(first.taskId);
        expect(prisma.agentOrchestrationTask.create).toHaveBeenCalledTimes(1);
    });

    it("treats only this run's dispatched sessions of the same person as children", async () => {
        db.tasks.push({ id: "t1", runId: RUN.id, clientKey: null, sessionId: "s1", depth: 0 });
        db.tasks.push({ id: "t2", runId: "other", clientKey: null, sessionId: "s2", depth: 0 });
        db.tasks.push({ id: "t3", runId: RUN.id, clientKey: null, sessionId: "s3", depth: 0 });
        db.sessions.push({ id: "s1", startedById: "u1" }, { id: "s2", startedById: "u1" }, { id: "s3", startedById: "u2" });
        expect(await orchestration.childSession(RUN, "s1")).toEqual({ taskId: "t1", sessionId: "s1" });
        expect(await orchestration.childSession(RUN, "s2")).toBeNull();
        expect(await orchestration.childSession(RUN, "s3")).toBeNull();
        expect(await orchestration.childSession(RUN, "nope")).toBeNull();
    });
});
