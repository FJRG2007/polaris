/**
 * How far a swipe (or a step) moves each phone view.
 *
 * What is pinned:
 * - the schedule moves by its window, so the next page starts where the last
 *   one ended;
 * - day moves a day, 3 days three, week seven, month a month;
 * - a left flick goes forward and a right one back, and a slow or vertical
 *   one does not move at all (the rule swipe-step.ts applies to every view).
 */

import { describe, expect, it } from "vitest";
import { LIST_DAYS, viewWindow } from "@polaris-app/calendar/src/screens/time";
import { phoneStep, PHONE_DAYS } from "@polaris-app/calendar/src/screens/phone-view";
import { SWIPE_DISTANCE, swipeDirection } from "@polaris-app/calendar/src/screens/swipe-step";

const ANCHOR = "2026-11-27";

describe("phoneStep", () => {
    it("moves the schedule by its whole window", () => {
        const next = phoneStep("list", ANCHOR, 1);
        expect(next).toBe(viewWindow("list", ANCHOR, 1, PHONE_DAYS).end);
        expect(viewWindow("list", ANCHOR, 1, PHONE_DAYS).end).toBe("2026-12-27");
        expect(LIST_DAYS).toBe(30);
        expect(phoneStep("list", next, -1)).toBe(ANCHOR);
    });

    it("moves each time view by what it shows", () => {
        expect(phoneStep("day", ANCHOR, 1)).toBe("2026-11-28");
        expect(phoneStep("day", ANCHOR, -1)).toBe("2026-11-26");
        expect(phoneStep("days", ANCHOR, 1)).toBe("2026-11-30");
        expect(phoneStep("days", ANCHOR, -1)).toBe("2026-11-24");
        expect(phoneStep("week", ANCHOR, 1)).toBe("2026-12-04");
    });

    it("moves the month by a month, across a year", () => {
        expect(phoneStep("month", "2026-12-15", 1)).toBe("2027-01-15");
        expect(phoneStep("month", "2026-01-31", 1).slice(0, 7)).toBe("2026-02");
    });

    it("lets the 3-day window follow the step with no gap or overlap", () => {
        const first = viewWindow("days", ANCHOR, 1, PHONE_DAYS);
        const second = viewWindow("days", phoneStep("days", ANCHOR, 1), 1, PHONE_DAYS);
        expect(second.start).toBe(first.end);
    });
});

describe("swipe direction on a phone view", () => {
    it("flicks forward on a left move and back on a right one", () => {
        expect(swipeDirection(-SWIPE_DISTANCE - 10, 5, 200)).toBe(1);
        expect(swipeDirection(SWIPE_DISTANCE + 10, 5, 200)).toBe(-1);
    });

    it("leaves a vertical scroll of the schedule alone", () => {
        expect(swipeDirection(-SWIPE_DISTANCE - 10, 300, 200)).toBeNull();
        expect(swipeDirection(-SWIPE_DISTANCE - 10, 5, 2000)).toBeNull();
    });
});
