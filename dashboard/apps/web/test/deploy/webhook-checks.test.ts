/**
 * A finished check reaches both of the apps that read it: the Agents app, as it
 * always did, and the pushes Deploy is holding for CI.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    handleAgentWebhook: vi.fn(async () => [{ id: "run-1" }]),
    onChecksFinished: vi.fn(async () => 1)
}));

vi.mock("@/lib/github-service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/github-service")>()),
    getGithubWebhookSecret: vi.fn(async () => "secret"),
    githubAppHandle: vi.fn(async () => "polaris-here"),
    verifyWebhookSignature: vi.fn(() => true)
}));
vi.mock("@/lib/agents/agent-webhook", () => ({ handleAgentWebhook: mocks.handleAgentWebhook }));
vi.mock("@/lib/runners/runner-demand", () => ({ recordWorkflowJob: vi.fn() }));
vi.mock("@/lib/deploy/push-deploys", () => ({
    branchFromRef: (ref: string) => ref,
    triggerAutoDeploysForPush: vi.fn(async () => 0)
}));
vi.mock("@/lib/deploy/environments", () => ({
    closePullRequestPreview: vi.fn(),
    ensurePullRequestPreview: vi.fn()
}));
vi.mock("@/lib/deploy/ci-wait", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/deploy/ci-wait")>()),
    onChecksFinished: mocks.onChecksFinished
}));

const { POST } = await import("@/app/api/deploy/github/webhook/route");

const SHA = "c".repeat(40);
const repository = { full_name: "acme/web" };

function delivery(event: string, body: unknown): Request {
    return new Request("http://localhost/api/deploy/github/webhook", {
        method: "POST",
        headers: { "x-github-event": event, "x-hub-signature-256": "sha256=x" },
        body: JSON.stringify(body)
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    mocks.handleAgentWebhook.mockClear();
    mocks.onChecksFinished.mockClear();
});

afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
});

describe("a finished check suite", () => {
    it("still goes to the Agents app, and settles held pushes beside it", async () => {
        const payload = { action: "completed", repository, check_suite: { head_sha: SHA } };
        const res = await POST(delivery("check_suite", payload));
        expect(res.status).toBe(200);
        expect(mocks.handleAgentWebhook).toHaveBeenCalledWith(
            expect.objectContaining({ event: "check_suite", payload })
        );
        await vi.runAllTimersAsync();
        expect(mocks.onChecksFinished).toHaveBeenCalledWith("acme/web", SHA);
    });

    it("does the same for a finished workflow run", async () => {
        const payload = { action: "completed", repository, workflow_run: { head_sha: SHA } };
        await POST(delivery("workflow_run", payload));
        expect(mocks.handleAgentWebhook).toHaveBeenCalledTimes(1);
        await vi.runAllTimersAsync();
        expect(mocks.onChecksFinished).toHaveBeenCalledWith("acme/web", SHA);
    });

    it("settles nothing for one that has only been requested", async () => {
        await POST(
            delivery("check_suite", {
                action: "requested",
                repository,
                check_suite: { head_sha: SHA }
            })
        );
        expect(mocks.handleAgentWebhook).toHaveBeenCalledTimes(1);
        await vi.runAllTimersAsync();
        expect(mocks.onChecksFinished).not.toHaveBeenCalled();
    });
});

describe("a finished check run", () => {
    it("settles held pushes, and the Agents app is not asked", async () => {
        await POST(
            delivery("check_run", { action: "completed", repository, check_run: { head_sha: SHA } })
        );
        await vi.runAllTimersAsync();
        expect(mocks.onChecksFinished).toHaveBeenCalledWith("acme/web", SHA);
        expect(mocks.handleAgentWebhook).not.toHaveBeenCalled();
    });

    it("reads a commit's checks once for a burst of its jobs finishing", async () => {
        const payload = { action: "completed", repository, check_run: { head_sha: SHA } };
        for (let job = 0; job < 20; job += 1) {
            await POST(delivery("check_run", payload));
            await vi.advanceTimersByTimeAsync(500);
        }
        await POST(
            delivery("check_suite", {
                action: "completed",
                repository,
                check_suite: { head_sha: SHA }
            })
        );
        expect(mocks.onChecksFinished).not.toHaveBeenCalled();
        await vi.runAllTimersAsync();
        expect(mocks.onChecksFinished).toHaveBeenCalledTimes(1);
        expect(mocks.onChecksFinished).toHaveBeenCalledWith("acme/web", SHA);
    });

    it("is not put off past the longest delay by a steady stream", async () => {
        const payload = { action: "completed", repository, check_run: { head_sha: SHA } };
        for (let job = 0; job < 40; job += 1) {
            await POST(delivery("check_run", payload));
            await vi.advanceTimersByTimeAsync(1_000);
        }
        expect(mocks.onChecksFinished.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
});
