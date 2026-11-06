/**
 * A run that failed for credit with nowhere left to fall back to pauses the
 * account's automatic runs; one the fallback chain picked up does not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    run: null as Record<string, unknown> | null,
    chain: ["openrouter/model"] as string[],
    pauseAgentRuns: vi.fn(async () => ({ reason: "credits", since: "" })),
    dispatchRun: vi.fn(async () => ({ runId: "next" })),
    providerForModel: vi.fn((_model: string) => null as { slug: string } | null),
    held: null as { reason: string; since: string } | null,
    noticeRunsPausedForCredit: vi.fn(async () => undefined)
}));
const { pauseAgentRuns, dispatchRun, providerForModel, noticeRunsPausedForCredit } = state;
vi.mock("@/lib/agents/agent-pause", () => ({
    CREDIT_FAILURE_KINDS: ["provider-billing", "router-billing"],
    pauseAgentRuns: state.pauseAgentRuns,
    readAgentPause: vi.fn(async () => state.held)
}));
vi.mock("@/lib/agents/agent-notices", () => ({
    noticeRunsPausedForCredit: state.noticeRunsPausedForCredit
}));
vi.mock("@polaris/db", () => ({
    prisma: { agentRun: { findUnique: vi.fn(async () => state.run) } }
}));
vi.mock("@/lib/agents/model-keys", () => ({
    providersFor: vi.fn(async () => ["openrouter", "anthropic"])
}));
vi.mock("@/lib/agents/agent-providers", () => ({ providerForModel: state.providerForModel }));
vi.mock("@/lib/agents/agent-defaults-service", () => ({
    inheritedFallback: vi.fn(async () => [])
}));
vi.mock("@/lib/agents/agent-dispatch", () => ({ dispatchRun: state.dispatchRun }));
vi.mock("@polaris/core", async (original) => ({
    ...(await original<typeof import("@polaris/core")>()),
    resolveModelChain: vi.fn(() => state.chain)
}));

import { considerFallback } from "@/lib/agents/agent-fallback";

function failedRun(failureKind: string) {
    return {
        id: "run-1",
        state: "failed",
        model: "openrouter/model",
        attempt: 1,
        failureKind,
        trigger: "pr.opened",
        mode: null,
        issueNumber: null,
        prNumber: 3,
        startedById: null,
        parentRunId: null,
        prompt: "A pull request",
        repo: {
            id: "repo-1",
            ownerId: "owner-1",
            repoFullName: "acme/app",
            execution: "github",
            poolId: null,
            model: "openrouter/model",
            installationId: "1",
            enabled: true
        }
    };
}

beforeEach(() => {
    pauseAgentRuns.mockClear();
    dispatchRun.mockClear();
    noticeRunsPausedForCredit.mockClear();
    state.held = null;
    providerForModel.mockReset();
    providerForModel.mockImplementation(() => null);
    state.chain = ["openrouter/model"];
});

describe("running out of credit", () => {
    it("pauses automatic runs when no other model is left", async () => {
        state.run = failedRun("provider-billing");
        await considerFallback("run-1");
        expect(dispatchRun).not.toHaveBeenCalled();
        expect(pauseAgentRuns).toHaveBeenCalledWith("owner-1", "credits");
        expect(noticeRunsPausedForCredit).toHaveBeenCalledWith("owner-1", "run-1");
    });

    it("tells nobody again when the runs were already paused", async () => {
        state.held = { reason: "credits", since: "2026-01-01T00:00:00.000Z" };
        state.run = failedRun("provider-billing");
        await considerFallback("run-1");
        expect(pauseAgentRuns).not.toHaveBeenCalled();
        expect(noticeRunsPausedForCredit).not.toHaveBeenCalled();
    });

    it("does not pause when the fallback chain started another run", async () => {
        state.chain = ["openrouter/model", "anthropic/model"];
        state.run = failedRun("router-billing");
        const outcome = await considerFallback("run-1");
        expect(outcome.runId).toBe("next");
        expect(pauseAgentRuns).not.toHaveBeenCalled();
    });

    it("pauses when no model left in the chain has a usable provider key", async () => {
        state.chain = ["openrouter/model", "other/model"];
        providerForModel.mockImplementation(((model: string) =>
            model === "other/model" ? { slug: "other" } : null) as never);
        state.run = failedRun("provider-billing");
        const outcome = await considerFallback("run-1");
        expect(dispatchRun).not.toHaveBeenCalled();
        expect(outcome.exhausted).toBe(true);
        expect(pauseAgentRuns).toHaveBeenCalledWith("owner-1", "credits");
    });

    it("does not pause when the fallback dispatch was refused for another reason", async () => {
        state.chain = ["openrouter/model", "anthropic/model"];
        dispatchRun.mockResolvedValueOnce({ error: "A usage limit stopped this run." } as never);
        state.run = failedRun("provider-billing");
        const outcome = await considerFallback("run-1");
        expect(outcome.reason).toBe("A usage limit stopped this run.");
        expect(pauseAgentRuns).not.toHaveBeenCalled();
        expect(noticeRunsPausedForCredit).not.toHaveBeenCalled();
    });

    it("does not pause for a failure that is not about credit", async () => {
        state.run = failedRun("rate-ceiling");
        await considerFallback("run-1");
        expect(pauseAgentRuns).not.toHaveBeenCalled();
    });
});
