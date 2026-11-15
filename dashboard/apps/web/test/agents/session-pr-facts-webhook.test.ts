/**
 * The GitHub App webhook hands every pull request, review and check event to
 * the pull request facts store, beside whatever else reads it, and nothing else.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    onPullFactWebhook: vi.fn(async () => [] as Promise<void>[])
}));

vi.mock("@/lib/github-service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/github-service")>()),
    getGithubWebhookSecret: vi.fn(async () => "secret"),
    githubAppHandle: vi.fn(async () => "polaris-here"),
    verifyWebhookSignature: vi.fn(() => true)
}));
vi.mock("@/lib/agents/agent-webhook", () => ({ handleAgentWebhook: vi.fn(async () => []) }));
vi.mock("@/lib/runners/runner-demand", () => ({ recordWorkflowJob: vi.fn(async () => 0) }));
vi.mock("@/lib/deploy/push-deploys", () => ({
    branchFromRef: (ref: string) => ref,
    triggerAutoDeploysForPush: vi.fn(async () => 0)
}));
vi.mock("@/lib/deploy/environments", () => ({
    closePullRequestPreview: vi.fn(async () => undefined),
    ensurePullRequestPreview: vi.fn(async () => undefined)
}));
vi.mock("@/lib/deploy/ci-wait", () => ({ finishedCheckOf: () => null, onChecksFinished: vi.fn(async () => 0) }));
vi.mock("@/lib/agents/session-pr-facts", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/agents/session-pr-facts")>()),
    onPullFactWebhook: mocks.onPullFactWebhook
}));

const { POST } = await import("@/app/api/deploy/github/webhook/route");

function delivery(event: string, body: unknown): Request {
    return new Request("http://localhost/api/deploy/github/webhook", {
        method: "POST",
        headers: { "x-github-event": event, "x-hub-signature-256": "sha256=x" },
        body: JSON.stringify(body)
    });
}

const payload = { action: "x", repository: { full_name: "acme/app" } };

beforeEach(() => mocks.onPullFactWebhook.mockClear());

describe("the webhook and pull request facts", () => {
    it.each([
        "pull_request",
        "pull_request_review",
        "pull_request_review_comment",
        "pull_request_review_thread",
        "check_suite",
        "check_run"
    ])("hands %s to the facts store", async (event) => {
        const res = await POST(delivery(event, payload));
        expect(res.status).toBe(200);
        expect(mocks.onPullFactWebhook).toHaveBeenCalledWith(event, payload);
    });

    it.each(["push", "issues", "workflow_run", "workflow_job"])("leaves %s alone", async (event) => {
        await POST(delivery(event, payload));
        expect(mocks.onPullFactWebhook).not.toHaveBeenCalled();
    });

    it("answers even when the refresh fails", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        mocks.onPullFactWebhook.mockRejectedValueOnce(new Error("db down"));
        const res = await POST(delivery("pull_request", payload));
        expect(res.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });
});
