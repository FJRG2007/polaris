/**
 * When Polaris runs its own scheduled work.
 *
 * The job bodies belong to the services that own them; what lives here is the
 * timing, and the two guards that keep it honest - a job is not started while it
 * is still running, and its clock starts again when it finishes rather than when
 * it began. Get the second one wrong and a pass that overruns its own cadence
 * runs back to back forever.
 *
 * The schedule starts once per process by design, so the tick is one sequential
 * story rather than a set of independent cases: the clock carries from each
 * assertion to the next, as it does in a running server.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runJobBody = vi.fn(async (job: { key: string }) => `${job.key} done`);

vi.mock("../../src/lib/cron/jobs", () => ({
    runJobBody: (job: { key: string }) => runJobBody(job),
    SCHEDULED_JOBS: [
        { key: "fast", everyMs: 60_000, leaseMs: null, run: async () => "fast" },
        { key: "slow", everyMs: 600_000, leaseMs: null, run: async () => "slow" },
        { key: "on-demand", everyMs: 24 * 60 * 60_000, leaseMs: null, run: async () => "on demand" }
    ]
}));

const { runScheduledJob, startScheduledWork } = await import("../../src/lib/cron/scheduler");

/** How many times each job has been started so far. */
function starts(key: string): number {
    return runJobBody.mock.calls.filter(([job]) => job.key === key).length;
}

/** A job body that does not finish until it is let go. */
function held(): () => void {
    let release = (): void => {};
    runJobBody.mockImplementationOnce(
        async () => new Promise<string>((resolve) => (release = () => resolve("held")))
    );
    return () => release();
}

describe("turning the schedule off", () => {
    it("starts nothing at all when POLARIS_CRON is off", async () => {
        vi.useFakeTimers();
        process.env.POLARIS_CRON = "off";
        startScheduledWork();
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(runJobBody).not.toHaveBeenCalled();
        delete process.env.POLARIS_CRON;
        vi.useRealTimers();
    });
});

describe("running one job on demand", () => {
    beforeEach(() => {
        runJobBody.mockClear();
    });

    it("runs it and hands back what it returned", async () => {
        await expect(runScheduledJob("on-demand")).resolves.toBe("on-demand done");
    });

    it("says so rather than guessing when there is no such job", async () => {
        await expect(runScheduledJob("nonsense")).rejects.toThrow("nonsense");
    });

    it("stands down when that job is already running here", async () => {
        const release = held();
        const first = runScheduledJob("on-demand");
        // The external trigger and the internal tick share this guard, which is
        // what stops an operator's own crontab doubling up with the schedule.
        await expect(runScheduledJob("on-demand")).resolves.toBeNull();
        release();
        await expect(first).resolves.toBe("held");
        expect(starts("on-demand")).toBe(1);
    });
});

describe("the tick", () => {
    beforeAll(() => {
        vi.useFakeTimers();
        runJobBody.mockClear();
        startScheduledWork();
    });

    afterAll(() => {
        vi.useRealTimers();
    });

    it("waits out boot before the first pass", async () => {
        await vi.advanceTimersByTimeAsync(30_000);
        expect(runJobBody).not.toHaveBeenCalled();
    });

    it("then runs everything that is due", async () => {
        await vi.advanceTimersByTimeAsync(20_000);
        expect(starts("fast")).toBe(1);
        expect(starts("slow")).toBe(1);
    });

    it("leaves a job alone until its own cadence has come round", async () => {
        // The tick is a minute and the slow job asks for ten, so several minutes
        // on the fast one has gone again and again and the slow one has not.
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(starts("fast")).toBeGreaterThanOrEqual(4);
        expect(starts("slow")).toBe(1);

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(starts("slow")).toBe(2);
    });

    it("does not start a pass again the instant a slow one returns", async () => {
        const before = starts("fast");
        const release = held();

        // The next fast pass takes four minutes, four times its own cadence, and
        // no second one is started while it is in there.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(starts("fast")).toBe(before + 1);
        await vi.advanceTimersByTimeAsync(4 * 60_000);
        expect(starts("fast")).toBe(before + 1);

        release();
        await vi.advanceTimersByTimeAsync(0);
        // Its clock restarted when it finished, so it is not due again yet - the
        // four minutes it spent inside do not count towards the next minute.
        expect(starts("fast")).toBe(before + 1);
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(starts("fast")).toBeGreaterThan(before + 1);
    });

    it("keeps ticking after a pass throws", async () => {
        const before = starts("fast");
        runJobBody.mockRejectedValueOnce(new Error("the archive failed"));

        await vi.advanceTimersByTimeAsync(60_000);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(starts("fast")).toBe(before + 2);
    });
});
