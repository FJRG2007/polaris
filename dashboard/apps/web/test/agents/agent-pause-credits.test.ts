/**
 * A run that failed for credit with nowhere left to fall back to pauses the
 * account's automatic runs; one the fallback chain picked up does not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    run: null as Record<string, unknown> | null,
    chain: ["openrouter/model"] as string[],
    pauseAgentRuns: vi.fn(async () => ({ reason: "credits", since: "" })),
    dispatchRun: vi.fn(async () => ({ runId: "next" }))
}));
const { pauseAgentRuns, dispatchRun } = state;
vi.mock("@/lib/agents/agent-pause", () => ({
    CREDIT_FAILURE_KINDS: ["provider-billing", "router-billing"],
    pauseAgentRuns: state.pauseAgentRuns
}));
vi.mock("@polaris/db", () => ({
    prisma: { agentRun: { findUnique: vi.fn(async () => state.run) } }
}));
vi.mock("@/lib/agents/model-keys", () => ({
    providersFor: vi.fn(async () => ["openrouter", "anthropic"])
}));
vi.mock("@/lib/agents/agent-providers", () => ({ providerForModel: vi.fn(() => null) }));
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
    state.chain = ["openrouter/model"];
});

describe("running out of credit", () => {
    it("pauses automatic runs when no other model is left", async () => {
        state.run = failedRun("provider-billing");
        await considerFallback("run-1");
        expect(dispatchRun).not.toHaveBeenCalled();
        expect(pauseAgentRuns).toHaveBeenCalledWith("owner-1", "credits");
    });

    it("does not pause when the fallback chain started another run", async () => {
        state.chain = ["openrouter/model", "anthropic/model"];
        state.run = failedRun("router-billing");
        const outcome = await considerFallback("run-1");
        expect(outcome.runId).toBe("next");
        expect(pauseAgentRuns).not.toHaveBeenCalled();
    });

    it("does not pause for a failure that is not about credit", async () => {
        state.run = failedRun("rate-ceiling");
        await considerFallback("run-1");
        expect(pauseAgentRuns).not.toHaveBeenCalled();
    });
});
