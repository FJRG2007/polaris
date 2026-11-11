/**
 * Which of a webhook's automations open a steerable session rather than a run:
 * a rule's `target` decides, and a mention rule aimed at a session takes the
 * mention away from the run it would otherwise start.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    dispatchRun: vi.fn(),
    startIssueSession: vi.fn(),
    agentRepoByFullName: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
// No automation listens here, so the rules answer every event as before.
vi.mock("@/lib/automations/code-events", () => ({ announceRepoEvent: async () => false }));
vi.mock("@/lib/agents/agent-run-service", () => ({
    finishAgentRun: vi.fn(),
    sweepStaleRuns: vi.fn(async () => 0)
}));
vi.mock("@/lib/agents/agent-dispatch", () => ({ dispatchRun: mocks.dispatchRun }));
vi.mock("@/lib/agents/agent-fallback", () => ({ considerFallback: vi.fn(async () => undefined) }));
vi.mock("@/lib/github-service", () => ({ githubAppInstallationToken: vi.fn() }));
vi.mock("@/lib/agents/agent-defaults-service", () => ({
    policyForRepo: vi.fn(async () => ({
        privateRepos: true,
        publicRepos: true,
        issues: true,
        pullRequests: true
    }))
}));
vi.mock("@/lib/agents/agent-repo-service", () => ({
    agentRepoByFullName: mocks.agentRepoByFullName
}));
vi.mock("@/lib/agents/issue-sessions", () => ({ startIssueSession: mocks.startIssueSession }));
vi.mock("@/lib/agents/review-gate", async () => {
    const core = await import("@polaris/core");
    return {
        reviewSettingsFor: async () => core.DEFAULT_REVIEW,
        reviewedPushes: async () => 0,
        mentionsThisHour: async () => 0
    };
});

import { ALWAYS_ON_TRIGGER } from "@polaris/core";
import { handleAgentWebhook } from "@/lib/agents/agent-webhook";

function rule(trigger: string, target: string, instructions = "") {
    return { trigger, target, instructions, condition: "{}", mode: null, enabled: true };
}

function repoWith(automations: ReturnType<typeof rule>[]) {
    return { id: "repo-1", ownerId: "owner-1", isPrivate: true, repoFullName: "acme/app", automations };
}

function issueOpened(body = "It crashes") {
    return handleAgentWebhook({
        event: "issues",
        appHandle: "polaris",
        payload: {
            action: "opened",
            repository: { full_name: "acme/app" },
            sender: { login: "dana", type: "User" },
            issue: { number: 12, title: "Crash on save", body, labels: [] }
        }
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.dispatchRun.mockResolvedValue({ runId: "run-1" });
    mocks.startIssueSession.mockResolvedValue("session-1");
});

describe("automation target", () => {
    it("opens a session on the issue for a rule aimed at one", async () => {
        mocks.agentRepoByFullName.mockResolvedValue(
            repoWith([rule("issue.opened", "session", "Fix it")])
        );
        expect(await issueOpened()).toEqual(["session-1"]);
        expect(mocks.dispatchRun).not.toHaveBeenCalled();
        expect(mocks.startIssueSession).toHaveBeenCalledWith(
            expect.objectContaining({ issueNumber: 12, title: "Crash on save", instructions: "Fix it" })
        );
    });

    it("starts a run for a rule aimed at a run, next to a session for another", async () => {
        mocks.agentRepoByFullName.mockResolvedValue(
            repoWith([rule("issue.opened", "run"), rule("issue.opened", "session")])
        );
        expect(await issueOpened()).toEqual(["run-1", "session-1"]);
    });

    it("answers a mention with a session when a mention rule asks for one", async () => {
        mocks.agentRepoByFullName.mockResolvedValue(
            repoWith([rule(ALWAYS_ON_TRIGGER, "session", "Look at it")])
        );
        expect(await issueOpened("@polaris please look")).toEqual(["session-1"]);
        expect(mocks.dispatchRun).not.toHaveBeenCalled();
    });

    it("lists nothing when the session could not start", async () => {
        mocks.agentRepoByFullName.mockResolvedValue(repoWith([rule("issue.opened", "session")]));
        mocks.startIssueSession.mockResolvedValue(null);
        expect(await issueOpened()).toEqual([]);
    });
});
