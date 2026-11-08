/**
 * A session opened by an automation for a GitHub issue.
 *
 * What is pinned: Claude is preferred among signed-in agents, a refusal is
 * said on the issue instead of lost, a started session posts its link and is
 * handed the issue, and the issue is told when the pull request opens - but
 * never about itself.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    choices: [] as { id: string; readiness: "ready" | "missing" | "unknown" }[],
    capacity: null as string | null,
    limits: { allowed: true } as { allowed: boolean },
    comments: [] as { number: number; body: string }[],
    created: [] as Record<string, unknown>[],
    messages: [] as string[],
    startFails: false,
    delivered: [] as string[]
}));

vi.mock("next/server", () => ({ after: (fn: () => unknown) => void fn() }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example.test/" }));
vi.mock("@/lib/notifications/notice-words", () => ({
    wordsFor: async () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${JSON.stringify(values)}` : key
}));
vi.mock("@/lib/agents/agent-readiness", () => ({ agentChoicesFor: async () => state.choices }));
vi.mock("@/lib/agents/session-capacity", () => ({
    sessionCapacity: async () => ({}),
    capacityRefusal: () => state.capacity
}));
vi.mock("@/lib/agents/agent-usage-limits", () => ({ checkUsageLimits: async () => state.limits }));
vi.mock("@/lib/github-service", () => ({
    githubAppInstallationToken: async () => "token",
    commentOnIssue: async (_o: string, _r: string, number: number, body: string) => {
        state.comments.push({ number, body });
        return true;
    }
}));
vi.mock("@/lib/agents/session-service", () => ({
    createSession: async (input: Record<string, unknown>) => {
        state.created.push(input);
        return { session: { id: "s-1", branch: "polaris/issue-12" }, token: "report" };
    },
    addSessionMessage: async (_id: string, _role: string, text: string) => {
        state.messages.push(text);
    },
    readableFailure: () => "failed"
}));
vi.mock("@/lib/agents/session-runtime", () => ({
    startSession: async () => {
        if (state.startFails) throw new Error("daemon said no");
    },
    deliverFirstPrompt: async (_id: string, prompt: string) => {
        state.delivered.push(prompt);
    }
}));

import {
    issueSessionPrompt,
    noteIssueOfPull,
    pickSessionAgent,
    startIssueSession
} from "@/lib/agents/issue-sessions";

const INPUT = {
    repo: { id: "r-1", ownerId: "u-1", repoFullName: "acme/app" },
    issueNumber: 12,
    prNumber: null,
    title: "Crash on save",
    instructions: "Fix it and open a pull request.",
    described: "<issue>Crash on save</issue>"
};

beforeEach(() => {
    state.choices = [
        { id: "codex", readiness: "ready" },
        { id: "claude", readiness: "unknown" }
    ];
    state.capacity = null;
    state.limits = { allowed: true };
    state.comments = [];
    state.created = [];
    state.messages = [];
    state.startFails = false;
    state.delivered = [];
});

describe("pickSessionAgent", () => {
    it("prefers Claude, then the first signed-in agent, else none", () => {
        expect(pickSessionAgent(state.choices)).toBe("claude");
        expect(pickSessionAgent([{ id: "claude", readiness: "missing" }, { id: "codex", readiness: "ready" }])).toBe(
            "codex"
        );
        expect(pickSessionAgent([{ id: "claude", readiness: "missing" }])).toBeNull();
    });
});

describe("issueSessionPrompt", () => {
    it("puts the operator's instructions before the issue", () => {
        expect(issueSessionPrompt("  Do it. ", "<issue/>")).toBe("Do it.\n\n<issue/>");
        expect(issueSessionPrompt("", "<issue/>")).toBe("<issue/>");
    });
});

describe("startIssueSession", () => {
    it("opens a session on the issue, hands it the issue and posts its link", async () => {
        expect(await startIssueSession(INPUT)).toBe("s-1");
        expect(state.created[0]).toMatchObject({ cli: "claude", issueNumber: 12, startedById: "u-1" });
        expect(state.messages).toEqual(["Fix it and open a pull request.\n\n<issue>Crash on save</issue>"]);
        expect(state.delivered).toEqual(state.messages);
        expect(state.comments).toHaveLength(1);
        expect(state.comments[0]!.number).toBe(12);
        expect(state.comments[0]!.body).toContain("https://polaris.example.test/apps/agents/sessions/s-1");
    });

    it("says on the issue that no agent is signed in", async () => {
        state.choices = [{ id: "claude", readiness: "missing" }];
        expect(await startIssueSession(INPUT)).toBeNull();
        expect(state.created).toHaveLength(0);
        expect(state.comments.map((row) => row.body)).toEqual(["issueSessions.noAgent"]);
    });

    it("says on the issue when a limit refuses it", async () => {
        state.limits = { allowed: false };
        expect(await startIssueSession(INPUT)).toBeNull();
        expect(state.comments.map((row) => row.body)).toEqual(["issueSessions.refused"]);
        state.comments = [];
        state.limits = { allowed: true };
        state.capacity = "full";
        expect(await startIssueSession(INPUT)).toBeNull();
        expect(state.comments.map((row) => row.body)).toEqual(["issueSessions.refused"]);
    });

    it("says it failed when the session does not start, and sends no prompt", async () => {
        state.startFails = true;
        expect(await startIssueSession(INPUT)).toBe("s-1");
        expect(state.messages).toHaveLength(0);
        expect(state.comments.map((row) => row.body)).toEqual(["issueSessions.failed"]);
    });
});

describe("noteIssueOfPull", () => {
    const session = { issueNumber: 12, repoFullName: "acme/app", ownerId: "u-1" };

    it("tells the issue its pull request opened", async () => {
        await noteIssueOfPull(session, { number: 30, url: "https://github.com/acme/app/pull/30" });
        expect(state.comments).toEqual([
            {
                number: 12,
                body: 'issueSessions.pullOpened {"number":30,"url":"https://github.com/acme/app/pull/30"}'
            }
        ]);
    });

    it("says nothing for a session nobody opened from an issue, or on a pull request about itself", async () => {
        await noteIssueOfPull({ ...session, issueNumber: null }, { number: 30, url: "u" });
        await noteIssueOfPull({ ...session, issueNumber: 30 }, { number: 30, url: "u" });
        expect(state.comments).toHaveLength(0);
    });
});
