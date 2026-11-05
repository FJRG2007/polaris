/**
 * How a background run ends, and who is told.
 *
 * Every pull request on a repository with the agent used to put "Agent run on
 * ... succeeded" on the bell while the job itself failed with "not a recognized
 * run": the repository's own CI finished first, its `workflow_run` webhook was
 * taken for the agent's job, and the run was closed with CI's conclusion.
 */

import { resolveRule } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findFirst: vi.fn(),
    finishAgentRun: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: { agentRun: { findFirst: mocks.findFirst } }
}));
vi.mock("@/lib/agents/agent-run-service", () => ({
    finishAgentRun: mocks.finishAgentRun,
    sweepStaleRuns: vi.fn(async () => 0)
}));
vi.mock("@/lib/agents/agent-dispatch", () => ({ dispatchRun: vi.fn() }));
vi.mock("@/lib/agents/agent-fallback", () => ({ considerFallback: vi.fn(async () => undefined) }));
vi.mock("@/lib/github-service", () => ({ githubAppInstallationToken: vi.fn() }));
vi.mock("@/lib/agents/agent-defaults-service", () => ({ policyForRepo: vi.fn() }));
vi.mock("@/lib/agents/agent-repo-service", () => ({
    agentRepoByFullName: vi.fn(async () => null)
}));

import { handleAgentWebhook, isAgentWorkflowRun, mentions } from "@/lib/agents/agent-webhook";

function finished(path: string, conclusion: string) {
    return handleAgentWebhook({
        event: "workflow_run",
        appHandle: "polaris",
        payload: {
            repository: { full_name: "acme/app" },
            workflow_run: { id: 42, status: "completed", conclusion, path }
        }
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirst.mockResolvedValue({ id: "run-1", error: null, failureKind: null });
    mocks.finishAgentRun.mockResolvedValue(true);
});

describe("closing a run from workflow_run", () => {
    it("ignores another workflow in the repository finishing", async () => {
        await expect(
            finished(".github/workflows/extension-version.yml", "success")
        ).resolves.toEqual([]);
        expect(mocks.findFirst).not.toHaveBeenCalled();
        expect(mocks.finishAgentRun).not.toHaveBeenCalled();
    });

    it("closes the agent's own job with its real conclusion", async () => {
        await expect(finished(".github/workflows/polaris-agent.yml", "failure")).resolves.toEqual([
            "run-1"
        ]);
        expect(mocks.finishAgentRun).toHaveBeenCalledWith(
            "run-1",
            expect.objectContaining({ state: "failed" })
        );

        await finished(".github/workflows/polaris-agent.yml", "success");
        expect(mocks.finishAgentRun).toHaveBeenLastCalledWith(
            "run-1",
            expect.objectContaining({ state: "succeeded" })
        );
    });

    it("recognises the workflow file with or without a ref", () => {
        expect(
            isAgentWorkflowRun({ path: ".github/workflows/polaris-agent.yml@refs/heads/main" })
        ).toBe(true);
        expect(isAgentWorkflowRun({ path: ".github/workflows/ci.yml" })).toBe(false);
        expect(isAgentWorkflowRun(undefined)).toBe(false);
    });
});

describe("mentions", () => {
    it("answers somebody addressing the app", () => {
        expect(mentions("@polaris can you look at this?", "polaris")).toBe(true);
        expect(mentions("thanks @Polaris.", "polaris")).toBe(true);
    });

    it("does not read a package scope, a team, or code as a mention", () => {
        expect(mentions("they use `Select` from `@polaris/ui`", "polaris")).toBe(false);
        expect(mentions("imports @polaris/ui directly", "polaris")).toBe(false);
        expect(mentions('```ts\nimport x from "@polaris";\n```', "polaris")).toBe(false);
        expect(mentions("cc @polaris-agent-docs", "polaris-agent")).toBe(false);
    });
});

describe("the bell", () => {
    it("rings for a failure and stays quiet for a success by default", () => {
        expect(resolveRule({}, "agent.run").inapp).toBe(true);
        expect(resolveRule({}, "agent.run.succeeded").inapp).toBe(false);
    });

    it("keeps a rule saved under the old id on the failures", () => {
        const saved = { "agent.run": { inapp: false, email: true, destinations: [] } };
        expect(resolveRule(saved, "agent.run")).toMatchObject({ inapp: false, email: true });
    });
});
