/**
 * Pausing automatic runs: the stored pause, what it stops, and the dispatch
 * refusing a webhook run while a manual one still starts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("@/lib/setting-store", () => ({
    getSetting: vi.fn(async (key: string) => store.get(key) ?? null),
    setSetting: vi.fn(async (key: string, value: string | null) => {
        if (value === null) store.delete(key);
        else store.set(key, value);
    })
}));

const created: string[] = [];
vi.mock("@polaris/db", () => ({ prisma: { agentRepo: { update: vi.fn(async () => ({})) } } }));
vi.mock("@/lib/domain-service", () => ({
    appBaseUrl: vi.fn(async () => "https://polaris.example")
}));
vi.mock("@/lib/github-service", () => ({ githubAppInstallationToken: vi.fn(async () => "token") }));
vi.mock("@/lib/agents/agent-server-executor", () => ({
    startServerRun: vi.fn(async () => undefined)
}));
vi.mock("@/lib/agents/agent-usage-limits", () => ({
    checkUsageLimits: vi.fn(async () => ({ allowed: true }))
}));
vi.mock("@/lib/agents/agent-run-service", () => ({
    createAgentRun: vi.fn(async () => {
        created.push("run");
        return { id: `run-${created.length}`, token: "t" };
    }),
    finishAgentRun: vi.fn(async () => true)
}));
vi.mock("@/lib/agents/agent-workflow", () => ({
    AGENT_WORKFLOW_PATH: ".github/workflows/polaris-agent.yml",
    installWorkflow: vi.fn(),
    renderWorkflow: vi.fn(),
    resolveRunsOn: vi.fn(),
    TIMEOUT_MINUTES: 60
}));

import * as pause from "@/lib/agents/agent-pause";
import { dispatchRun } from "@/lib/agents/agent-dispatch";

const repo = {
    id: "repo-1",
    ownerId: "owner-1",
    repoFullName: "acme/app",
    execution: "server",
    poolId: null,
    model: "anthropic/claude",
    installationId: "1"
};

beforeEach(() => {
    store.clear();
    created.length = 0;
});

describe("the stored pause", () => {
    it("is absent until somebody pauses, and gone again on resume", async () => {
        expect(await pause.readAgentPause("owner-1")).toBeNull();
        await pause.pauseAgentRuns("owner-1", "manual", new Date("2026-11-06T12:00:00Z"));
        expect(await pause.readAgentPause("owner-1")).toEqual({
            reason: "manual",
            since: "2026-11-06T12:00:00.000Z"
        });
        expect(await pause.readAgentPause("owner-2")).toBeNull();
        await pause.resumeAgentRuns("owner-1");
        expect(await pause.readAgentPause("owner-1")).toBeNull();
    });

    it("keeps the first reason when paused again", async () => {
        await pause.pauseAgentRuns("owner-1", "credits");
        await pause.pauseAgentRuns("owner-1", "manual");
        expect((await pause.readAgentPause("owner-1"))?.reason).toBe("credits");
    });

    it("reads a value it cannot parse as no pause", async () => {
        store.set("agents.pause.owner-1", "{not json");
        expect(await pause.readAgentPause("owner-1")).toBeNull();
        store.set("agents.pause.owner-1", JSON.stringify({ reason: "other", since: "x" }));
        expect(await pause.readAgentPause("owner-1")).toBeNull();
    });

    it("stops everything but a manual start", () => {
        expect(pause.pauseStops("manual")).toBe(false);
        for (const trigger of ["mention", "pr.opened", "issue.opened", "ci.failed"] as const) {
            expect(pause.pauseStops(trigger)).toBe(true);
        }
    });
});

describe("dispatch while paused", () => {
    it("opens no run for a webhook trigger", async () => {
        await pause.pauseAgentRuns("owner-1", "credits");
        const result = await dispatchRun({ repo, trigger: "pr.opened", prompt: "A pull request" });
        expect(result).toEqual({ error: "Automatic runs are paused." });
        expect(created).toHaveLength(0);
    });

    it("still starts a run somebody asked for by hand", async () => {
        await pause.pauseAgentRuns("owner-1", "manual");
        const result = await dispatchRun({
            repo,
            trigger: "manual",
            prompt: "Fix it",
            startedById: "owner-1"
        });
        expect(result.runId).toBeDefined();
        expect(created).toHaveLength(1);
    });

    it("starts webhook runs again after resume", async () => {
        await pause.pauseAgentRuns("owner-1", "manual");
        await pause.resumeAgentRuns("owner-1");
        const result = await dispatchRun({ repo, trigger: "pr.opened", prompt: "A pull request" });
        expect(result.runId).toBeDefined();
    });
});
