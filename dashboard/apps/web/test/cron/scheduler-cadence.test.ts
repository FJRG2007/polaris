/**
 * Whether a job runs as often as it asks to.
 *
 * A pass always finishes a little after the tick that started it, so a job that
 * asks for every minute must still be due a minute later, not two. And a job that
 * asks for less than a tick - waking a sleeping service while its visitor waits -
 * has to be looked at more often than the tick, without two of its passes ever
 * running at once.
 *
 * Its own file because the schedule starts once per process, and this is a
 * different table from the one the other scheduler tests run.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { runJobBody, gates } = vi.hoisted(() => {
    const gates = new Map<string, Promise<void>>();
    const runJobBody = vi.fn(async (job: { key: string }) => {
        // Every minute pass takes five seconds, the way a real one takes a while.
        if (job.key === "minute") await new Promise((resolve) => setTimeout(resolve, 5_000));
        await gates.get(job.key);
        return `${job.key} done`;
    });
    return { runJobBody, gates };
});

vi.mock("../../src/lib/cron/jobs", () => ({
    runJobBody: (job: { key: string }) => runJobBody(job),
    SCHEDULED_JOBS: [
        { key: "minute", everyMs: 60_000, leaseMs: null, run: async () => "minute" },
        { key: "wake", everyMs: 15_000, leaseMs: null, run: async () => "wake" }
    ]
}));

const { startScheduledWork } = await import("../../src/lib/cron/scheduler");

function starts(key: string): number {
    return runJobBody.mock.calls.filter(([job]) => job.key === key).length;
}

describe("the cadence a job asked for", () => {
    beforeAll(() => {
        vi.useFakeTimers();
        startScheduledWork();
    });

    afterAll(() => {
        vi.useRealTimers();
    });

    it("runs a minute job every minute even though each pass takes seconds", async () => {
        // Boot is waited out, then the first pass; the tick a few seconds after it
        // is too soon, and from then on it is every tick.
        await vi.advanceTimersByTimeAsync(125_000);
        const before = starts("minute");
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(starts("minute")).toBe(before + 5);
    });

    it("looks at a job that asks for fifteen seconds every fifteen seconds", async () => {
        const before = starts("wake");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(starts("wake")).toBe(before + 4);
    });

    it("never starts a second pass of it while one is still running", async () => {
        let release = (): void => {};
        gates.set("wake", new Promise<void>((resolve) => (release = resolve)));
        await vi.advanceTimersByTimeAsync(15_000);
        const during = starts("wake");
        await vi.advanceTimersByTimeAsync(45_000);
        expect(starts("wake")).toBe(during);

        gates.delete("wake");
        release();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(starts("wake")).toBe(during + 1);
    });
});
