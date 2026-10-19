/**
 * The recency groups of Polar's conversation list, counted in calendar days.
 */

import { describe, expect, it } from "vitest";
import { groupThreads, threadGroup } from "@/lib/polar/shared";

const NOW = new Date(2026, 9, 19, 9, 30);
const at = (days: number, hour = 12) => new Date(2026, 9, 19 - days, hour).toISOString();

describe("threadGroup", () => {
    it("reads calendar days, not hours", () => {
        expect(threadGroup(at(0, 0), NOW)).toBe("today");
        expect(threadGroup(at(1, 23), NOW)).toBe("yesterday");
        expect(threadGroup(at(2), NOW)).toBe("week");
        expect(threadGroup(at(7), NOW)).toBe("week");
        expect(threadGroup(at(8), NOW)).toBe("month");
        expect(threadGroup(at(30), NOW)).toBe("month");
        expect(threadGroup(at(31), NOW)).toBe("older");
    });

    it("puts a future date in today and an unreadable one in older", () => {
        expect(threadGroup(at(-2), NOW)).toBe("today");
        expect(threadGroup("not a date", NOW)).toBe("older");
    });
});

describe("groupThreads", () => {
    it("keeps the rows' order inside each group and drops empty groups", () => {
        const rows = [
            { id: "a", updatedAt: at(0) },
            { id: "b", updatedAt: at(40) },
            { id: "c", updatedAt: at(0, 1) }
        ];
        expect(groupThreads(rows, NOW)).toEqual([
            { group: "today", rows: [rows[0], rows[2]] },
            { group: "older", rows: [rows[1]] }
        ]);
    });
});
