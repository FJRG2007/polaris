/**
 * Cron schedules fire when the person who wrote them meant.
 *
 * The cases are the ones that go wrong in real schedulers: steps and ranges,
 * names, the two day fields combining with OR, Sunday written as 7, and a
 * daily job across a clock change in a real time zone.
 */

import { describe, expect, it } from "vitest";
import { CronError, cronExpression, describeCron, nextCronRun, parseCron } from "./cron.js";

const next = (expression: string, after: string, zone = "UTC") =>
    nextCronRun(parseCron(expression), new Date(after), zone)?.toISOString() ?? null;

describe("reading an expression", () => {
    it("reads lists, ranges, steps and names", () => {
        const schedule = parseCron("*/15 9-17 * JAN,JUL MON-FRI");
        expect([...schedule.minutes]).toEqual([0, 15, 30, 45]);
        expect([...schedule.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
        expect([...schedule.months]).toEqual([1, 7]);
        expect([...schedule.weekdays]).toEqual([1, 2, 3, 4, 5]);
    });

    it("takes 7 as Sunday, and the shorthands", () => {
        expect([...parseCron("0 0 * * 7").weekdays]).toEqual([0]);
        expect(next("@hourly", "2026-09-10T10:20:00Z")).toBe("2026-09-10T11:00:00.000Z");
    });

    it("says what is wrong rather than guessing", () => {
        for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "5-1 * * * *", "*/0 * * * *", "0 0 * FOO *"]) {
            expect(() => parseCron(bad), bad).toThrow(CronError);
        }
        expect(cronExpression.safeParse("0 9 * * *").success).toBe(true);
        expect(cronExpression.safeParse("0 9 * *").success).toBe(false);
    });
});

describe("when it next fires", () => {
    it("is strictly after the moment asked about", () => {
        expect(next("*/5 * * * *", "2026-09-10T10:05:00Z")).toBe("2026-09-10T10:10:00.000Z");
        expect(next("*/5 * * * *", "2026-09-10T10:05:30Z")).toBe("2026-09-10T10:10:00.000Z");
    });

    it("combines the two day fields with OR when both are set", () => {
        // 1st of the month OR a Monday. 2026-09-10 is a Thursday; the next
        // Monday is the 14th, which comes before October the 1st.
        expect(next("0 9 1 * MON", "2026-09-10T12:00:00Z")).toBe("2026-09-14T09:00:00.000Z");
    });

    it("keeps nine in the morning at nine across a clock change", () => {
        // Europe/Madrid leaves summer time on 2026-10-25: 09:00 is 07:00Z the
        // day before and 08:00Z the day after.
        expect(next("0 9 * * *", "2026-10-24T10:00:00Z", "Europe/Madrid")).toBe("2026-10-25T08:00:00.000Z");
        expect(next("0 9 * * *", "2026-10-23T10:00:00Z", "Europe/Madrid")).toBe("2026-10-24T07:00:00.000Z");
    });

    it("fires at midnight on the day after the clocks go forward", () => {
        // Europe/Madrid springs forward on Sunday 2026-03-29, a 23-hour day.
        // Monday's midnight is 22:00Z, not the following week.
        expect(next("0 0 * * MON", "2026-03-24T12:00:00Z", "Europe/Madrid")).toBe("2026-03-29T22:00:00.000Z");
        expect(next("@monthly", "2026-03-15T12:00:00Z", "Europe/Madrid")).toBe("2026-03-31T22:00:00.000Z");
        // America/New_York springs forward on Sunday 2026-03-08.
        expect(next("0 0 * * MON", "2026-03-03T12:00:00Z", "America/New_York")).toBe("2026-03-09T04:00:00.000Z");
    });

    it("skips a time the clocks jump over that day", () => {
        // 02:30 does not exist in Madrid on 2026-03-29; the next one is Monday's.
        expect(next("30 2 * * *", "2026-03-28T12:00:00Z", "Europe/Madrid")).toBe("2026-03-30T00:30:00.000Z");
    });

    it("fires a repeated time only the first time", () => {
        // Madrid reads 02:30 at 00:30Z and again at 01:30Z on 2026-10-25.
        expect(next("30 2 * * *", "2026-10-24T12:00:00Z", "Europe/Madrid")).toBe("2026-10-25T00:30:00.000Z");
        expect(next("30 2 * * *", "2026-10-25T00:30:00Z", "Europe/Madrid")).toBe("2026-10-26T01:30:00.000Z");
        // New York reads 01:30 at 05:30Z and again at 06:30Z on 2026-11-01.
        expect(next("30 1 * * *", "2026-11-01T05:30:00Z", "America/New_York")).toBe("2026-11-02T06:30:00.000Z");
    });

    it("keeps an hourly schedule running through the repeated hour", () => {
        expect(next("@hourly", "2026-10-25T00:00:00Z", "Europe/Madrid")).toBe("2026-10-25T01:00:00.000Z");
    });

    it("answers null for a date that never comes", () => {
        expect(next("0 0 30 2 *", "2026-01-01T00:00:00Z")).toBeNull();
    });
});

describe("saying it in words", () => {
    it("names the common shapes and shows the rest as written", () => {
        expect(describeCron("@daily")).toBe("Every day at midnight");
        expect(describeCron("*/10 * * * *")).toBe("Every 10 minutes");
        expect(describeCron("30 6 * * *")).toBe("Every day at 06:30");
        expect(describeCron("0 9 1 * MON")).toBe("0 9 1 * MON");
    });
});
