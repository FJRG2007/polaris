/**
 * The webhook starts an automatic review only for the pull requests the review
 * settings let through: drafts wait to be made ready, new pushes are reviewed
 * only when that is on and stop after the pause, and asking for a review by
 * name is never filtered.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    dispatchRun: vi.fn(),
    agentRepoByFullName: vi.fn(),
    reviewSettingsFor: vi.fn(),
    reviewedPushes: vi.fn()
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
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
vi.mock("@/lib/agents/agent-repo-service", () => ({ agentRepoByFullName: mocks.agentRepoByFullName }));
vi.mock("@/lib/agents/issue-sessions", () => ({ startIssueSession: vi.fn() }));
vi.mock("@/lib/agents/review-gate", () => ({
    reviewSettingsFor: mocks.reviewSettingsFor,
    reviewedPushes: mocks.reviewedPushes
}));

import { handleAgentWebhook } from "@/lib/agents/agent-webhook";

const rule = (trigger: string) => ({
    trigger,
    target: "run",
    instructions: "",
    condition: "{}",
    mode: null,
    enabled: true
});

function prEvent(action: string, pr: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    return handleAgentWebhook({
        event: "pull_request",
        appHandle: "polaris",
        payload: {
            action,
            repository: { full_name: "acme/app", default_branch: "main" },
            sender: { login: "dana", type: "User" },
            pull_request: {
                number: 7,
                title: "Add the export button",
                body: "",
                draft: false,
                user: { login: "dana" },
                base: { ref: "main" },
                head: { repo: { full_name: "acme/app" }, sha: "abc123" },
                labels: [],
                ...pr
            },
            ...extra
        }
    });
}

const settings = (over: Partial<core.ResolvedReview> = {}) => ({ ...core.DEFAULT_REVIEW, ...over });

beforeEach(() => {
    vi.clearAllMocks();
    mocks.dispatchRun.mockResolvedValue({ runId: "run-1" });
    mocks.reviewedPushes.mockResolvedValue(0);
    mocks.reviewSettingsFor.mockResolvedValue(settings());
    mocks.agentRepoByFullName.mockResolvedValue({
        id: "repo-1",
        ownerId: "owner-1",
        isPrivate: true,
        repoFullName: "acme/app",
        review: null,
        automations: [rule("pr.opened"), rule("pr.updated"), rule("pr.review_requested")]
    });
});

describe("automatic reviews", () => {
    it("reviews a pull request that passes the filters", async () => {
        expect(await prEvent("opened")).toEqual(["run-1"]);
        expect(mocks.reviewSettingsFor).toHaveBeenCalledWith(
            expect.objectContaining({ id: "repo-1" }),
            { defaultBranch: "main", head: "abc123" }
        );
    });

    it("leaves a draft alone, then reviews it once it is ready", async () => {
        expect(await prEvent("opened", { draft: true })).toEqual([]);
        expect(await prEvent("ready_for_review")).toEqual(["run-1"]);
    });

    it("does not review a draft twice when drafts are reviewed", async () => {
        mocks.reviewSettingsFor.mockResolvedValue(settings({ drafts: true }));
        expect(await prEvent("opened", { draft: true })).toEqual(["run-1"]);
        expect(await prEvent("ready_for_review")).toEqual([]);
    });

    it("skips an ignored author", async () => {
        mocks.reviewSettingsFor.mockResolvedValue(settings({ ignoreAuthors: ["dana"] }));
        expect(await prEvent("opened")).toEqual([]);
    });

    it("reviews new pushes only when that is on, and pauses after the limit", async () => {
        expect(await prEvent("synchronize")).toEqual([]);
        mocks.reviewSettingsFor.mockResolvedValue(settings({ incremental: true, pauseAfter: 2 }));
        expect(await prEvent("synchronize")).toEqual(["run-1"]);
        expect(mocks.dispatchRun).toHaveBeenLastCalledWith(expect.objectContaining({ trigger: "pr.updated" }));
        mocks.reviewedPushes.mockResolvedValue(2);
        expect(await prEvent("synchronize")).toEqual([]);
    });

    it("never filters a review somebody asked for", async () => {
        mocks.reviewSettingsFor.mockResolvedValue(settings({ ignoreAuthors: ["dana"] }));
        expect(await prEvent("review_requested", { draft: true })).toEqual(["run-1"]);
        expect(mocks.reviewSettingsFor).not.toHaveBeenCalled();
    });
});
