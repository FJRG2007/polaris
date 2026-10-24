/**
 * A console command run several times, a gap between runs.
 *
 * Pinned: the limits the dialog and the server share (count, shortest gap,
 * longest span); the first run goes at once and each next one a gap after the
 * last; Stop ends it between runs and inside a pause; a server stopped or
 * restarted ends every repeat on it and no other; and no more run at once than
 * the caps allow.
 */

import { english } from "../setup/game-english";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    MAX_REPEATS_PER_SERVER,
    repeatPlanProblem,
    repeatPlanSchema
} from "@polaris-app/game-servers/src/lib/console-repeat";
import {
    KEEP_ENDED_MS,
    endRepeatsOn,
    listRepeats,
    pause,
    resetRepeatsForTest,
    startRepeat,
    stopRepeat,
    type RepeatRun
} from "@polaris-app/game-servers/src/lib/console-repeat-jobs";

const SERVER = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER = "bbbbbbbb-1111-4111-8111-111111111111";

describe("the limits", () => {
    it("takes 2 to 100 runs", () => {
        expect(repeatPlanProblem({ times: 2, every: 1, unit: "seconds" })).toBeNull();
        expect(repeatPlanProblem({ times: 100, every: 1, unit: "seconds" })).toBeNull();
        expect(english(repeatPlanProblem({ times: 1, every: 1, unit: "seconds" }))).toBe(
            "Between 2 and 100 times"
        );
        expect(english(repeatPlanProblem({ times: 101, every: 1, unit: "seconds" }))).toBe(
            "Between 2 and 100 times"
        );
        expect(repeatPlanProblem({ times: 2.5, every: 1, unit: "seconds" })).not.toBeNull();
        expect(repeatPlanProblem({ times: Number.NaN, every: 1, unit: "seconds" })).not.toBeNull();
    });

    it("keeps runs at least a second apart", () => {
        expect(english(repeatPlanProblem({ times: 3, every: 0, unit: "seconds" }))).toBe(
            "At least 1 second apart"
        );
        expect(repeatPlanProblem({ times: 3, every: 1.5, unit: "seconds" })).not.toBeNull();
    });

    it("lasts six hours at most, first run to last", () => {
        // 100 runs 3 minutes apart is 4h57m; 5 minutes apart is 8h15m.
        expect(repeatPlanProblem({ times: 100, every: 3, unit: "minutes" })).toBeNull();
        expect(english(repeatPlanProblem({ times: 100, every: 5, unit: "minutes" }))).toBe(
            "A repeat can last 6 hours at most"
        );
        expect(repeatPlanProblem({ times: 2, every: 360, unit: "minutes" })).toBeNull();
        expect(repeatPlanProblem({ times: 2, every: 361, unit: "minutes" })).not.toBeNull();
    });

    it("refuses anything but the fields it knows", () => {
        expect(repeatPlanSchema.safeParse({ times: 3, every: 1, unit: "hours" }).success).toBe(
            false
        );
        expect(
            repeatPlanSchema.safeParse({ times: 3, every: 1, unit: "seconds", extra: 1 }).success
        ).toBe(false);
    });
});

