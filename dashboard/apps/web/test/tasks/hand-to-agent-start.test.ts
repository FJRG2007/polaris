/**
 * Giving a task to an agent sends the model picked from a source, and the
 * server works out the tool from this person's own sources - as Polar Code
 * does - never from a tool the client named.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PLAN = "0190c6a0-0000-7000-8000-0000000000a1";

const state = vi.hoisted(() => ({ startedWith: null as unknown }));

vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "u1", isAdmin: false }),
    requirePermission: async () => ({ id: "u1", isAdmin: false }),
    sessionCan: async () => true
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
vi.mock("@/components/agents/sessions/actions", () => ({
    startSessionAction: async (input: unknown) => {
        state.startedWith = input;
        return { id: "started" };
    }
}));

// The rest of Tasks' server graph is not reached here.
for (const path of [
    "next/cache",
    "@polaris/db",
    "@/lib/tasks/access",
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
    vi.doMock(path, () => ({}));
}

const { handTaskToAgentAction } = await import("@/app/(app)/tasks/actions");

const BODY = {
    repoId: "22222222-2222-4222-8222-222222222222",
    title: "T-1 Fix the login form",
    place: "local",
    hostId: null,
    baseRef: "",
    prompt: "Fix it",
    taskId: "33333333-3333-4333-8333-333333333333"
};

beforeEach(() => {
    state.startedWith = null;
});

describe("handTaskToAgentAction", () => {
    it("resolves the tool from the picked source and ignores one the client named", async () => {
        expect(
            await handTaskToAgentAction({
                ...BODY,
                cli: "cursor",
                pick: { source: `account:${PLAN}`, provider: "anthropic", model: null }
            })
        ).toEqual({ id: "started" });
        expect(state.startedWith).toMatchObject({
            ...BODY,
            cli: "claude",
            accountId: PLAN,
            useMachineLogin: false,
            modelChoice: null
        });
        expect(state.startedWith).not.toHaveProperty("pick");
    });

    it("refuses a pick that is not this person's or does not validate, starting nothing", async () => {
        expect(
            await handTaskToAgentAction({ ...BODY, pick: { source: "account:someone-else" } })
        ).toEqual({ error: "t:code.noSource" });
        expect(await handTaskToAgentAction({ ...BODY, pick: { source: 42 } })).toEqual({
            error: "t:code.noSource"
        });
        expect(state.startedWith).toBeNull();
    });
});
