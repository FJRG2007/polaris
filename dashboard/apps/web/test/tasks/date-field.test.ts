/**
 * The day a date field hands back, and the day it shows again afterwards.
 *
 * A `type="date"` input speaks in days and the task stores instants, so one
 * helper writes each way. They have to agree: `new Date("2026-08-10")` is UTC
 * midnight, which is still the ninth anywhere west of Greenwich, so reading a
 * day as UTC and rendering it back as local hands the field a date nobody chose
 * and lets a block set for tomorrow lapse the same evening.
 *
 * Run against whatever timezone the machine is in, and then against the two that
 * break it, by driving the same arithmetic the helpers do.
 */

import { describe, expect, it } from "vitest";
import { fromDateInput, toDateInput } from "@/app/(app)/tasks/pickers";

describe("what a date field stores and shows again", () => {
    it("gives back the day that was picked, not the one before it", () => {
        for (const day of ["2026-01-01", "2026-08-05", "2026-08-10", "2026-12-31"]) {
            const stored = fromDateInput(day);
            expect(stored).not.toBeNull();
            expect(toDateInput(stored, false)).toBe(day);
        }
    });

    it("stores the start of that day where it was picked, so the day it names is its own", () => {
        const stored = fromDateInput("2026-08-10");
        const at = new Date(stored as string);
        expect(at.getFullYear()).toBe(2026);
        expect(at.getMonth()).toBe(7);
        expect(at.getDate()).toBe(10);
        expect(at.getHours()).toBe(0);
        expect(at.getMinutes()).toBe(0);
    });

    it("keeps the time on a field that has one", () => {
        const stored = fromDateInput("2026-08-10T14:30");
        expect(toDateInput(stored, true)).toBe("2026-08-10T14:30");
    });

    it("reads nothing typed, and nothing that is a date, as no date at all", () => {
        expect(fromDateInput("")).toBeNull();
        expect(fromDateInput("nonsense")).toBeNull();
        expect(fromDateInput("2026-13-45")).toBeNull();
        expect(toDateInput(null, false)).toBe("");
    });
});