describe("the timers", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        resetRepeatsForTest();
    });
    afterEach(() => {
        resetRepeatsForTest();
        vi.useRealTimers();
    });

    function start(run: RepeatRun, patch: { total?: number; gapMs?: number; server?: string } = {}) {
        return startRepeat({
            installedAppId: patch.server ?? SERVER,
            label: "Spawn piglin",
            command: "/execute at {player} run summon minecraft:piglin_brute ~4 ~ ~",
            total: patch.total ?? 3,
            gapMs: patch.gapMs ?? 5_000,
            startedBy: "Ada",
            run
        });
    }

    it("runs the first at once and each next one a gap later, then finishes", async () => {
        const runs: number[] = [];
        const view = start(async (run) => {
            runs.push(run);
            return { problem: null };
        });
        expect(view).not.toBeNull();
        await vi.advanceTimersByTimeAsync(0);
        expect(runs).toEqual([1]);
        expect(listRepeats(SERVER)[0]).toMatchObject({ done: 1, total: 3, ended: null });
        expect(listRepeats(SERVER)[0]?.nextAt).toBe(Date.now() + 5_000);

        await vi.advanceTimersByTimeAsync(4_999);
        expect(runs).toEqual([1]);
        await vi.advanceTimersByTimeAsync(1);
        expect(runs).toEqual([1, 2]);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(runs).toEqual([1, 2, 3]);
        expect(listRepeats(SERVER)[0]).toMatchObject({ done: 3, ended: "finished", nextAt: null });

        await vi.advanceTimersByTimeAsync(60_000);
        expect(runs).toEqual([1, 2, 3]);
        // Kept a minute to say how it ended, then gone.
        expect(listRepeats(SERVER)).toEqual([]);
    });

    it("keeps going past a run that went wrong, and says what it said", async () => {
        let calls = 0;
        start(async () => {
            calls += 1;
            if (calls === 1) throw new Error("Unknown command");
            return { problem: null };
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(listRepeats(SERVER)[0]).toMatchObject({ done: 1, lastProblem: "Unknown command" });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(listRepeats(SERVER)[0]).toMatchObject({ done: 2, lastProblem: null });
    });

    it("stops between runs, and no further run goes", async () => {
        const runs: number[] = [];
        const view = start(async (run) => {
            runs.push(run);
            return { problem: null };
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(stopRepeat(SERVER, view!.id)).toBe(true);
        expect(stopRepeat(SERVER, view!.id)).toBe(false);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(runs).toEqual([1]);
        expect(listRepeats(SERVER)[0]).toMatchObject({ ended: "stopped", nextAt: null });
    });

    it("is stopped only from its own server", async () => {
        const view = start(async () => ({ problem: null }));
        expect(stopRepeat(OTHER, view!.id)).toBe(false);
        expect(listRepeats(SERVER)[0]?.ended).toBeNull();
    });

    it("gives up a pause the moment it is stopped", async () => {
        let leftAt = 0;
        const view = start(async (_run, over) => {
            await pause(60_000, over);
            leftAt = Date.now();
            return { problem: null };
        });
        const began = Date.now();
        await vi.advanceTimersByTimeAsync(1_000);
        stopRepeat(SERVER, view!.id);
        await vi.advanceTimersByTimeAsync(500);
        expect(leftAt - began).toBeLessThan(2_000);
        expect(listRepeats(SERVER)[0]).toMatchObject({ done: 0, ended: "stopped" });
    });

    it("ends when a run says the server went away", async () => {
        let up = true;
        start(async () => (up ? { problem: null } : { end: "serverStopped" }));
        await vi.advanceTimersByTimeAsync(0);
        up = false;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(listRepeats(SERVER)[0]).toMatchObject({ done: 1, ended: "serverStopped" });
    });

    it("ends every repeat on a server that is stopped, and only there", async () => {
        start(async () => ({ problem: null }));
        start(async () => ({ problem: null }));
        start(async () => ({ problem: null }), { server: OTHER });
        expect(endRepeatsOn(SERVER)).toBe(2);
        expect(listRepeats(SERVER).map((one) => one.ended)).toEqual([
            "serverStopped",
            "serverStopped"
        ]);
        expect(listRepeats(OTHER)[0]?.ended).toBeNull();
    });

    it("runs no more at once on one server than the cap", async () => {
        for (let i = 0; i < MAX_REPEATS_PER_SERVER; i += 1) {
            expect(start(async () => ({ problem: null }))).not.toBeNull();
        }
        expect(start(async () => ({ problem: null }))).toBeNull();
        // Another server is not held back by this one.
        expect(start(async () => ({ problem: null }), { server: OTHER })).not.toBeNull();
        // One ended frees its place.
        stopRepeat(SERVER, listRepeats(SERVER)[0]!.id);
        expect(start(async () => ({ problem: null }))).not.toBeNull();
    });

    it("forgets an ended repeat after a while", async () => {
        const view = start(async () => ({ problem: null }));
        stopRepeat(SERVER, view!.id);
        await vi.advanceTimersByTimeAsync(KEEP_ENDED_MS);
        expect(listRepeats(SERVER)).toEqual([]);
    });
});
