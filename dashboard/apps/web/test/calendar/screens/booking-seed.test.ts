/**
 * A booking page started from the calendar's card: the link carries a title
 * and the time picked, the page reads it strictly, and the new page is open on
 * that weekday for those hours only.
 */

import { describe, expect, it } from "vitest";
import { newDraft, seededDraft, seedOf } from "@polaris-app/calendar/src/screens/booking/model";

describe("the seed a booking link carries", () => {
    it("reads a title, a day and a range", () => {
        expect(
            seedOf({ title: " Office hours ", day: "2026-10-05", from: "10:00", to: "12:30" })
        ).toEqual({ title: "Office hours", day: "2026-10-05", from: "10:00", to: "12:30" });
    });

    it("drops what is malformed rather than guessing", () => {
        expect(seedOf({ day: "2026-13-40", from: "25:00", to: "26:00" })).toEqual({
            title: "",
            day: null,
            from: null,
            to: null
        });
        expect(seedOf({ day: "2026-10-05", from: "12:00", to: "09:00" })).toMatchObject({
            from: null,
            to: null
        });
        expect(seedOf({ title: ["a", "b"] }).title).toBe("a");
        expect(seedOf({ title: "x".repeat(400) }).title).toHaveLength(200);
    });
});

describe("a page started from the seed", () => {
    const blank = newDraft("Europe/Madrid", "cal-1");

    it("is open on the weekday picked for the hours picked, and nowhere else", () => {
        // 2026-10-07 is a Wednesday.
        const draft = seededDraft(blank, {
            title: "Office hours",
            day: "2026-10-07",
            from: "10:00",
            to: "12:00"
        });
        expect(draft.title).toBe("Office hours");
        expect(draft.availability.weekly["3"]).toEqual([{ from: "10:00", to: "12:00" }]);
        for (const day of ["0", "1", "2", "4", "5", "6"] as const)
            expect(draft.availability.weekly[day]).toEqual([]);
        expect(draft.durationMinutes).toBe(30);
    });

    it("keeps meetings within a range shorter than one", () => {
        const draft = seededDraft(blank, {
            title: "",
            day: "2026-10-07",
            from: "10:00",
            to: "10:15"
        });
        expect(draft.durationMinutes).toBe(15);
        expect(draft.slotMinutes).toBe(15);
        expect(draft.title).toBe("");
    });

    it("keeps the usual week when only a day was picked", () => {
        const draft = seededDraft(blank, {
            title: "Clinic",
            day: "2026-10-07",
            from: null,
            to: null
        });
        expect(draft.availability).toEqual(blank.availability);
        expect(draft.title).toBe("Clinic");
    });
});
