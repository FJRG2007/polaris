/**
 * A run started from Tasks runs on what the person picked: the coordinator on
 * their model, every worker on their agent and model, and the repository's
 * role default only when they left the model on default.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const RUN = "0190c6a0-0000-7000-8000-0000000000aa";
const CHOICE = { provider: "anthropic", model: "claude-opus-4", payer: null };

const state = vi.hoisted(() => ({
    admitted: [] as Array<{ input: { cli: string; modelChoice: unknown }; prompt: string }>,
    created: [] as Array<Record<string, unknown>>,
    startModel: [] as string[],
    roleAgents: null as string | null
}));

const prisma = vi.hoisted(() => {
    const client: Record<string, unknown> = {
        agentOrchestrationRun: {
            count: vi.fn(async () => 0),
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: RUN, ...data })),
            update: vi.fn(async () => ({})),
            // The add reads it under its lock and the start reads its
            // coordinator; advanceRun's plain read stops at no run.
            findUnique: vi.fn(async ({ select }: { select?: Record<string, boolean> }) =>
                select?.maxTasks
                    ? { status: "active", maxTasks: 20, maxDepth: 4, ownerId: "u1", taskListId: "l1" }
                    : select?.coordinatorSessionId
                      ? { coordinatorSessionId: "coordinator-1" }
                      : null
            )
        },
        agentRepo: { findUnique: vi.fn(async () => ({ roleAgents: state.roleAgents })) },
        agentOrchestrationTask: {
            findMany: vi.fn(async () => []),
            findFirst: vi.fn(async () => null),
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
                state.created.push(data);
                return { id: `0190c6a0-0000-7000-8000-00000000000${state.created.length}` };
            })
        },
        taskAgentLink: { count: vi.fn(async () => 1) },
        $executeRawUnsafe: vi.fn(async () => 0)
    };
    client.$transaction = vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client));
    return client;
});

vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("@/lib/agents/session-queue", () => ({
    admitSession: vi.fn(async (input: { cli: string; modelChoice: unknown }, prompt: string) => {
        state.admitted.push({ input, prompt });
        return { session: { id: "coordinator-1" }, queuedAt: 1, startError: null };
    })
}));
vi.mock("@/lib/agents/session-runtime", () => ({ deliverFirstPrompt: vi.fn(async () => undefined) }));
vi.mock("@/lib/agents/session-service", () => ({ SessionRefusal: class extends Error {}, setAutoFeedback: vi.fn() }));
vi.mock("@/lib/agents/session-api", () => ({
    startModel: vi.fn(async (_user: string, _cli: string, spec: string) => {
        state.startModel.push(spec);
        const [provider, model] = spec.split("/");
        return { provider, model, payer: null };
    })
}));
vi.mock("@/lib/agents/task-items", () => ({ linkItem: vi.fn(async () => true), writeRunItems: vi.fn(async () => undefined) }));

const orchestration = await import("@/lib/agents/orchestration-service");

const ITEMS = [
    { id: "0190c6a0-0000-7000-8000-000000000001", reference: "ENG-1", name: "Fix", description: "", listId: "l1" },
    { id: "0190c6a0-0000-7000-8000-000000000002", reference: "ENG-2", name: "Docs", description: "", listId: "l1" }
];

function start(mode: "coordinator" | "workers", modelChoice: typeof CHOICE | null) {
    return orchestration.startRunFromItems({
        ownerId: "u1",
        repoId: "repo-1",
        cli: "opencode",
        modelChoice,
        mode,
        items: ITEMS,
        brief: ""
    });
}

beforeEach(() => {
    state.admitted = [];
    state.created = [];
    state.startModel = [];
    state.roleAgents = JSON.stringify({ coordinator: { agent: "opencode", model: "openai/gpt-5" }, worker: { agent: "claude", model: "" } });
});

describe("startRunFromItems", () => {
    it("starts the coordinator on the picked model, not the repository's", async () => {
        await start("coordinator", CHOICE);
        expect(state.admitted).toHaveLength(1);
        expect(state.admitted[0]!.input).toMatchObject({ cli: "opencode", modelChoice: CHOICE });
        expect(state.startModel).toEqual([]);
    });

    it("uses the repository's coordinator default when the model was left on default", async () => {
        await start("coordinator", null);
        expect(state.startModel).toEqual(["openai/gpt-5"]);
        expect(state.admitted[0]!.input.modelChoice).toMatchObject({ provider: "openai", model: "gpt-5" });
    });

    it("gives every worker the picked agent and model, over the repository's worker default", async () => {
        await start("workers", CHOICE);
        expect(state.created).toHaveLength(2);
        for (const task of state.created) {
            expect(task).toMatchObject({ cli: "opencode", model: "anthropic/claude-opus-4", role: "worker" });
        }
        expect(state.admitted).toEqual([]);
    });

    it("leaves a worker's model to the default when none was picked, still on the picked agent", async () => {
        await start("workers", null);
        for (const task of state.created) expect(task).toMatchObject({ cli: "opencode", model: null });
    });
});
