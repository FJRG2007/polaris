import * as engine from "../src/tasks.js";
import { describe, expect, it } from "vitest";

/*
 * An all-day due date is stored as the reader's local midnight, and the server
 * that reads it back runs in UTC. Every instant here is written out in UTC, so
 * the answers do not depend on the zone of the machine running the test - they
 * only depend on the zone passed in, which is the point.
 */

const MADRID = "Europe/Madrid";
const NEW_YORK = "America/New_York";

/** "26 Oct" picked in Madrid (UTC+1 after the clocks went back on the 25th). */
const dueMadrid = { dueDate: new Date("2026-10-25T23:00:00Z"), statusType: "open" as const, timed: false };
/** "26 Oct" picked in New York (UTC-4 until 1 Nov). */
const dueNewYork = { dueDate: new Date("2026-10-26T04:00:00Z"), statusType: "open" as const, timed: false };

describe("an all-day task due today, read on a UTC server", () => {
    it("is not overdue at 10:00 in Madrid", () => {
        const now = new Date("2026-10-26T09:00:00Z");
        expect(engine.isOverdue(dueMadrid, now, MADRID)).toBe(false);
        expect(engine.dueBucket(dueMadrid, now, 1, MADRID)).toBe("today");
    });

    it("is still not overdue at 23:30 in Madrid", () => {
        const now = new Date("2026-10-26T22:30:00Z");
        expect(engine.isOverdue(dueMadrid, now, MADRID)).toBe(false);
        expect(engine.dueBucket(dueMadrid, now, 1, MADRID)).toBe("today");
    });

    it("is overdue at 00:30 in Madrid the next day", () => {
        const now = new Date("2026-10-26T23:30:00Z");
        expect(engine.isOverdue(dueMadrid, now, MADRID)).toBe(true);
    });

    it("is not overdue at 10:00 or 23:30 in New York, and is at 00:30 the next day", () => {
        expect(engine.isOverdue(dueNewYork, new Date("2026-10-26T14:00:00Z"), NEW_YORK)).toBe(false);
        expect(engine.dueBucket(dueNewYork, new Date("2026-10-26T14:00:00Z"), 1, NEW_YORK)).toBe("today");
        expect(engine.isOverdue(dueNewYork, new Date("2026-10-27T03:30:00Z"), NEW_YORK)).toBe(false);
        expect(engine.isOverdue(dueNewYork, new Date("2026-10-27T04:30:00Z"), NEW_YORK)).toBe(true);
    });

    it("reads tomorrow as tomorrow in the reader's zone", () => {
        const now = new Date("2026-10-25T09:00:00Z");
        expect(engine.dueBucket(dueMadrid, now, 1, MADRID)).toBe("tomorrow");
        expect(engine.dueBucket(dueNewYork, new Date("2026-10-25T14:00:00Z"), 1, NEW_YORK)).toBe("tomorrow");
    });

    it("a finished task is never overdue", () => {
        const done = { ...dueMadrid, statusType: "done" as const };
        expect(engine.isOverdue(done, new Date("2026-10-28T09:00:00Z"), MADRID)).toBe(false);
    });

    it("a timed task is due at its own instant, whatever the zone", () => {
        const timed = { dueDate: new Date("2026-10-26T09:00:00Z"), statusType: "open" as const, timed: true };
        expect(engine.isOverdue(timed, new Date("2026-10-26T09:30:00Z"), MADRID)).toBe(true);
        expect(engine.isOverdue(timed, new Date("2026-10-26T08:30:00Z"), MADRID)).toBe(false);
    });

    it("filters 'due today' and 'overdue' against the reader's day", () => {
        const facts = { ...dueMadrid } as unknown as engine.TaskFacts;
        const now = new Date("2026-10-26T09:00:00Z");
        const today = { match: "all", conditions: [{ field: "dueDate", operator: "is", values: ["today"] }] };
        const overdue = { match: "all", conditions: [{ field: "dueDate", operator: "is", values: ["overdue"] }] };
        expect(engine.matchesFilter(facts, today as never, now, 1, MADRID)).toBe(true);
        expect(engine.matchesFilter(facts, overdue as never, now, 1, MADRID)).toBe(false);
    });
});

describe("zoned day boundaries", () => {
    it("start and end of a day in Madrid, across the clocks going back", () => {
        // 25 Oct 2026 is 25 hours long in Madrid: 22:00Z on the 24th to 23:00Z.
        const at = new Date("2026-10-25T12:00:00Z");
        expect(engine.startOfDay(at, MADRID).toISOString()).toBe("2026-10-24T22:00:00.000Z");
        expect(engine.endOfDay(at, MADRID).toISOString()).toBe("2026-10-25T22:59:59.999Z");
        expect(engine.addDays(engine.startOfDay(at, MADRID), 1, MADRID).toISOString()).toBe(
            "2026-10-25T23:00:00.000Z"
        );
    });

    it("weeks and months start on the reader's calendar", () => {
        // 00:30 Monday 2 Nov in Madrid is still Sunday 1 Nov in UTC.
        const now = new Date("2026-11-01T23:30:00Z");
        expect(engine.startOfWeek(now, 1, MADRID).toISOString()).toBe("2026-11-01T23:00:00.000Z");
        expect(engine.startOfMonth(now, MADRID).toISOString()).toBe("2026-10-31T23:00:00.000Z");
        expect(engine.daysBetween(new Date("2026-10-25T23:00:00Z"), now, MADRID)).toBe(7);
        const month = engine.resolveRelativeDate("thisMonth", now, 1, MADRID);
        expect(month.to.toISOString()).toBe("2026-11-30T22:59:59.999Z");
    });

    it("leaves the device-local behaviour alone when no zone is given", () => {
        const at = new Date(2026, 9, 26, 15, 0, 0);
        expect(engine.startOfDay(at).getTime()).toBe(new Date(2026, 9, 26).getTime());
        expect(engine.startOfDay(at, "auto").getTime()).toBe(new Date(2026, 9, 26).getTime());
        expect(engine.endOfDay(at).getTime()).toBe(new Date(2026, 9, 26, 23, 59, 59, 999).getTime());
    });
});

describe("a recurring all-day task, rescheduled on a UTC server", () => {
    it("every Monday from a Monday in Madrid is the next Monday in Madrid", () => {
        const next = engine.nextOccurrence(
            { mode: "weekly", interval: 1, weekdays: [1], basis: "schedule" } as never,
            dueMadrid.dueDate,
            0,
            MADRID
        );
        expect(next?.toISOString()).toBe("2026-11-01T23:00:00.000Z");
    });

    it("monthly on its day keeps the day the reader picked", () => {
        const next = engine.nextOccurrence(
            { mode: "monthly", interval: 1, weekdays: [], basis: "schedule" } as never,
            dueMadrid.dueDate,
            0,
            MADRID
        );
        expect(next?.toISOString()).toBe("2026-11-25T23:00:00.000Z");
    });
});
