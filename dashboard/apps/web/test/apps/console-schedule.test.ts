/**
 * When a scheduled console command runs.
 *
 * Pinned on the pure math: a moment fires once, on the first sweep at or after
 * it; a sweep that was a little late still runs it; moments that passed long
 * ago are counted and skipped, never queued; a counted schedule stops at its
 * count; and a stored list that cannot be read is dropped rather than run.
 */

import { describe, expect, it } from "vitest";
import {
    CONSOLE_SCHEDULES_KEY,
    advance,
    readConsoleSchedules,
    repeatProblem,
    startProblem,
    type ConsoleSchedule,
    type ScheduleRepeat
} from "@polaris-app/game-servers/src/lib/console-schedule";
import { english } from "../setup/game-english";

const START = "2026-10-11T12:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(START) + minutes * 60_000);

const schedule = (
    repeat: ScheduleRepeat,
    patch: Partial<ConsoleSchedule> = {}
): ConsoleSchedule => ({
    id: "11111111-1111-4111-8111-111111111111",
    commandId: "c1",
    label: "Horse",
    command: "say hi",
    variables: [],
    values: {},
    target: null,
    repeat,
    nextAt: START,
    done: 0,
    skipped: 0,
    last: null,
    createdBy: "u1",
    ...patch
});

describe("a schedule's next moment", () => {
    it("waits until its moment", () => {
        const before = schedule({ kind: "once" });
        expect(advance(before, at(-1))).toEqual({ fire: false, next: before });
    });

    it("runs once, then has nothing left", () => {
        const step = advance(schedule({ kind: "once" }), at(0));
        expect(step.fire).toBe(true);
        expect(step.next).toMatchObject({ nextAt: null, done: 1, skipped: 0 });
    });

    it("runs a moment the sweep reached a few minutes late", () => {
        expect(advance(schedule({ kind: "once" }), at(9)).fire).toBe(true);
    });

    it("skips a moment long gone, and says so", () => {
        const step = advance(schedule({ kind: "once" }), at(60));
        expect(step.fire).toBe(false);
        expect(step.next).toMatchObject({ nextAt: null, done: 1, skipped: 1 });
        expect(english(step.next.last?.detail)).toBe("Polaris was not running then");
    });

    it("repeats on its interval from the moment it was set for", () => {
        const step = advance(schedule({ kind: "every", minutes: 5 }), at(1));
        expect(step.fire).toBe(true);
        expect(step.next.nextAt).toBe(at(5).toISOString());
    });

    it("runs only the newest of the moments it missed, and counts the rest as skipped", () => {
        const step = advance(schedule({ kind: "every", minutes: 5 }), at(22));
        expect(step.fire).toBe(true);
        expect(step.next).toMatchObject({ done: 5, skipped: 4, nextAt: at(25).toISOString() });
    });

    it("stops at its count", () => {
        let current = schedule({ kind: "times", minutes: 10, times: 3 });
        const fired: boolean[] = [];
        for (const minute of [0, 10, 20]) {
            const step = advance(current, at(minute));
            fired.push(step.fire);
            current = step.next;
        }
        expect(fired).toEqual([true, true, true]);
        expect(current).toMatchObject({ done: 3, skipped: 0, nextAt: null });
        expect(advance(current, at(30)).fire).toBe(false);
    });

    it("never counts past its count, however late the sweep", () => {
        const step = advance(
            schedule(
                { kind: "times", minutes: 1, times: 4 },
                { done: 2, nextAt: at(2).toISOString() }
            ),
            at(500)
        );
        expect(step.fire).toBe(false);
        expect(step.next).toMatchObject({ done: 4, skipped: 2, nextAt: null });
    });
});

describe("what a schedule may be", () => {
    it("repeats every minute at the finest and every week at the most", () => {
        expect(repeatProblem({ kind: "every", minutes: 1 })).toBeNull();
        expect(english(repeatProblem({ kind: "every", minutes: 0 }))).toBe(
            "Repeat every 1 minute to 7 days"
        );
        expect(english(repeatProblem({ kind: "every", minutes: 7 * 24 * 60 + 1 }))).toBe(
            "Repeat every 1 minute to 7 days"
        );
        expect(english(repeatProblem({ kind: "times", minutes: 5, times: 1 }))).toBe(
            "Between 2 and 1000 times"
        );
    });

    it("starts now or later, within a year", () => {
        expect(startProblem(at(-0.5), at(0))).toBeNull();
        expect(english(startProblem(at(-5), at(0)))).toBe("That time has passed");
        expect(english(startProblem(new Date(Date.parse(START) + 400 * 86_400_000), at(0)))).toBe(
            "Pick a time within a year"
        );
        expect(english(startProblem(new Date("nonsense"), at(0)))).toBe("Pick when it runs");
    });
});

describe("the stored list", () => {
    it("reads back what was written and drops what it cannot run", () => {
        const kept = schedule(
            { kind: "every", minutes: 5 },
            { target: { every: true }, values: { amount: "3" } }
        );
        const read = readConsoleSchedules({
            [CONSOLE_SCHEDULES_KEY]: [
                kept,
                { ...kept, id: "x", repeat: { kind: "every", minutes: 0 } },
                { ...kept, id: "y", command: 5 },
                "nonsense"
            ]
        });
        expect(read).toEqual([kept]);
        expect(readConsoleSchedules({})).toEqual([]);
    });
});
