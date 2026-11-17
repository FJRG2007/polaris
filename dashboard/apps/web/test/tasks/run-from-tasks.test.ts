/**
 * Starting agents on a Tasks selection: refused whole unless the person can
 * edit every task and owns the repository, and the run gets the tasks in the
 * order they were selected, with the tool resolved on the server.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PLAN = "0190c6a0-0000-7000-8000-0000000000a1";
const REPO = "22222222-2222-4222-8222-222222222222";
const A = "33333333-3333-4333-8333-333333333331";
const B = "33333333-3333-4333-8333-333333333332";

const state = vi.hoisted(() => ({
    agents: true,
    writable: [] as string[],
    repo: true as boolean,
    started: null as unknown
}));

vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "u1", isAdmin: false }),
    requirePermission: async () => ({ id: "u1", isAdmin: false }),
    sessionCan: async () => state.agents
}));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string) => `t:${key}`
}));
vi.mock("@/lib/agents/agent-readiness", () => ({
    agentOptionsFor: async () => [
        {
            key: `claude:${PLAN}`,
            cli: "claude",
            label: "Claude Code",
            vendor: "Anthropic",
            docs: "",
            readiness: "ready",
            accountId: PLAN,
            account: "me@example.test",
            mine: true,
            machine: false,
            apiKey: false,
            env: "CLAUDE_CODE_OAUTH_TOKEN",
            missing: []
        }
    ]
}));
vi.mock("@/lib/tasks/access", () => ({
    writableTasks: async (_actor: unknown, ids: string[]) =>
        ids.filter((id) => state.writable.includes(id)).map((id) => ({ id, spaceId: "space-1" }))
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        agentRepo: { findFirst: async () => (state.repo ? { id: REPO } : null) },
        task: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.map((id, index) => ({
                    id,
                    name: `Task ${index}`,
                    description: "",
                    number: index + 1,
                    listId: "list-1",
                    space: { prefix: "ENG" }
                }))
        }
    }
}));
vi.mock("@/lib/agents/orchestration-service", () => ({
    OrchestrationRefusal: class extends Error {},
    startRunFromItems: async (input: unknown) => {
        state.started = input;
        return { id: "run-1", sessionId: "coordinator-1" };
    }
}));
vi.mock("@/components/agents/sessions/actions", () => ({ startSessionAction: async () => ({}) }));

for (const path of [
    "next/cache",
    "@/lib/tasks/live",
    "@/lib/tasks/refusal",
    "@/lib/tasks/task-detail-service",
    "@/lib/orgs/org-service",
    "@/lib/tasks/doc-service",
    "@/lib/tasks/time-service",
    "@/lib/audit-service",
    "@/lib/workspace-scope",
    "@/lib/tasks/task-service",
    "@/lib/tasks/view-service",
    "@/lib/tasks/form-service",
    "@/lib/tasks/space-service",
    "@/lib/tasks/share-service",
    "@/lib/tasks/commit-service",
    "@/lib/tasks/attachment-service",
    "@/lib/tasks/planning-service",
    "@/lib/tasks/automation-service"
]) {
    vi.doMock(path, () => (path === "next/cache" ? { revalidatePath: () => undefined } : {}));
}

const { startRunFromTasksAction } = await import("@/app/(app)/tasks/actions");

const BODY = {
    taskIds: [B, A],
    mode: "coordinator",
    repoId: REPO,
    pick: { source: `account:${PLAN}`, provider: "anthropic", model: null },
    brief: "  Ship it  "
};

beforeEach(() => {
    state.agents = true;
    state.writable = [A, B];
    state.repo = true;
    state.started = null;
});

describe("startRunFromTasksAction", () => {
    it("starts one run on the selection, in order, on the tool the server resolved", async () => {
        expect(await startRunFromTasksAction(BODY)).toEqual({ runId: "run-1", sessionId: "coordinator-1" });
        expect(state.started).toMatchObject({
            ownerId: "u1",
            repoId: REPO,
            cli: "claude",
            // Left on the source's default: the repository's role default.
            modelChoice: null,
            mode: "coordinator",
            brief: "Ship it",
            items: [
                { id: B, reference: "ENG-1", listId: "list-1" },
                { id: A, reference: "ENG-2", listId: "list-1" }
            ]
        });
    });

    it("passes the picked model on, resolved once on the server", async () => {
        await startRunFromTasksAction({
            ...BODY,
            mode: "workers",
            pick: { source: `account:${PLAN}`, provider: "anthropic", model: "claude-opus-4" }
        });
        expect(state.started).toMatchObject({
            mode: "workers",
            cli: "claude",
            modelChoice: { provider: "anthropic", model: "claude-opus-4" }
        });
    });

    it("refuses the whole selection when one task is not the person's to edit", async () => {
        state.writable = [A];
        expect(await startRunFromTasksAction(BODY)).toEqual({ error: "t:errors.agentRunNoAccess" });
        expect(state.started).toBeNull();
    });

    it("refuses an account without Agents, a repository that is not theirs, and a malformed body", async () => {
        state.agents = false;
        expect(await startRunFromTasksAction(BODY)).toEqual({ error: "t:errors.agentRunNotAllowed" });
        state.agents = true;
        state.repo = false;
        expect(await startRunFromTasksAction(BODY)).toEqual({ error: "t:errors.agentRunNoRepo" });
        state.repo = true;
        expect(await startRunFromTasksAction({ ...BODY, mode: "everyone" })).toEqual({
            error: "t:errors.agentRunInvalid"
        });
        expect(await startRunFromTasksAction({ ...BODY, taskIds: Array(21).fill(A) })).toEqual({
            error: "t:errors.agentRunInvalid"
        });
        expect(state.started).toBeNull();
    });

    it("refuses a pick that is not this person's", async () => {
        expect(await startRunFromTasksAction({ ...BODY, pick: { source: "account:someone-else" } })).toEqual({
            error: "t:code.noSource"
        });
        expect(state.started).toBeNull();
    });
});
