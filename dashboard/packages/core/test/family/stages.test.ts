/**
 * Which stage a birth month puts somebody in, when they move next, and when a
 * guardian may hold that move back. The cases that matter are the edges: the
 * month of the birthday, February 29, the turn of the year, and dates that
 * cannot be anybody's.
 */

import * as minors from "../../src/minors";
import { describe, expect, it } from "vitest";

const day = (value: string) => minors.parseCalendarDate(value) as minors.CalendarDate;

describe("age, month-precise", () => {
    it("counts the birthday from the 1st of the birth month", () => {
        expect(minors.ageOn("2014-06", day("2027-05-31"))).toBe(12);
        expect(minors.ageOn("2014-06", day("2027-06-01"))).toBe(13);
        expect(minors.ageOn("2014-06", day("2027-06-30"))).toBe(13);
    });

    it("crosses the year end without an off-by-one", () => {
        expect(minors.ageOn("2010-12", day("2023-11-30"))).toBe(12);
        expect(minors.ageOn("2010-12", day("2023-12-01"))).toBe(13);
        expect(minors.ageOn("2011-01", day("2023-12-31"))).toBe(12);
        expect(minors.ageOn("2011-01", day("2024-01-01"))).toBe(13);
    });

    it("reads February 29 like any day of February", () => {
        expect(minors.ageOn("2012-02", day("2024-02-29"))).toBe(12);
        expect(minors.ageOn("2012-03", day("2024-02-29"))).toBe(11);
        expect(minors.parseCalendarDate("2023-02-29")).toBeNull();
        expect(minors.parseCalendarDate("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    });

    it("is zero in the birth month itself", () => {
        expect(minors.ageOn("2026-11", day("2026-11-07"))).toBe(0);
    });

    it("refuses a future month, a month over 120 years ago, and a malformed one", () => {
        const today = day("2026-11-07");
        expect(minors.birthMonthIssue("2026-12", today)).toBe("future");
        expect(minors.birthMonthIssue("1905-11", today)).toBe("tooOld");
        expect(minors.birthMonthIssue("1906-10", today)).toBeNull();
        expect(minors.birthMonthIssue("2026-13", today)).toBe("invalid");
        expect(minors.birthMonthIssue("2026-1", today)).toBe("invalid");
        expect(minors.birthMonthIssue("", today)).toBe("invalid");
        expect(() => minors.ageOn("2026-12", today)).toThrow(RangeError);
    });
});

describe("the day, in the instance's time zone", () => {
    it("is the local calendar date, not the server's UTC one", () => {
        const instant = new Date("2027-05-31T23:30:00Z");
        expect(minors.calendarDateIn(instant)).toEqual({ year: 2027, month: 5, day: 31 });
        expect(minors.calendarDateIn(instant, "Europe/Madrid")).toEqual({ year: 2027, month: 6, day: 1 });
        expect(minors.calendarDateIn(instant, "America/Los_Angeles")).toEqual({ year: 2027, month: 5, day: 31 });
    });

    it("moves a stage on the local 1st", () => {
        const instant = new Date("2027-05-31T23:30:00Z");
        expect(minors.stageFor("2014-06", minors.calendarDateIn(instant))).toBe("preteen");
        expect(minors.stageFor("2014-06", minors.calendarDateIn(instant, "Europe/Madrid"))).toBe("teen");
    });
});

describe("stages", () => {
    const cases: [number, minors.StageOrAdult][] = [
        [0, "baby"],
        [3, "baby"],
        [4, "child"],
        [8, "child"],
        [9, "preteen"],
        [12, "preteen"],
        [13, "teen"],
        [15, "teen"],
        [16, "olderTeen"],
        [17, "olderTeen"],
        [18, "adult"],
        [40, "adult"]
    ];
    it.each(cases)("age %i is %s", (age, stage) => {
        expect(minors.stageForAge(age)).toBe(stage);
    });

    it("follows D1 exactly", () => {
        expect(minors.STAGE_START_AGE).toEqual({ baby: 0, child: 4, preteen: 9, teen: 13, olderTeen: 16 });
        expect(minors.MAJORITY_AGE).toBe(18);
        expect(minors.DEFAULT_DIGITAL_CONSENT_AGE).toBe(14);
    });

    it("orders stages, adult last", () => {
        expect(minors.nextMinorStage("baby")).toBe("child");
        expect(minors.nextMinorStage("olderTeen")).toBe("adult");
        expect(minors.isLaterStage("teen", "preteen")).toBe(true);
        expect(minors.isLaterStage("adult", "olderTeen")).toBe(true);
        expect(minors.isLaterStage("child", "child")).toBe(false);
    });
});

describe("the next move", () => {
    it("is the next stage, on the 1st of the birth month", () => {
        expect(minors.nextStageChange("2014-06", day("2026-11-07"))).toEqual({
            stage: "teen",
            on: { year: 2027, month: 6, day: 1 }
        });
    });

    it("is majority from the last stage, and nothing for an adult", () => {
        expect(minors.nextStageChange("2010-01", day("2026-11-07"))).toEqual({
            stage: "adult",
            on: { year: 2028, month: 1, day: 1 }
        });
        expect(minors.nextStageChange("2000-01", day("2026-11-07"))).toBeNull();
    });
});

describe("holding a move back (D5)", () => {
    const base = {
        to: "teen" as const,
        dueOn: day("2027-06-01"),
        alreadyDelayed: false,
        birthMonth: "2014-06"
    };

    it("allows up to 90 days, once per stage", () => {
        expect(minors.delayRefusal({ ...base, until: day("2027-08-30") })).toBeNull();
        expect(minors.delayRefusal({ ...base, until: day("2027-08-31") })).toBe("tooLong");
        expect(minors.delayRefusal({ ...base, until: day("2027-07-01"), alreadyDelayed: true })).toBe(
            "alreadyDelayed"
        );
    });

    it("refuses a day that is not later than the move", () => {
        expect(minors.delayRefusal({ ...base, until: day("2027-06-01") })).toBe("notLater");
        expect(minors.delayRefusal({ ...base, until: day("2027-05-01") })).toBe("notLater");
    });

    it("never delays majority", () => {
        expect(
            minors.delayRefusal({ ...base, to: "adult", dueOn: day("2032-06-01"), until: day("2032-07-01") })
        ).toBe("majority");
    });

    it("never pushes a stage onto the majority day", () => {
        expect(
            minors.delayRefusal({
                ...base,
                to: "olderTeen",
                birthMonth: "2014-06",
                dueOn: day("2032-04-01"),
                until: day("2032-06-01")
            })
        ).toBe("pastMajority");
    });

    it("counts days across a leap February", () => {
        expect(minors.calendarDaysBetween(day("2028-02-01"), day("2028-03-01"))).toBe(29);
        expect(minors.calendarDaysBetween(day("2027-02-01"), day("2027-03-01"))).toBe(28);
    });
});
