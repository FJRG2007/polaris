/**
 * What a service's card says it is doing, apart from how its last deploy went.
 *
 * The bug this pins: a service stopped weeks ago read "running" on its card,
 * because the card showed the status of the deployment it points at - and that
 * row says "running" for as long as the release is the current one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const deploymentFindMany = vi.fn();
const sampleGroupBy = vi.fn();
const appFindMany = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        deployment: { findMany: deploymentFindMany },
        metricSample: { groupBy: sampleGroupBy },
        application: { findMany: appFindMany }
    }
}));

const { deployOutcome, serviceRunState, RECENT_SAMPLE_MS } = await import("@/lib/deploy/run-state");
const { serviceRunStates } = await import("@/lib/deploy/run-states");

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const base = {
    deployStatus: "running",
    desiredState: "running",
    asleep: false,
    releasedAt: new Date(NOW - 3_600_000),
    lastSampleAt: new Date(NOW - 30_000),
    collectorAlive: true,
    now: NOW
};

describe("serviceRunState", () => {
    it("says stopped for a service somebody stopped, whatever its release row says", () => {
        expect(serviceRunState({ ...base, desiredState: "stopped", lastSampleAt: null })).toBe("stopped");
    });

    it("says sleeping for one put to sleep for being idle", () => {
        expect(serviceRunState({ ...base, asleep: true, lastSampleAt: null })).toBe("sleeping");
    });

    it("says running while it is seen running", () => {
        expect(serviceRunState(base)).toBe("running");
    });

    it("says crashed when it should be up and has not been seen for a few minutes", () => {
        expect(serviceRunState({ ...base, lastSampleAt: new Date(NOW - RECENT_SAMPLE_MS - 1) })).toBe("crashed");
        expect(serviceRunState({ ...base, lastSampleAt: null })).toBe("crashed");
    });

    it("does not call a release that just started crashed before its first sample", () => {
        expect(serviceRunState({ ...base, lastSampleAt: null, releasedAt: new Date(NOW - 60_000) })).toBe("running");
    });

    it("does not read a collector that never ran as evidence of anything", () => {
        expect(serviceRunState({ ...base, lastSampleAt: null, collectorAlive: false })).toBe("running");
    });

    it("lets a deploy in flight win, and knows a never-deployed service", () => {
        expect(serviceRunState({ ...base, deployStatus: "deploying", desiredState: "stopped" })).toBe("deploying");
        expect(serviceRunState({ ...base, deployStatus: null })).toBe("never");
        expect(serviceRunState({ ...base, deployStatus: "failed" })).toBe("failed");
    });
});

describe("deployOutcome", () => {
    it("reads a finished release as succeeded, never as running", () => {
        expect(deployOutcome("running")).toBe("succeeded");
        expect(deployOutcome("success")).toBe("succeeded");
        expect(deployOutcome("rolled_back")).toBe("failed");
        expect(deployOutcome("deploying")).toBe("deploying");
    });
});

describe("serviceRunStates", () => {
    beforeEach(() => {
        deploymentFindMany.mockReset().mockResolvedValue([{ id: "rel-1", finishedAt: new Date(NOW - 3_600_000) }]);
        sampleGroupBy.mockReset().mockResolvedValue([]);
        appFindMany.mockReset().mockResolvedValue([
            placed("web"),
            placed("api"),
            placed("remote", { kind: "server", hostId: "host-1" }),
            placed("stack", {}, "compose"),
            placed("swarmed", { runtime: "swarm" })
        ]);
    });

    function placed(id: string, target: Record<string, unknown> = {}, sourceType = "nixpacks") {
        return { id, sourceType, target: { kind: "local", hostId: null, runtime: "compose", ...target } };
    }

    const up = (id: string) => ({ id, desiredState: "running", asleepSince: null, currentDeploymentId: "rel-1" });

    it("reads the portfolio case: stopped, release row still running, no container", async () => {
        const states = await serviceRunStates(
            [{ id: "portfolio", desiredState: "stopped", asleepSince: null, currentDeploymentId: "rel-1" }],
            { portfolio: "running" },
            NOW
        );
        expect(states.portfolio).toBe("stopped");
    });

    it("asks three bounded questions for the whole board", async () => {
        sampleGroupBy.mockResolvedValue([{ subjectId: "web", _max: { ts: new Date(NOW - 5_000) } }]);
        const states = await serviceRunStates(
            [
                { id: "web", desiredState: "running", asleepSince: null, currentDeploymentId: "rel-1" },
                { id: "api", desiredState: "running", asleepSince: null, currentDeploymentId: "rel-1" }
            ],
            { web: "running", api: "running" },
            NOW
        );
        expect(states).toEqual({ web: "running", api: "crashed" });
        expect(sampleGroupBy).toHaveBeenCalledTimes(1);
        expect(appFindMany).toHaveBeenCalledTimes(1);
        expect(sampleGroupBy.mock.calls[0]?.[0].where.ts.gte).toEqual(new Date(NOW - RECENT_SAMPLE_MS));
        expect(deploymentFindMany).toHaveBeenCalledTimes(1);
    });

    it("does not call a service crashed because a different machine was sampled", async () => {
        sampleGroupBy.mockResolvedValue([{ subjectId: "web", _max: { ts: new Date(NOW - 5_000) } }]);
        const states = await serviceRunStates([up("web"), up("remote")], { web: "running", remote: "running" }, NOW);
        expect(states).toEqual({ web: "running", remote: "running" });
    });

    it("does not read an absent sample of a compose stack or a swarm task as a crash", async () => {
        sampleGroupBy.mockResolvedValue([{ subjectId: "web", _max: { ts: new Date(NOW - 5_000) } }]);
        const states = await serviceRunStates(
            [up("stack"), up("swarmed")],
            { stack: "running", swarmed: "running" },
            NOW
        );
        expect(states).toEqual({ stack: "running", swarmed: "running" });
    });
});
