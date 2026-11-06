import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateMany } = vi.hoisted(() => ({ updateMany: vi.fn() }));
vi.mock("@polaris/db", () => ({ prisma: { agentRun: { updateMany } } }));
vi.mock("@/lib/agents/agent-notices", () => ({ noticeRunFinished: vi.fn() }));

import { runOutcome } from "@/lib/agents/agent-webhook";
import { finishAgentRun } from "@/lib/agents/agent-run-service";

describe("runOutcome", () => {
    it("is failed when the run reported a failure, even on a green job", () => {
        expect(runOutcome("success", { error: "can only afford 0", failureKind: null })).toBe(
            "failed"
        );
        expect(runOutcome("success", { error: null, failureKind: "router-billing" })).toBe(
            "failed"
        );
    });

    it("follows the conclusion otherwise", () => {
        const clean = { error: null, failureKind: null };
        expect(runOutcome("success", clean)).toBe("succeeded");
        expect(runOutcome("cancelled", clean)).toBe("cancelled");
        expect(runOutcome("failure", clean)).toBe("failed");
        expect(runOutcome(undefined, clean)).toBe("failed");
    });
});

describe("finishAgentRun", () => {
    beforeEach(() => {
        updateMany.mockReset();
        updateMany.mockResolvedValue({ count: 1 });
    });

    it("keeps the token counts the run reported when the closer knows none", async () => {
        await finishAgentRun("run-1", { state: "succeeded" });
        const data = updateMany.mock.calls[0]![0].data;
        expect(data).not.toHaveProperty("tokensIn");
        expect(data).not.toHaveProperty("tokensOut");
    });

    it("writes counts it is given", async () => {
        await finishAgentRun("run-1", { state: "failed", tokensIn: 120, tokensOut: 30 });
        expect(updateMany.mock.calls[0]![0].data).toMatchObject({ tokensIn: 120, tokensOut: 30 });
    });
});
